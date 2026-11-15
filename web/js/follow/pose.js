// MediaPipe PoseLandmarker（本機檔案，不連網路）。第一次開跟隨模式時才載入（約 19 MB），不影響一般飛行。
import { describePerson } from './geometry.js';

const BASE = '/static/vendor/mediapipe';
export const MAX_PEOPLE = 5;

export class PoseDetector {
  constructor() {
    this.lm = null;
    this.delegate = null;
    this.loading = null;
    this.lastTs = 0;
    this.ms = 0;               // 最近一次推論耗時
    this._feat = null;
    // 手機／弱 CPU：把 960×720 先縮到 480 寬再推論（關鍵點是正規化座標，不用換算）。桌機 GPU 不縮。
    this.maxWidth = PoseDetector.defaultMaxWidth();
    this._scaled = null;
    this.scaledSize = null;
  }

  static defaultMaxWidth() {
    try {
      const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      const weak = (navigator.hardwareConcurrency || 8) <= 4;
      return coarse || weak ? 480 : 0;
    } catch (e) { return 0; }
  }

  /** 推論用的來源：需要縮圖時回傳縮過的 canvas */
  _source(source, w, h) {
    if (!this.maxWidth || w <= this.maxWidth) { this.scaledSize = null; return source; }
    const sw = this.maxWidth, sh = Math.round((h * sw) / w);
    if (!this._scaled) { this._scaled = document.createElement('canvas'); }
    if (this._scaled.width !== sw || this._scaled.height !== sh) { this._scaled.width = sw; this._scaled.height = sh; }
    const g = this._scaled.getContext('2d', { alpha: false });
    g.drawImage(source, 0, 0, sw, sh);
    this.scaledSize = [sw, sh];
    return this._scaled;
  }

  get ready() { return !!this.lm; }

  load() {
    if (!this.loading) this.loading = this._load().catch((e) => { this.loading = null; throw e; });
    return this.loading;
  }

  async _load() {
    const { PoseLandmarker } = await import(`${BASE}/vision_bundle.mjs`);
    const fileset = {
      wasmLoaderPath: `${BASE}/wasm/vision_wasm_internal.js`,
      wasmBinaryPath: `${BASE}/wasm/vision_wasm_internal.wasm`,
    };
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: `${BASE}/models/pose_landmarker_lite.task`, delegate },
      runningMode: 'VIDEO', numPoses: MAX_PEOPLE,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    let err;
    for (const d of ['GPU', 'CPU']) {
      try {
        this.lm = await PoseLandmarker.createFromOptions(fileset, opts(d));
        this.delegate = d;
        return d;
      } catch (e) { err = e; }
    }
    throw err;
  }

  /** @returns 人物陣列（describePerson 的結果＋衣服顏色特徵） */
  detect(source) {
    if (!this.lm) return [];
    const w0 = source.width || source.videoWidth, h0 = source.height || source.videoHeight;
    if (!w0 || !h0) return [];
    const src = this._source(source, w0, h0);
    const w = src.width, h = src.height;
    const ts = Math.max(this.lastTs + 1, performance.now());   // VIDEO 模式要求時間戳嚴格遞增
    this.lastTs = ts;
    const t0 = performance.now();
    const res = this.lm.detectForVideo(src, ts);
    this.ms = performance.now() - t0;
    const aspect = w / h;
    const out = [];
    for (const lms of res.landmarks || []) {
      const p = describePerson(lms, aspect);
      if (!p) continue;
      p.feat = this._colorFeature(src, p, w, h);
      out.push(p);
    }
    return out;
  }

  // 軀幹區域的色相／飽和度直方圖（8×3 bins），讓兩個人交錯走過時不容易認錯人
  _colorFeature(source, p, w, h) {
    try {
      const L = p.lms, sx = [L[11].x, L[12].x], sy = Math.min(L[11].y, L[12].y);
      const hy = p.torso ? Math.max(L[23].y, L[24].y) : sy + (p.shoulder || 0.1) * 1.2;
      const x0 = Math.min(...sx), x1 = Math.max(...sx);
      const rx0 = Math.max(0, x0 + (x1 - x0) * 0.15), rx1 = Math.min(1, x1 - (x1 - x0) * 0.15);
      const ry0 = Math.max(0, sy + (hy - sy) * 0.1), ry1 = Math.min(1, hy - (hy - sy) * 0.1);
      if (rx1 - rx0 < 0.01 || ry1 - ry0 < 0.01) return null;
      if (!this._feat) {
        const c = document.createElement('canvas');
        c.width = 24; c.height = 24;
        this._feat = c.getContext('2d', { willReadFrequently: true });
      }
      const g = this._feat;
      g.drawImage(source, rx0 * w, ry0 * h, (rx1 - rx0) * w, (ry1 - ry0) * h, 0, 0, 24, 24);
      const px = g.getImageData(0, 0, 24, 24).data;
      const hist = new Array(24).fill(0);
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), d = mx - mn;
        const s = mx ? d / mx : 0;
        let hue = 0;
        if (d) hue = mx === r ? ((gg - b) / d + 6) % 6 : mx === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
        // 低飽和（黑白灰）另外用亮度分 bin，否則黑衣服跟白衣服會被當成一樣
        const bin = s < 0.2 ? 21 + Math.min(2, Math.floor(mx * 3)) : Math.min(6, Math.floor(hue)) * 3 + Math.min(2, Math.floor(s * 3));
        hist[Math.min(23, bin)]++;
      }
      const n = px.length / 4;
      return hist.map((v) => v / n);
    } catch (e) {
      return null;     // 例如畫布被污染、尺寸為 0：沒有顏色特徵也能追蹤，只是比較容易認錯
    }
  }
}
