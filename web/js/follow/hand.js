// MediaPipe HandLandmarker（本機檔案，不連網路）：只用來判斷「手掌是否張開」與手的位置／距離（停到手上）。
// 和姿勢模型共用同一份 vision_bundle 與 wasm；模型 hand_landmarker.task 約 7.8 MB，開跟隨模式時才載入。
const BASE = '/static/vendor/mediapipe';

export class HandDetector {
  constructor() {
    this.lm = null;
    this.delegate = null;
    this.loading = null;
    this.lastTs = 0;
    this.ms = 0;
  }

  get ready() { return !!this.lm; }

  load() {
    if (!this.loading) this.loading = this._load().catch((e) => { this.loading = null; throw e; });
    return this.loading;
  }

  async _load() {
    const { HandLandmarker } = await import(`${BASE}/vision_bundle.mjs`);
    const fileset = {
      wasmLoaderPath: `${BASE}/wasm/vision_wasm_internal.js`,
      wasmBinaryPath: `${BASE}/wasm/vision_wasm_internal.wasm`,
    };
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: `${BASE}/models/hand_landmarker.task`, delegate },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    let err;
    for (const d of ['GPU', 'CPU']) {
      try {
        this.lm = await HandLandmarker.createFromOptions(fileset, opts(d));
        this.delegate = d;
        return d;
      } catch (e) { err = e; }
    }
    throw err;
  }

  /** @returns [{lms: 21 點影像座標, world: 21 點公尺座標, handedness}] */
  detect(source) {
    if (!this.lm) return [];
    const w = source.width || source.videoWidth, h = source.height || source.videoHeight;
    if (!w || !h) return [];
    const ts = Math.max(this.lastTs + 1, performance.now());
    this.lastTs = ts;
    const t0 = performance.now();
    const res = this.lm.detectForVideo(source, ts);
    this.ms = performance.now() - t0;
    const out = [];
    (res.landmarks || []).forEach((lms, i) => {
      out.push({
        lms, world: (res.worldLandmarks || [])[i] || null,
        handedness: ((res.handedness || res.handednesses || [])[i] || [])[0]?.categoryName || null,
      });
    });
    return out.filter((h) => h.world);
  }
}
