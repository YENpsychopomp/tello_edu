// 目標狀態估計（α-β 濾波）：把斷斷續續、偶爾出錯的偵測結果變成平滑、可預測的位置與距離。
//
// 為什麼需要：Tello 的影像走 Wi-Fi UDP，掉封包時畫面會凍結、花掉，偵測結果會缺一兩幀或突然跳一下。
// 直接拿每一幀的結果去控制會抖、會因為一幀缺漏就停下。這裡做三件事：
//   1. 離群值：和預測差太多的量測先不採信（連續兩次才相信，當作真的跳了）
//   2. 預測：量測缺漏時用速度往前推（最多 PREDICT_MS），控制不中斷；速度隨時間衰減
//   3. 延遲補償：影像＋推論大約 LATENCY_MS 前的畫面，控制用「現在」的預測位置
// 純邏輯，時間由呼叫端傳入。
export const EST = Object.freeze({
  alpha: 0.55, beta: 0.25,     // 位置／速度的修正係數（每次量測）
  gate: 0.12,                  // 離群門檻（影像寬度比例）：|量測 − 預測| 超過就先不採信
  gatePerSec: 0.45,            // 間隔越久，門檻放寬越多（1 m 外的人橫走 1.5 m/s ≈ 每秒 1 個畫面寬，但速度項會先跟上）
  predictMs: 700,              // 沒有量測時最多往前推多久
  latencyMs: 120,              // 影像延遲（畫面到控制的時間）
  decayPerSec: 0.35,           // 預測期間速度每秒衰減到幾成（避免越推越遠）
  distAlpha: 0.4,
});

export class TargetEstimator {
  constructor(o = {}) {
    this.o = { ...EST, ...o };
    this.reset();
  }

  reset() {
    this.t = null;             // 最後一次採信的量測時間
    this.cx = 0.5; this.cy = 0.5; this.vx = 0; this.vy = 0;
    this.dist = null; this.vd = 0;
    this.outliers = 0;
    this.n = 0;
    this.rejected = 0;         // 累計被丟掉的量測（診斷用）
  }

  get ready() { return this.t !== null; }

  /** 偵測暫停了 ms（切鏡頭、影像凍結）：時間往後推，不要把暫停當成目標跑掉 */
  shift(ms) { if (this.t !== null && ms > 0) this.t += ms; }

  /**
   * 新的量測。@param m {cx, cy, dist|null} @returns true＝採信，false＝視為離群值丟掉
   */
  feed(m, now) {
    if (!m || !Number.isFinite(m.cx) || !Number.isFinite(m.cy)) return false;
    if (this.t === null) {
      this.cx = m.cx; this.cy = m.cy; this.vx = this.vy = 0;
      this.dist = Number.isFinite(m.dist) ? m.dist : null; this.vd = 0;
      this.t = now; this.n = 1; this.outliers = 0;
      return true;
    }
    const dt = Math.max(0.001, (now - this.t) / 1000);
    const px = this.cx + this.vx * dt, py = this.cy + this.vy * dt;
    const err = Math.hypot(m.cx - px, (m.cy - py) * 0.6);
    if (dt < 1.5 && err > this.o.gate + this.o.gatePerSec * dt && this.outliers < 1 && this.n >= 3) {
      // 跳太遠：可能是花掉的畫面或認錯人。先不採信；下一幀還是這樣就相信它（真的跳了）
      this.outliers++;
      this.rejected++;
      return false;
    }
    if (this.outliers || dt >= 1.5) {
      // 連續兩次離群、或間隔太久：重新對齊位置，速度歸零
      this.cx = m.cx; this.cy = m.cy; this.vx = this.vy = 0;
    } else {
      const a = this.o.alpha, b = this.o.beta;
      const rx = m.cx - px, ry = m.cy - py;
      this.cx = px + a * rx; this.cy = py + a * ry;
      this.vx += (b * rx) / dt; this.vy += (b * ry) / dt;
      // 速度上限：人不會在 1 秒內橫越 1.5 個畫面
      this.vx = Math.max(-1.5, Math.min(1.5, this.vx)); this.vy = Math.max(-1.5, Math.min(1.5, this.vy));
    }
    this.outliers = 0;
    if (Number.isFinite(m.dist)) {
      if (this.dist === null) { this.dist = m.dist; this.vd = 0; } else {
        const pd = this.dist + this.vd * dt;
        const rd = m.dist - pd;
        this.dist = pd + this.o.distAlpha * rd;
        this.vd = Math.max(-2, Math.min(2, this.vd + (0.15 * rd) / dt));
      }
    } else this.vd = 0;
    this.t = now;
    this.n++;
    return true;
  }

  /**
   * 「現在」的估計。回傳 null 表示太久沒有量測（超過 predictMs）或還沒有資料。
   * @returns {{cx, cy, vx, vy, dist, age, predicted}}
   */
  predict(now) {
    if (this.t === null) return null;
    const age = now - this.t;
    if (age > this.o.predictMs) return null;
    const horizon = Math.max(0, age + this.o.latencyMs) / 1000;
    const decay = Math.pow(this.o.decayPerSec, Math.max(0, age) / 1000);
    const vx = this.vx * decay, vy = this.vy * decay;
    return {
      cx: Math.max(-0.2, Math.min(1.2, this.cx + vx * horizon)),
      cy: Math.max(-0.2, Math.min(1.2, this.cy + vy * horizon)),
      vx, vy,
      dist: this.dist === null ? null : Math.max(0.2, this.dist + this.vd * decay * horizon),
      age, predicted: age > 0,
    };
  }

  /** 目標最後是往哪邊離開的：+1 右、−1 左（給搜尋用） */
  exitSide() {
    if (Math.abs(this.vx) > 0.08) return this.vx > 0 ? 1 : -1;
    return this.cx >= 0.5 ? 1 : -1;
  }
}
