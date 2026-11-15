// 跟隨模式：偵測（~12 Hz）→ 多人追蹤 → 選定目標 → 手勢 → 控制器 → 和手把輸入合成 rc（30 Hz，由 main.js 呼叫）。
//
// 手把／鍵盤介入：只要搖桿離開死區，rc 完全交給手動；放開 1 秒後自動恢復跟隨，
// 並把「當下的高度與距離」當成新的設定值（介入就是調整構圖的方法）。
import { applyGesture, armWindow, clampSetpoint, followRc, slew } from './control.js';
import { TargetEstimator } from './estimator.js';
import { Searcher } from './search.js';
import { GESTURES, GestureLatch, classifyPose } from './gestures.js';
import { LM, inBox } from './geometry.js';
import { HandDetector } from './hand.js';
import { PALM, PalmLander, armForward, detectPalm, downToBody, handInfo, matchHand, pickDownHand } from './palm.js';
import { PoseDetector } from './pose.js';
import { Tracker } from './tracker.js';

export const RESUME_MS = 1000;       // 搖桿放開多久後恢復跟隨
export const STALE_MS = 450;         // 量測多久沒更新就算「沒看到」（估計器還會再預測 EST.predictMs）
export const LOST_MS = 1000;         // 看不到目標多久開始自動搜尋
export const VIDEO_STALL_MS = 700;   // 影像多久沒有新畫面就算中斷 → 懸停、不算目標遺失
export const STALL_GIVEUP_MS = 8000; // 影像中斷太久 → 通知（持續懸停，交給人）
const DETECT_MS = 80;                // 偵測間隔下限（約 12 Hz）；推論變慢時自動拉長，不讓偵測排隊
const QUALITY_MIN = 0.55;            // 關鍵點平均可見度低於這個值的偵測當成花掉的畫面丟掉
const DOWN_IGNORE_MS = 500;          // 剛切到下視鏡頭時，前鏡頭的舊畫面還在路上 → 先不偵測

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
  search: ['warn', '目標遺失 → 原地旋轉搜尋中'],
  'video-stall': ['danger', '影像中斷 → 懸停中'],
  'palm-approach': ['warn', '停到手上：飛向手掌…'],
  'palm-switch': ['warn', '停到手上：切換到下視鏡頭…'],
  'palm-climb': ['warn', '停到手上：升到手掌上方的高度'],
  'palm-seek': ['warn', '停到手上：往前移到手掌上方…'],
  'palm-align': ['warn', '停到手上：用下視鏡頭對準手掌'],
  'palm-settle': ['warn', '停到手上：手掌在正下方，準備降落'],
  'palm-land': ['ok', '停到手上：降落中'],
  downcam: ['warn', '下視鏡頭（測試）：跟隨暫停，懸停中'],
};
const PALM_PHASE = { approach: 'palm-approach', switch: 'palm-switch', climb: 'palm-climb', seek: 'palm-seek',
  align: 'palm-align', settle: 'palm-settle', landing: 'palm-land' };

const SKELETON = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

