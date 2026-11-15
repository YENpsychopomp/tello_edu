// 目標遺失時的自動搜尋：原地旋轉（不平移、不改高度）找人。
//
//   hold   先懸停一下（人常常只是被擋住、或畫面花了一下）
//   sweep1 往目標離開的那一邊轉，最多 sectorDeg
//   sweep2 再往另一邊轉到 −sectorDeg（以遺失時的航向為基準）
//   spin   還是沒有 → 往原本那一邊慢慢轉一整圈
//   giveup 總時間超過 maxMs → 放棄（呼叫端改成懸停並通知）
// 航向用 Tello 回報的 yaw（−180..180）累積展開，所以轉了多少度不靠時間估。純邏輯。
export const SEARCH = Object.freeze({
  holdMs: 800,
  yawRc: 28,            // 旋轉速度（rc），約 30–40°/s
  yawRcSpin: 22,
  sectorDeg: 75,
  fullDeg: 380,
  maxMs: 20000,
  rampMs: 400,          // 起轉／換向時的加速時間
});

const wrap = (d) => ((d + 540) % 360) - 180;

export class Searcher {
  constructor(o = {}) { this.o = { ...SEARCH, ...o }; this.reset(); }

  reset() { this.stage = 'idle'; this.t0 = 0; this.stageAt = 0; this.side = 1; this.yaw0 = null; this.lastYaw = null; this.rel = 0; this.spun = 0; }

  get active() { return this.stage !== 'idle' && this.stage !== 'giveup'; }

  /** @param side +1 往右（順時針）先找、−1 往左 @param yaw 目前航向（度，可為 null） */
  start(now, side = 1, yaw = null) {
    this.reset();
    this.side = side >= 0 ? 1 : -1;
    this.t0 = now; this.stageAt = now;
    this.stage = 'hold';
    this.yaw0 = Number.isFinite(yaw) ? yaw : null;
    this.lastYaw = this.yaw0;
    this.rel = 0;
  }

  _track(yaw) {
    if (!Number.isFinite(yaw)) return;
    if (this.lastYaw === null) { this.lastYaw = yaw; this.yaw0 = yaw; return; }
    const d = wrap(yaw - this.lastYaw);
    this.rel += d;
    this.spun += Math.abs(d);
    this.lastYaw = yaw;
  }

  /**
   * 每拍呼叫。@returns {{rc:number[], stage:string, rel:number, elapsed:number}}
   */
  update(now, yaw) {
    if (!this.active) return { rc: [0, 0, 0, 0], stage: this.stage, rel: this.rel, elapsed: now - this.t0 };
    this._track(yaw);
    const elapsed = now - this.t0;
    if (elapsed > this.o.maxMs) { this.stage = 'giveup'; return { rc: [0, 0, 0, 0], stage: this.stage, rel: this.rel, elapsed }; }
    const haveYaw = Number.isFinite(yaw);
    const sinceStage = now - this.stageAt;
    const next = (s) => { this.stage = s; this.stageAt = now; };
    switch (this.stage) {
      case 'hold':
        if (sinceStage >= this.o.holdMs) next('sweep1');
        break;
      case 'sweep1':
        // 沒有航向資料就用時間估（約 35°/s）
        if (haveYaw ? this.side * this.rel >= this.o.sectorDeg : sinceStage >= (this.o.sectorDeg / 35) * 1000) next('sweep2');
        break;
      case 'sweep2':
        if (haveYaw ? -this.side * this.rel >= this.o.sectorDeg : sinceStage >= (2 * this.o.sectorDeg / 35) * 1000) { this.spun = 0; next('spin'); }
        break;
      case 'spin':
        if (haveYaw ? this.spun >= this.o.fullDeg : sinceStage >= (this.o.fullDeg / 30) * 1000) this.stage = 'giveup';
        break;
      default:
    }
    const dir = this.stage === 'sweep1' || this.stage === 'spin' ? this.side : this.stage === 'sweep2' ? -this.side : 0;
    const ramp = Math.min(1, (now - this.stageAt) / this.o.rampMs);
    const speed = this.stage === 'spin' ? this.o.yawRcSpin : this.o.yawRc;
    const rc = [0, 0, 0, this.stage === 'giveup' ? 0 : Math.round(dir * speed * (0.35 + 0.65 * ramp))];
    return { rc, stage: this.stage, rel: this.rel, elapsed };
  }
}
