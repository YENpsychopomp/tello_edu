// 跟隨模式：偵測（~12 Hz）→ 多人追蹤 → 選定目標 → 手勢 → 控制器 → 和手把輸入合成 rc（30 Hz，由 main.js 呼叫）。
//
// 手把／鍵盤介入：只要搖桿離開死區，rc 完全交給手動；放開 1 秒後自動恢復跟隨，
// 並把「當下的高度與距離」當成新的設定值（介入就是調整構圖的方法）。
import { applyGesture, clampSetpoint, followRc, slew } from './control.js';
import { GESTURES, GestureLatch, classifyPose } from './gestures.js';
import { inBox } from './geometry.js';
import { PoseDetector } from './pose.js';
import { Tracker } from './tracker.js';

export const RESUME_MS = 1000;       // 搖桿放開多久後恢復跟隨
export const STALE_MS = 450;         // 目標多久沒更新就視為遺失 → 懸停
const DETECT_MS = 80;                // 偵測間隔上限（約 12 Hz）

export const PHASE = {
  off: ['none', '關閉'],
  loading: ['warn', '載入偵測模型中…'],
  error: ['danger', '偵測模型無法載入'],
  'no-video': ['warn', '等待影像（按 Y 開啟）'],
  select: ['warn', '請選擇要跟隨的人'],
  ready: ['ok', '已鎖定，起飛後開始跟隨'],
  follow: ['ok', '跟隨中'],
  paused: ['warn', '暫停（懸停中）'],
  manual: ['warn', '手動介入中'],
  resume: ['warn', '即將恢復跟隨…'],
  lost: ['danger', '目標遺失 → 懸停中'],
};

const SKELETON = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

export class FollowMode {
  /**
   * @param o.canvas   影像 canvas（偵測來源）
   * @param o.overlay  疊在影像上的 canvas（畫框，不會被錄影錄進去）
   * @param o.getTel   () => 遙測
   * @param o.isPilot  () => boolean
   * @param o.hasVideo () => boolean
   * @param o.notify   (level, title, text) => void
   * @param o.buzz     (pattern) => void
   * @param o.onChange () => void   狀態有變時通知 UI
   */
  constructor(o) {
    Object.assign(this, o);
    this.ctx = o.overlay.getContext('2d');
    this.detector = new PoseDetector();
    this.tracker = new Tracker();
    this.latch = new GestureLatch();
    this.enabled = false;
    this.paused = false;
    this.phase = 'off';
    this.sp = clampSetpoint({});
    this.spInit = false;
    this.rc = [0, 0, 0, 0];
    this.why = [];
    this.people = [];
    this.lastDetect = 0;
    this.lastFrames = -1;
    this.manualAt = -Infinity;
    this.wasManual = false;
    this.everSelected = false;
    this.lastGesture = null;     // {g, at}
    this.fps = 0;
    this._fpsN = 0; this._fpsT = 0;
    this.fake = null;            // E2E：() => 偵測結果（取代真正的模型）
    this.error = '';
    this._loop = this._loop.bind(this);
    o.overlay.addEventListener('click', (e) => this._click(e));
  }

  // ------------------------------------------------------------------ 開關
  async toggle() { return this.enabled ? this.disable('已關閉跟隨模式') : this.enable(); }