/** 偵測品質：鼻子、肩、髖的平均可見度（沒有 visibility 欄位就當 1） */
export function quality(d) {
  if (!d || !Array.isArray(d.lms)) return 1;
  let s = 0, n = 0;
  for (const i of [0, 11, 12, 23, 24]) {
    const p = d.lms[i];
    if (!p) continue;
    s += p.visibility === undefined ? 1 : p.visibility;
    n++;
  }
  return n ? s / n : 1;
}

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
   * @param o.command  (cmd) => Promise<{kind}>  送 SDK 指令（land、downvision）
   * @param o.downOrient () => {edge, mirror}   下視鏡頭畫面方向（設定）
   */
  constructor(o) {
    Object.assign(this, o);
    this.ctx = o.overlay.getContext('2d');
    this.detector = new PoseDetector();
    this.hands = new HandDetector();
    this.palm = new PalmLander();
    this.palmSide = null;        // 'l' | 'r'：哪一隻手要停
    this.palmHand = null;        // {x, y, dist, open, seen}
    this.palmSavedSp = null;     // 開始前的設定值（取消時恢復，無人機會退回原本的距離）
    this.fakeHands = null;       // E2E：(now, cam) => 手部偵測結果
    this.cam = 'front';          // 目前的影像來源：'front' | 'down'
    this.camWant = 'front';
    this.camBusy = false;
    this.camAsked = false;
    this.downFrom = 0;           // 這個時間之後的畫面才是下視鏡頭
    this.downSince = 0;
    this.downHand = null;        // 下視鏡頭裡的手 {x, y, right, fwd, seen}
    this.handError = '';
    this.tracker = new Tracker();
    this.est = new TargetEstimator();   // 目標位置／距離的平滑與預測（抗掉幀、花屏）
    this.search = new Searcher();       // 遺失時原地旋轉搜尋
    this.autoSearch = o.autoSearch || (() => true);
    this.lastFrameAt = 0;               // 最近一次有新影像畫面的時間
    this.stalled = false;               // 影像中斷中
    this.stallSince = 0;
    this.stallWarned = false;
    this.detPeriod = DETECT_MS;         // 偵測間隔的移動平均（ms），用來縮放增益
    this.prevDetect = 0;
    this.giveUpAt = -Infinity;          // 上次搜尋放棄的時間（短時間內不再自動搜）
    this.fakeStall = null;              // E2E：() => true 代表影像沒有新畫面
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
    this.est.reset();
    this.search.reset();
    this.stalled = false; this.lastFrameAt = 0; this.stallWarned = false;
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
    if (!this.enabled) return;
    // 手部模型只用在「停到手上」；載入失敗不影響跟隨
    try {
      await this.hands.load();
    } catch (e) {
      this.handError = e && e.message ? e.message : String(e);
      this.notify('warn', '停到手上無法使用', `手部模型載入失敗：${this.handError}`);
    }
  }

  get handsReady() { return !!this.fakeHands || this.hands.ready; }

  disable(reason) {
    if (!this.enabled) return;
    this.enabled = false;
    this.paused = false;
    this.palm.reset();
    this.palmHand = null;
    this.camAsked = false;
    if (this.cam === 'down' || this.camBusy) this._setCam('front');
    this.tracker.reset();
    this.est.reset();
    this.search.reset();
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
    this.est.reset();
    if (this.search.active) this._endSearch(false);
    this.spInit = false;                // 用目前的距離與高度當設定值
    this.buzz('tap');
    this.notify('ok', `跟隨目標：#${id}`, this.people.length > 1 ? '十字鍵 ←／→ 或點畫面上的人可以換目標' : '');
    this._set();
  }

  _click(e) { this.tapAt(e.clientX, e.clientY); }

  /** 點畫面上的人（滑鼠或觸控的視窗座標）→ 選他 */
  tapAt(clientX, clientY) {
    if (!this.enabled) return;
    const r = this.overlay.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = (clientX - r.left) / r.width, y = (clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
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
    // 影像健康：有沒有新畫面？沒有就不偵測（舊畫面會算出舊位置），太久沒有就算中斷 → 懸停、不算目標遺失
    const newFrame = this.fake ? !(this.fakeStall && this.fakeStall()) : (this.hasVideo() && frames !== this.lastFrames);
    if (newFrame) {
      if (this.stalled) {
        const gap = now - this.stallSince;
        this.tracker.shift(gap); this.est.shift(gap);     // 凍結期間不算目標消失
        this.stalled = false; this.stallWarned = false;
        this.notify('ok', '影像恢復', `中斷 ${(gap / 1000).toFixed(1)} 秒`);
      }
      this.lastFrameAt = now;
    } else if (!this.stalled && this.hasVideoOrFake() && this.lastFrameAt && now - this.lastFrameAt > VIDEO_STALL_MS) {
      this.stalled = true;
      this.stallSince = this.lastFrameAt;
    }
    if (this.stalled && !this.stallWarned && now - this.stallSince > STALL_GIVEUP_MS) {
      this.stallWarned = true;
      this.notify('danger', '影像中斷超過 8 秒', '持續懸停。請用搖桿接手，或按 Y 關閉再開啟影像');
      this.buzz('danger');
    }
    // 推論變慢（手機、CPU）時拉長間隔，不讓偵測排隊累積延遲
    const interval = Math.max(DETECT_MS, (this.detector.ms || 0) * 1.3);
    const due = now - this.lastDetect >= interval;
    if (this.cam === 'down' || this.camBusy) {
      // 下視鏡頭：只找手（看不到人，追蹤先凍結）
      if (due && this.cam === 'down' && now >= this.downFrom && (this.fakeHands || (this.hands.ready && this.hasVideo() && frames !== this.lastFrames))) {
        this.lastDetect = now;
        this.lastFrames = frames;
        this._onDown(now);
      }
      this._draw(now);
      return;
    }
    if (due && newFrame && (this.fake || this.detector.ready)) {
      if (this.prevDetect) this.detPeriod = this.detPeriod * 0.8 + Math.min(1000, now - this.prevDetect) * 0.2;
      this.prevDetect = now;
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

  _onDown(now) {
    let hands = [];
    try { hands = this.fakeHands ? this.fakeHands(now, 'down') : this.hands.detect(this.canvas); } catch (e) { hands = []; }
    const aspect = this.canvas.width / this.canvas.height || 4 / 3;
    const p = pickDownHand(hands || [], aspect);
    if (p) this.downHand = { ...p, ...downToBody(p.x, p.y, this.downOrient ? this.downOrient() : {}), seen: now };
    this._set();
  }

  /** 切換影像來源（downvision）。可以連續呼叫：以最後一次想要的為準 */
  async _setCam(want) {
    this.camWant = want;
    if (this.camBusy) return this.cam === want;
    this.camBusy = true;
    let ok = true;
    try {
      while (this.cam !== this.camWant) {
        const target = this.camWant;
        let r = null;
        try { r = this.command ? await this.command(`downvision ${target === 'down' ? 1 : 0}`) : null; } catch (e) { r = null; }
        ok = !!r && r.kind === 'ok';
        const now = performance.now();
        if (target === 'down') {
          if (!ok) { this.camWant = 'front'; break; }
          this.cam = 'down';
          this.downFrom = now + DOWN_IGNORE_MS;
          this.downSince = now;
          this.downHand = null;
        } else {
          // 切回前鏡頭：失敗也當作切回（不能卡在下視）；凍結期間不算目標遺失
          this.cam = 'front';
          this.downHand = null;
          this.tracker.shift(now - this.downSince);
          this.latch.reset();
          if (!ok) this.notify('warn', '切回前鏡頭失敗', '請按 Y 關閉再開啟影像');
        }
      }
    } finally {
      this.camBusy = false;
      this._set();
    }
    return ok && this.cam === want;
  }

  /** 測試用：手動切換下視鏡頭（跟隨暫停、懸停），確認畫面方向設定正確 */
  async toggleDownCam() {
    if (!this.enabled) { this.notify('warn', '下視鏡頭', '請先開啟跟隨模式（需要手部模型）'); return; }
    if (this.palm.active) { this.notify('warn', '下視鏡頭', '停到手上進行中，會自動切換'); return; }
    const want = this.cam === 'down' ? 'front' : 'down';
    const ok = await this._setCam(want);
    if (want === 'down') {
      this.notify(ok ? 'ok' : 'warn', ok ? '下視鏡頭（測試）' : '無法切到下視鏡頭',
        ok ? '把手放到機身下方，看畫面上的「手在機身…」方向對不對；再按一次 C 切回' : '這台 Tello 的韌體可能不支援 downvision');
    } else this.notify('info', '已切回前鏡頭', '');
  }

  _onDetections(dets, now) {
    const hadTarget = this.tracker.targetId;
    // 花掉的畫面：關鍵點可見度很低、或一幀裡冒出一堆「人」→ 當成沒有偵測
    dets = dets.filter((d) => quality(d) >= QUALITY_MIN);
    this.people = this.tracker.update(dets, now);
    const tgt = this.tracker.target;

    if (hadTarget !== null && this.tracker.targetId === null) {
      this.notify('danger', '目標遺失超過 3 秒', '保持懸停。用十字鍵 ←／→ 或點畫面重新選人，或用搖桿手動飛');
      this.buzz('warn');
    }
    if (tgt && tgt.seen === now) {
      if (this.search.active) {
        // 搜尋中認到人：連續兩幀都對得上才算找回（避免轉動時一幀誤認）
        if ((tgt.hitsSince || 0) >= 2) { this._endSearch(true, tgt.id); this.est.reset(); }
      } else if (tgt.reacquired === now) this.notify('ok', `重新找到目標 #${tgt.id}`, '');
      if (!this.search.active) this.est.feed({ cx: tgt.rawCx ?? tgt.cx, cy: tgt.rawCy ?? tgt.cy, dist: tgt.rawDist ?? tgt.dist }, now);
    }

    // 一開始畫面只有一個人 → 自動選他；之後遺失了就一定要手動選，避免跟錯人
    if (!this.everSelected && this.tracker.targetId === null && this.people.length === 1 && this.people[0].hits >= 4) {
      this.tracker.select(this.people[0].id);
      this._selected(this.people[0].id);
    }

    const aspect = this.canvas.width / this.canvas.height || 4 / 3;
    const fresh = tgt && tgt.seen === now && !this.search.active;
    const palmOn = this.palm.active;

    // 手部模型：停到手上進行中（要追蹤手的位置），或目標有一隻手臂向前伸（可能要做「停到手上」）才跑
    let hands = null;
    if (fresh && this.handsReady && (palmOn || armForward(tgt.lms, 'l', aspect) || armForward(tgt.lms, 'r', aspect))) {
      try { hands = this.fakeHands ? this.fakeHands(now) : this.hands.detect(this.canvas); } catch (e) { hands = null; }
    }
    if (palmOn && fresh && hands) {
      const wrist = tgt.lms[this.palmSide === 'l' ? LM.L_WRIST : LM.R_WRIST];
      // 手伸近鏡頭時姿勢模型的手腕會偏，配對範圍放寬；配不到就取最大（最近）的那隻手
      const h = matchHand(wrist, hands, aspect, 0.25) || (hands.length === 1 ? hands[0] : null);
      if (h) this.palmHand = { ...handInfo(h, aspect), seen: now };
    }

    // 手勢：只看目標本人，而且只有在跟隨／暫停中才接受（手動介入時不理）。停到手上進行中只接受 T 字（取消）
    if (fresh && (this.phase === 'follow' || this.phase === 'paused' || palmOn)) {
      let g = classifyPose(tgt.lms, aspect);
      let cand = null;
      if (!g && hands && !palmOn) {
        cand = detectPalm(tgt.lms, hands, aspect);
        if (cand) g = 'palm';
      }
      if (palmOn && g !== 'pause') g = null;
      const fired = this.latch.feed(g, now);
      if (fired === 'palm' && cand) this._startPalm(cand, aspect, now);
      else if (fired) this._gesture(fired, now);
    } else this.latch.reset();
    this._set();
  }

  _startSearch(now, yaw) {
    const side = this.est.exitSide();
    this.search.start(now, side, yaw);
    this.tracker.holdTarget = true;
    this.tracker.searching = true;
    this.notify('warn', '目標遺失 → 自動搜尋', `原地往${side > 0 ? '右' : '左'}旋轉找人（最多 20 秒）；推搖桿可中止`);
    this.buzz('warn');
  }

  /** @param found true＝找回目標；false＝放棄或被中止 */
  _endSearch(found, id, reason) {
    const was = this.search.stage;
    this.search.reset();
    this.tracker.holdTarget = false;
    this.tracker.searching = false;
    if (found) {
      this.notify('ok', `重新找到目標 #${id}`, '恢復跟隨');
      this.buzz('tap');
    } else if (reason === 'giveup') {
      this.giveUpAt = performance.now();
      this.tracker.dropTarget();
      this.notify('danger', '找不到目標', '已停止搜尋，原地懸停。用十字鍵 ←／→ 或點畫面重新選人，或用搖桿手動飛');
      this.buzz('danger');
    } else if (was !== 'idle' && reason) this.notify('info', '已停止搜尋', reason);
  }

  _startPalm(cand, aspect, now) {
    if (!this.handsReady) return;
    this.palmSide = cand.side;
    this.palmHand = { ...handInfo(cand.hand, aspect), seen: now };
    this.palmSavedSp = { ...this.sp };
    this.paused = false;
    this.palm.start(now);
    this.lastGesture = { g: 'palm', at: now };
    this.notify('warn', '手勢：停到手上', '飛向你的手 → 切到下視鏡頭 → 自動移到手掌上方對準後降落。手保持張開、不要動；推搖桿可以隨時取消');
    this.buzz('tap');
  }

  _endPalm(level, title, text) {
    this.palm.reset();
    this.palmHand = null;
    this.camAsked = false;
    if (this.cam === 'down' || this.camBusy) this._setCam('front');
    if (this.palmSavedSp) { this.sp = this.palmSavedSp; this.palmSavedSp = null; }
    this.notify(level, title, text);
    this.buzz(level === 'ok' ? 'land' : 'warn');
  }

  _gesture(g, now) {
    this.lastGesture = { g, at: now };
    if (g === 'pause' && this.palm.active) {
      this._endPalm('warn', '已取消停到手上', '手勢 T 字：恢復跟隨，退回原本的距離');
      return;
    }
    if (g === 'pause') {
      this.paused = !this.paused;
      this.notify(this.paused ? 'warn' : 'ok', this.paused ? '手勢：暫停跟隨' : '手勢：恢復跟隨', this.paused ? '原地懸停，再做一次 T 字恢復' : '');
    } else {
      let sp = applyGesture(this.sp, g);
      let note = '';
      if (g === 'up' || g === 'down') {
        // 高度設定不能超出「手臂看得見」的範圍，否則之後的手勢就看不到了
        const tel = this.getTel() || {};
        const win = armWindow(this.tracker.target, Number.isFinite(tel.h) ? tel.h : null);
        if (win && win.fits && sp.height > win.hi) { sp = { ...sp, height: Math.max(this.sp.height, Math.floor(win.hi)) }; note = '（已到上限：再高會看不到髖部與胸前手勢）'; }
        else if (win && win.fits && sp.height < win.lo) { sp = { ...sp, height: Math.min(this.sp.height, Math.ceil(win.lo)) }; note = '（已到下限：再低舉起的手會出畫面）'; }
        else if (win && !win.fits) note = '（距離太近，舉過頭的手可能會被切掉）';
      }
      this.sp = clampSetpoint(sp);
      this.notify('ok', `手勢：${GESTURES[g].label}`,
        (g === 'up' || g === 'down' ? `設定高度 ${this.sp.height} cm` : `設定距離 ${this.sp.dist.toFixed(1)} m`) + note);
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
    if (this.palm.phase === 'landing' && !flying) {
      this._endPalm('ok', '已停在手上', '螺旋槳已停止');
      this.palmSavedSp = null;
    }
    if (!this.enabled || !this.isPilot() || !flying) {
      if (this.palm.active && this.palm.phase !== 'landing') {
        this.palm.reset();
        this.camAsked = false;
        if (this.cam === 'down') this._setCam('front');
      }
      this.rc = [0, 0, 0, 0];
      this.wasManual = false;
      this._set(flying);
      return manualRc;
    }
    if (manualActive) {
      if (this.palm.active && this.palm.phase !== 'landing') this._endPalm('warn', '已取消停到手上', '手動介入');
      if (this.search.active) this._endSearch(false, null, '手動介入');
      this.manualAt = now;
      this.wasManual = true;
      this.rc = [0, 0, 0, 0];
      this._set(flying);
      return manualRc;
    }
    if (now - this.manualAt < RESUME_MS) { this.rc = [0, 0, 0, 0]; this._set(flying); return manualRc; }

    const tgt = this.tracker.target;
    const fresh = tgt && now - tgt.seen <= STALE_MS;
    const stalled = this.stalled && this.hasVideoOrFake();

    // 影像中斷：懸停（不算目標遺失、不搜尋）。停到手上進行中也一樣先停
    if (stalled && !(this.palm.phase === 'landing')) {
      if (this.search.active) this._endSearch(false, null, '影像中斷');
      this.why = ['video-stall'];
      this.rc = slew(this.rc, [0, 0, 0, 0]);
      this._set(flying);
      return this.rc;
    }

    // 停到手上：由 PalmLander 接手控制
    if (this.palm.active) {
      // 切換鏡頭（只問一次；韌體不支援 → 只用 ToF）
      if (this.palm.phase === 'switch' && !this.camAsked) {
        this.camAsked = true;
        this._setCam('down').then((ok) => {
          if (!ok && this.palm.phase === 'switch') this.notify('warn', '無法切到下視鏡頭', '改用下方 ToF：往前移到手掌上方，偵測到手就降落');
          this.palm.camResult(ok, performance.now());
        });
      }
      const hand = this.palmHand && now - this.palmHand.seen <= STALE_MS ? this.palmHand : null;
      const dh = this.downHand;
      const down = this.cam === 'down' && dh && now - dh.seen <= STALE_MS ? { right: dh.right, fwd: dh.fwd } : null;
      const vg = Number.isFinite(tel.vgx) && Number.isFinite(tel.vgy) ? Math.hypot(tel.vgx, tel.vgy) * 0.1 : null;  // dm/s → m/s
      const r = this.palm.update({
        now, hand, down, flying,
        distMin: fresh && Number.isFinite(tgt.distMin) ? tgt.distMin : null,
        tof: Number.isFinite(tel.tof) ? tel.tof : null,
        h: Number.isFinite(tel.h) ? tel.h : null,
        speed: vg,
      });
      if (r.land) {
        this.notify('ok', this.palm.mode === 'cam' ? '已對準手掌' : '偵測到手掌在正下方', '降落到手上');
        if (this.command) this.command('land');
      }
      if (this.palm.phase === 'abort') this._endPalm('warn', '已取消停到手上', this.palm.reason);
      this.why = [`palm-${this.palm.phase}`];
      this.rc = slew(this.rc, r.rc);
      this._set(flying);
      return this.rc;
    }
    if (this.cam === 'down' || this.camBusy) {       // 下視鏡頭測試中：看不到人 → 懸停
      this.why = ['downcam'];
      this.rc = slew(this.rc, [0, 0, 0, 0]);
      this._set(flying);
      return this.rc;
    }
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

    // 自動搜尋：目標消失超過 LOST_MS（估計器也推不下去了）→ 原地旋轉找；找到／放棄／介入時結束
    const est = tgt && !this.search.active ? this.est.predict(now) : null;
    if (this.search.active) {
      const r = this.search.update(now, Number.isFinite(tel.yaw) ? tel.yaw : null);
      if (r.stage === 'giveup') {
        this._endSearch(false, null, 'giveup');
        this.rc = slew(this.rc, [0, 0, 0, 0]);
      } else {
        this.why = [`search-${r.stage}`];
        this.rc = slew(this.rc, r.rc);
      }
      this._set(flying);
      return this.rc;
    }
    if (tgt && !fresh && !est && !this.paused && this.spInit && this.hasVideoOrFake() && this.autoSearch()
      && now - tgt.seen >= LOST_MS && now - this.giveUpAt > 3000) {
      this._startSearch(now, Number.isFinite(tel.yaw) ? tel.yaw : null);
      this.why = ['search-hold'];
      this.rc = slew(this.rc, [0, 0, 0, 0]);
      this._set(flying);
      return this.rc;
    }

    let next = [0, 0, 0, 0];
    this.why = [];
    if (tgt && est && !this.paused && this.spInit && this.hasVideoOrFake()) {
      // 用估計器的位置／速度（平滑、補延遲、缺幀時預測），其餘幾何資料用最後一次偵測的
      const gain = Math.max(0.45, Math.min(1, (1000 / Math.max(50, this.detPeriod)) / 10));
      const r = followRc({ cx: est.cx, dist: est.dist, distMin: tgt.distMin, lms: tgt.lms, torso: tgt.torso, shoulder: tgt.shoulder },
        this.sp, Number.isFinite(tel.h) ? tel.h : null, { vx: est.vx, gain });
      next = r.raw;
      this.why = r.why;
      if (est.predicted && now - tgt.seen > STALE_MS) this.why.push('predicted');
      this.hTarget = r.hTarget;
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
    else if (this.palm.active && (f || this.palm.phase === 'landing')) p = PALM_PHASE[this.palm.phase];
    else if (this.cam === 'down') p = 'downcam';
    else if (!tgt) p = 'select';
    else if (!f) p = 'ready';
    else if (now - this.manualAt < 120) p = 'manual';
    else if (now - this.manualAt < RESUME_MS) p = 'resume';
    else if (this.stalled && this.hasVideoOrFake()) p = 'video-stall';
    else if (this.search.active) p = 'search';
    else if (now - tgt.seen > STALE_MS && !this.est.predict(now)) p = 'lost';
    else if (this.paused) p = 'paused';
    else p = 'follow';
    if (p !== this.phase) {
      const old = this.phase;
      this.phase = p;
      if (p === 'lost' && old === 'follow') { this.notify('warn', '看不到目標', this.autoSearch() ? '原地懸停；1 秒內沒回來就自動旋轉搜尋' : '原地懸停，3 秒內回到畫面會自動找回'); this.buzz('warn'); }
      if (p === 'video-stall') { this.notify('warn', '影像中斷', '沒有新的畫面 → 懸停；恢復後自動繼續跟隨'); this.buzz('warn'); }
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
      paused: this.paused, gesture: this.lastGesture, hTarget: this.hTarget ?? null,
      palm: { phase: this.palm.phase, mode: this.palm.mode, side: this.palmSide, hand: this.palmHand, ready: this.handsReady,
        error: this.handError, under: this.palm.under, travel: this.palm.travel },
      cam: this.cam, downHand: this.downHand,
      search: { active: this.search.active, stage: this.search.stage, rel: Math.round(this.search.rel), side: this.search.side },
      stalled: this.stalled, detPeriod: Math.round(this.detPeriod), rejected: this.est.rejected,
      est: this.est.predict(performance.now()),
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

    if (this.cam === 'down') { this._drawDown(now, W, H, lw, col); return; }

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

    // 停到手上：手掌要對準的位置（虛線框）＋偵測到的手
    if (this.palm.active) {
      const approach = this.palm.phase === 'approach';
      if (approach) {
        const zx = W / 2, zy = H * PALM.handY, zr = H * PALM.tol;
        g.strokeStyle = col.warn; g.lineWidth = lw * 1.5; g.setLineDash([lw * 3, lw * 2]);
        g.strokeRect(zx - zr * 1.2, zy - zr, zr * 2.4, zr * 2);
        g.setLineDash([]);
      }
      const h = this.palmHand;
      if (approach && h && now - h.seen <= STALE_MS) {
        g.fillStyle = h.open ? col.ok : col.warn;
        g.beginPath(); g.arc(h.x * W, h.y * H, lw * 4, 0, Math.PI * 2); g.fill();
        if (Number.isFinite(h.dist)) {
          g.fillStyle = '#E6EDF3';
          g.fillText(`手 約 ${Math.round(h.dist * 100)} cm`, h.x * W + lw * 6, h.y * H - lw * 2);
        }
      }
      if (this.palm.phase !== 'approach') this._banner(PHASE[PALM_PHASE[this.palm.phase]][1], W, H, col.warn);
    }

    if (this.stalled && this.hasVideoOrFake()) this._banner('影像中斷 → 懸停中', W, H, col.danger);
    else if (this.search.active) {
      const s = this.search;
      const arrow = (s.stage === 'sweep2' ? -s.side : s.side) > 0 ? '→' : '←';
      const txt = s.stage === 'hold' ? '目標遺失：先懸停…' : s.stage === 'spin' ? `搜尋中：轉一圈 ${arrow}` : `搜尋中：往${arrow === '→' ? '右' : '左'}轉 ${arrow}（${Math.round((performance.now() - s.t0) / 1000)} s）`;
      this._banner(txt, W, H, col.warn);
    }

    // 中央十字（跟隨的瞄準點）
    if (tid !== null) {
      g.strokeStyle = 'rgba(230,237,243,.45)'; g.lineWidth = lw;
      g.beginPath(); g.moveTo(W / 2, H / 2 - H / 30); g.lineTo(W / 2, H / 2 + H / 30);
      g.moveTo(W / 2 - H / 30, H / 2); g.lineTo(W / 2 + H / 30, H / 2); g.stroke();
    }

    this._drawGesture(now, W, H, lw, col);
  }

  _banner(txt, W, H, color) {
    const g = this.ctx;
    const tw = g.measureText(txt).width + 28, th = Math.round(H / 14);
    g.fillStyle = 'rgba(11,15,20,.85)'; g.fillRect((W - tw) / 2, H * 0.16, tw, th);
    g.fillStyle = color; g.textBaseline = 'middle';
    g.fillText(txt, (W - tw) / 2 + 14, H * 0.16 + th / 2);
    g.textBaseline = 'bottom';
  }

  // 下視鏡頭：中心是機身正下方；虛線框＝對準範圍；點＝偵測到的手；文字＝手在機身哪一邊（確認方向設定用）
  _drawDown(now, W, H, lw, col) {
    const g = this.ctx;
    const r = H * PALM.downTol;
    g.strokeStyle = col.warn; g.lineWidth = lw * 1.5; g.setLineDash([lw * 3, lw * 2]);
    g.strokeRect(W / 2 - r * (W / H), H / 2 - r, r * 2 * (W / H), r * 2);
    g.setLineDash([]);
    g.strokeStyle = 'rgba(230,237,243,.6)'; g.lineWidth = lw;
    g.beginPath(); g.moveTo(W / 2, H / 2 - H / 20); g.lineTo(W / 2, H / 2 + H / 20);
    g.moveTo(W / 2 - H / 20, H / 2); g.lineTo(W / 2 + H / 20, H / 2); g.stroke();
    const h = this.downHand;
    let txt = now < this.downFrom ? '下視鏡頭：切換中…' : '下視鏡頭：沒有看到手';
    if (h && now - h.seen <= STALE_MS) {
      g.fillStyle = col.ok;
      g.beginPath(); g.arc(h.x * W, h.y * H, lw * 5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = col.ok; g.lineWidth = lw * 1.5;
      g.beginPath(); g.moveTo(W / 2, H / 2); g.lineTo(h.x * W, h.y * H); g.stroke();
      const side = (v, pos, neg) => (Math.abs(v) < PALM.downTol ? '' : v > 0 ? pos : neg);
      const where = [side(h.fwd, '前方', '後方'), side(h.right, '右方', '左方')].filter(Boolean).join('、');
      txt = where ? `手在機身${where}` : '手在機身正下方 ✓';
    }
    this._banner(this.palm.active ? `${PHASE[PALM_PHASE[this.palm.phase]][1]} · ${txt}` : txt, W, H, col.warn);
    this._drawGesture(now, W, H, lw, col);
  }

  _drawGesture(now, W, H, lw, col) {
    const g = this.ctx;
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