  async enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.paused = false;
    this.everSelected = false;
    this.spInit = false;
    this.tracker.reset();
    this.latch.reset();
    this.overlay.hidden = false;
    this.overlay.classList.add('pick');
    this.error = '';
    this._set();
    requestAnimationFrame(this._loop);
    if (this.fake) return;
    try {
      await this.detector.load();
      this.notify('ok', '跟隨模式', `偵測模型已載入（${this.detector.delegate === 'GPU' ? 'GPU 加速' : 'CPU'}）`);
    } catch (e) {
      this.error = e && e.message ? e.message : String(e);
      this.notify('danger', '跟隨模式無法啟動', `偵測模型載入失敗：${this.error}`);
      this.enabled = false;
      this.overlay.hidden = true;
    }
    this._set();
  }

  disable(reason) {
    if (!this.enabled) return;
    this.enabled = false;
    this.paused = false;
    this.tracker.reset();
    this.people = [];
    this.rc = [0, 0, 0, 0];
    this.overlay.hidden = true;
    this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (reason) this.notify('info', '跟隨模式', reason);
    this._set();
  }

  cycle(dir) {
    if (!this.enabled) return;
    const id = this.tracker.cycle(dir, this.lastDetect);     // 以最近一次偵測的時間為準（visible 只算那一幀看到的人）
    if (id !== null) this._selected(id);
    else this.notify('warn', '畫面中沒有人', '偵測到人之後才能選擇');
  }

  select(id) {
    if (this.tracker.select(id) !== null) this._selected(id);
  }

  _selected(id) {
    this.everSelected = true;
    this.paused = false;
    this.latch.reset();
    this.spInit = false;                // 用目前的距離與高度當設定值
    this.buzz('tap');
    this.notify('ok', `跟隨目標：#${id}`, this.people.length > 1 ? '十字鍵 ←／→ 或點畫面上的人可以換目標' : '');
    this._set();
  }

  _click(e) {
    if (!this.enabled) return;
    const r = this.overlay.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    // 框重疊時選中心離點擊位置最近的人
    const d = (t) => Math.hypot(t.cx - x, (t.cy - y) * 0.5);
    const hit = this.people.filter((t) => inBox(t.box, x, y)).sort((a, b) => d(a) - d(b))[0];
    if (hit) this.select(hit.id);
  }

  // ------------------------------------------------------------------ 偵測迴圈
  _loop(now) {
    if (!this.enabled) return;
    requestAnimationFrame(this._loop);
    this._lastNow = now;
    const src = this.canvas;
    const frames = this.frameCount ? this.frameCount() : 0;
    const due = now - this.lastDetect >= DETECT_MS;
    if (due && (this.fake || (this.detector.ready && this.hasVideo() && frames !== this.lastFrames))) {
      this.lastDetect = now;
      this.lastFrames = frames;
      let dets = [];
      try {
        dets = this.fake ? this.fake(now) : this.detector.detect(src);
      } catch (e) {
        dets = [];
      }
      this._onDetections(dets || [], now);
      this._fpsN++;
      if (now - this._fpsT >= 1000) { this.fps = Math.round((this._fpsN * 1000) / (now - this._fpsT)); this._fpsN = 0; this._fpsT = now; }
    }
    this._draw(now);
  }

  _onDetections(dets, now) {
    const hadTarget = this.tracker.targetId;
    this.people = this.tracker.update(dets, now);
    const tgt = this.tracker.target;

    if (hadTarget !== null && this.tracker.targetId === null) {
      this.notify('danger', '目標遺失超過 3 秒', '保持懸停。用十字鍵 ←／→ 或點畫面重新選人，或用搖桿手動飛');
      this.buzz('warn');
    }
    if (tgt && tgt.reacquired === now) this.notify('ok', `重新找到目標 #${tgt.id}`, '');

    // 一開始畫面只有一個人 → 自動選他；之後遺失了就一定要手動選，避免跟錯人
    if (!this.everSelected && this.tracker.targetId === null && this.people.length === 1 && this.people[0].hits >= 4) {
      this.tracker.select(this.people[0].id);
      this._selected(this.people[0].id);
    }

    // 手勢：只看目標本人，而且只有在跟隨／暫停中才接受（手動介入時不理）
    if (tgt && tgt.seen === now && (this.phase === 'follow' || this.phase === 'paused')) {
      const g = this.latch.feed(classifyPose(tgt.lms, this.canvas.width / this.canvas.height || 4 / 3), now);
      if (g) this._gesture(g, now);
    } else this.latch.reset();
    this._set();
  }

  _gesture(g, now) {
    this.lastGesture = { g, at: now };
    if (g === 'pause') {
      this.paused = !this.paused;
      this.notify(this.paused ? 'warn' : 'ok', this.paused ? '手勢：暫停跟隨' : '手勢：恢復跟隨', this.paused ? '原地懸停，再做一次 T 字恢復' : '');
    } else {
      this.sp = applyGesture(this.sp, g);
      this.notify('ok', `手勢：${GESTURES[g].label}`,
        g === 'up' || g === 'down' ? `設定高度 ${this.sp.height} cm` : `設定距離 ${this.sp.dist.toFixed(1)} m`);
    }
    this.buzz('tap');
  }

  // ------------------------------------------------------------------ 控制（main.js 每 33 ms 呼叫）
  /**
   * @param manualRc     手把／鍵盤算出的 rc
   * @param manualActive 搖桿是否離開死區（或鍵盤有按住方向鍵）
   * @returns 要送出的 rc
   */
  mix(manualRc, manualActive, now = performance.now()) {
    const tel = this.getTel() || {};
    const flying = !!tel.flying;
    if (!this.enabled || !this.isPilot() || !flying) {
      this.rc = [0, 0, 0, 0];
      this.wasManual = false;
      this._set(flying);
      return manualRc;
    }
    if (manualActive) {
      this.manualAt = now;
      this.wasManual = true;
      this.rc = [0, 0, 0, 0];
      this._set(flying);
      return manualRc;
    }
    if (now - this.manualAt < RESUME_MS) { this.rc = [0, 0, 0, 0]; this._set(flying); return manualRc; }

    const tgt = this.tracker.target;
    const fresh = tgt && now - tgt.seen <= STALE_MS;
    if (this.wasManual || !this.spInit) {
      // 介入結束（或剛選定目標）：當下的構圖就是新的設定值
      if (fresh) {
        this.sp = clampSetpoint({
          dist: Number.isFinite(tgt.dist) ? tgt.dist : this.sp.dist,
          height: Number.isFinite(tel.h) ? tel.h : this.sp.height,
        });
        this.spInit = true;
        if (this.wasManual) this.notify('ok', '恢復跟隨', `距離 ${this.sp.dist.toFixed(1)} m · 高度 ${this.sp.height} cm`);
        this.wasManual = false;     // 看得到目標才算完成交接；看不到就繼續懸停等它出現
      }
    }

    let next = [0, 0, 0, 0];
    this.why = [];
    if (fresh && !this.paused && this.spInit && this.hasVideoOrFake()) {
      const r = followRc({ cx: tgt.cx, dist: tgt.dist, distMin: tgt.distMin }, this.sp, Number.isFinite(tel.h) ? tel.h : null);
      next = r.raw;
      this.why = r.why;
    }
    this.rc = slew(this.rc, next);
    this._set(flying);
    return this.rc;
  }

  hasVideoOrFake() { return !!this.fake || this.hasVideo(); }

  // ------------------------------------------------------------------ 狀態
  _set(flying) {
    const f = flying === undefined ? !!(this.getTel() || {}).flying : flying;
    const now = performance.now();
    const tgt = this.tracker.target;
    let p;
    if (!this.enabled) p = this.error ? 'error' : 'off';
    else if (!this.fake && !this.detector.ready) p = 'loading';
    else if (!this.hasVideoOrFake()) p = 'no-video';
    else if (!tgt) p = 'select';
    else if (!f) p = 'ready';
    else if (now - this.manualAt < 120) p = 'manual';
    else if (now - this.manualAt < RESUME_MS) p = 'resume';
    else if (now - tgt.seen > STALE_MS) p = 'lost';
    else if (this.paused) p = 'paused';
    else p = 'follow';
    if (p !== this.phase) {
      const old = this.phase;
      this.phase = p;
      if (p === 'lost' && old === 'follow') { this.notify('warn', '看不到目標', '原地懸停，3 秒內回到畫面會自動找回'); this.buzz('warn'); }
      if (this.onChange) this.onChange();
    }
  }

  status() {
    const tgt = this.tracker.target;
    return {
      enabled: this.enabled, phase: this.phase, level: PHASE[this.phase][0], text: PHASE[this.phase][1],
      target: tgt ? tgt.id : null, dist: tgt && Number.isFinite(tgt.dist) ? tgt.dist : null,
      sp: this.sp, spInit: this.spInit, people: this.people.map((t) => t.id), fps: this.fps,
      ms: this.detector.ms, delegate: this.detector.delegate, rc: this.rc, why: this.why,
      paused: this.paused, gesture: this.lastGesture,
    };
  }

  // ------------------------------------------------------------------ 畫面
  _draw(now) {
    const c = this.overlay, g = this.ctx;
    const W = this.canvas.width || 960, H = this.canvas.height || 720;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(c);
    const col = { ok: css.getPropertyValue('--ok') || '#3DD68C', other: 'rgba(230,237,243,.85)', warn: css.getPropertyValue('--warn') || '#F5B941', danger: css.getPropertyValue('--danger') || '#FF6B6B' };
    const tid = this.tracker.targetId;
    const lw = Math.max(2, W / 320);
    g.font = `700 ${Math.round(H / 24)}px system-ui, sans-serif`;
    g.textBaseline = 'bottom';

    // 目標最後畫，標籤才不會被別人蓋住
    const order = [...this.tracker.tracks].sort((a, b) => (a.id === tid) - (b.id === tid));
    for (const t of order) {
      const isT = t.id === tid;
      const stale = now - t.seen > STALE_MS;
      if (!isT && stale) continue;
      const b = t.box;
      const color = isT ? (stale ? col.danger : this.phase === 'follow' ? col.ok : col.warn) : col.other;
      g.strokeStyle = color;
      g.lineWidth = isT ? lw * 2 : lw;
      g.setLineDash(isT && !stale ? [] : [lw * 4, lw * 3]);
      g.strokeRect(b.x0 * W, b.y0 * H, (b.x1 - b.x0) * W, (b.y1 - b.y0) * H);
      g.setLineDash([]);
      if (isT && !stale && t.lms) {
        g.lineWidth = lw;
        g.globalAlpha = 0.7;
        g.beginPath();
        for (const [a, z] of SKELETON) {
          const A = t.lms[a], Z = t.lms[z];
          if (!A || !Z || (A.visibility ?? 1) < 0.5 || (Z.visibility ?? 1) < 0.5) continue;
          g.moveTo(A.x * W, A.y * H); g.lineTo(Z.x * W, Z.y * H);
        }
        g.stroke();
        g.globalAlpha = 1;
      }
      const label = isT ? `#${t.id} ${stale ? '遺失' : '跟隨'}${Number.isFinite(t.dist) ? ` · 約 ${t.dist.toFixed(1)} m` : ''}` : `#${t.id}`;
      const tw = g.measureText(label).width + 14, th = Math.round(H / 20);
      const lx = Math.min(W - tw, Math.max(0, b.x0 * W)), ly = Math.max(th, b.y0 * H);
      g.fillStyle = isT ? color : 'rgba(11,15,20,.78)';
      g.fillRect(lx, ly - th, tw, th);
      g.fillStyle = isT ? '#0B0F14' : '#E6EDF3';
      g.fillText(label, lx + 7, ly - th * 0.12);
    }

    // 中央十字（跟隨的瞄準點）
    if (tid !== null) {
      g.strokeStyle = 'rgba(230,237,243,.45)'; g.lineWidth = lw;
      g.beginPath(); g.moveTo(W / 2, H / 2 - H / 30); g.lineTo(W / 2, H / 2 + H / 30);
      g.moveTo(W / 2 - H / 30, H / 2); g.lineTo(W / 2 + H / 30, H / 2); g.stroke();
    }

    // 手勢累積進度
    const pend = this.latch.pending(now);
    const recent = this.lastGesture && now - this.lastGesture.at < 1500 ? this.lastGesture : null;
    if (pend || recent) {
      const g0 = pend ? pend.g : recent.g;
      const txt = pend ? `手勢：${GESTURES[g0].label}…` : `✓ ${GESTURES[g0].label}`;
      const tw = g.measureText(txt).width + 28, th = Math.round(H / 15);
      const x = (W - tw) / 2, y = H - th - H / 9;
      g.fillStyle = 'rgba(11,15,20,.82)'; g.fillRect(x, y, tw, th);
      g.fillStyle = col.ok;
      if (pend) g.fillRect(x, y + th - lw * 2, tw * pend.p, lw * 2);
      g.fillStyle = '#E6EDF3'; g.textBaseline = 'middle';
      g.fillText(txt, x + 14, y + th / 2);
      g.textBaseline = 'bottom';
    }
  }
}
