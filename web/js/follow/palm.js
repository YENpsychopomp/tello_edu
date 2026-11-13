// 「停到手上」：手臂向前伸、手掌張開 →
//   1. approach：用前鏡頭飛到手前方約 50 cm、比手略高處
//   2. switch  ：切到下視鏡頭（downvision 1）；韌體不支援就只用 ToF
//   3. climb   ：升到「手上方約 35 cm」的高度（由前鏡頭估出的手的高度換算）
//   4. seek    ：慢慢往前，直到下視鏡頭看到手（或 ToF 突然變短＝手在正下方）
//   5. align   ：用下視鏡頭裡手掌的位置做細微的前後左右校準，ToF 保持在手上方約 35 cm
//      （只有 ToF 時改走 settle：手在正下方 → 停住一下）
//   6. landing ：對準且 ToF 確認手在正下方 → 送 land，落在手上後螺旋槳自動停止
//
// 往前找手是盲飛，所以有兩道上限：依速度遙測積分的距離（最多比手的估計距離多 35 cm）與時間。
// 全部是純邏輯（時間、偵測結果、遙測都由呼叫端傳入），Node 單元測試直接驗證。
import { CAM_VSPAN, LM, visible } from './geometry.js';

export const PALM = Object.freeze({
  approachDist: 0.5,     // 飛到離手約這麼遠（m）
  holdDist: 0.6,         // 這個距離以內、而且對準了 → 切到下視鏡頭
  retreatDist: 0.35,     // 比這更近 → 後退
  handY: 0.66,           // 手掌在前鏡頭畫面中的目標高度（偏下＝無人機比手高）
  tol: 0.1,              // 前鏡頭對準容許誤差（影像比例）
  settleMs: 800,         // 對準要維持多久才切換鏡頭
  lostMs: 1500,          // 接近途中看不到手多久就取消
  switchTimeoutMs: 5000, // 切換鏡頭最多等多久（逾時就只用 ToF）
  clearance: 35,         // 對準時機身在手上方幾 cm（ToF 量到手的距離）
  climbMax: 60,          // 最多為了越過手而爬升幾 cm
  climbTol: 8,           // 爬升到目標 ±這麼多就開始往前
  climbMaxMs: 4000,
  creepFwd: 15,          // 往前找手的 rc
  travelExtra: 0.35,     // 往前最多比手的估計距離多走幾 m（速度遙測積分）
  creepMaxMs: 6000,      // 往前找手最多幾毫秒
  downTol: 0.08,         // 下視畫面中手掌中心離畫面中心多少以內算對準（影像比例）
  downGain: 45,          // 下視誤差 → rc 的比例
  downMax: 12,           // 下視校準的 rc 上限（細微修正）
  alignMs: 700,          // 對準要維持多久才降落
  downLostMs: 1200,      // 下視鏡頭看不到手多久就取消
  tofDrop: 25,           // ToF 比最近的基準少這麼多（cm）＝手在正下方
  tofSamples: 3,         // 連續幾筆遙測都符合才算（遙測 10 Hz → 約 0.3 秒）
  tofSettleMs: 600,      // 只用 ToF 時：偵測到手在下方後懸停多久再降落
  fwdMax: 18, yawMax: 30, upMax: 25,
});

/**
 * 下視鏡頭畫面座標 → 機身方向的誤差（手在機身的哪一邊）。
 * @param orient.edge   畫面哪一邊是機頭方向：'up' | 'right' | 'down' | 'left'
 * @param orient.mirror 畫面是否左右鏡像
 * @returns {{right:number, fwd:number}}  正值＝手在機身右方／前方（影像比例，-0.5..0.5）
 */
export function downToBody(x, y, orient = {}) {
  let dx = x - 0.5;
  const dy = y - 0.5;
  if (orient.mirror) dx = -dx;
  switch (orient.edge) {
    case 'right': return { fwd: dx, right: dy };
    case 'down': return { fwd: dy, right: -dx };
    case 'left': return { fwd: -dx, right: -dy };
    default: return { fwd: -dy, right: dx };
  }
}

// 手部 21 點：0 手腕；食指 5–8、中指 9–12、無名指 13–16、小指 17–20（MCP、PIP、DIP、TIP）
const FINGERS = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]];
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dead = (e, d) => (Math.abs(e) <= d ? 0 : e - Math.sign(e) * d);

/** 伸直的手指數（用 3D 世界座標，手掌朝哪個方向都一樣） */
export function extendedFingers(world) {
  if (!Array.isArray(world) || world.length < 21) return 0;
  const w = world[0];
  let n = 0;
  for (const [mcp, pip, tip] of FINGERS) {
    const M = world[mcp], P = world[pip], T = world[tip];
    const far = d3(w, T) > d3(w, P) * 1.15;                       // 指尖比 PIP 離手腕遠
    const straight = d3(M, T) > 0.8 * (d3(M, P) + d3(P, T));      // 手指沒有彎
    if (far && straight) n++;
  }
  return n;
}

export const isOpenHand = (hand) => !!hand && extendedFingers(hand.world) >= 4;

/**
 * 用手的實際尺寸（世界座標，公尺）÷ 畫面上的尺寸 估距離。
 * 手斜著時畫面上會變短 → 估出來偏遠，所以取幾段中最小的（最不斜的那段）。
 */
export function handDistance(hand, aspect = 4 / 3) {
  if (!hand || !Array.isArray(hand.lms) || !Array.isArray(hand.world)) return null;
  let best = Infinity;
  for (const [a, b] of [[0, 5], [0, 17], [5, 17], [0, 9]]) {
    const A = hand.lms[a], B = hand.lms[b], WA = hand.world[a], WB = hand.world[b];
    if (!A || !B || !WA || !WB) continue;
    const img = Math.hypot((A.x - B.x) * aspect, A.y - B.y);
    const real = d3(WA, WB);
    if (img > 1e-4 && real > 0.01) best = Math.min(best, real / (img * CAM_VSPAN));
  }
  return Number.isFinite(best) ? best : null;
}

/** 手掌中心（影像座標）：手腕與四根手指 MCP 的平均 */
export function handCenter(hand) {
  const pts = [0, 5, 9, 13, 17].map((i) => hand.lms[i]).filter(Boolean);
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
}

/**
 * 手臂是否向前伸（朝著無人機）：手臂在畫面上明顯縮短（透視），手腕在肩膀到髖部的高度、沒有越過身體中線；
 * 姿勢模型有深度時，手腕也要比肩膀靠近鏡頭。
 */
export function armForward(lms, side, aspect = 4 / 3) {
  if (!Array.isArray(lms) || lms.length < 25) return false;
  const [S, E, W] = side === 'l' ? [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST] : [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST];
  const s = lms[S], w = lms[W], e = lms[E];
  const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER];
  if (!visible(s) || !visible(w) || !visible(ls) || !visible(rs)) return false;
  const sw = Math.abs(ls.x - rs.x) * aspect;
  const lh = lms[LM.L_HIP], rh = lms[LM.R_HIP];
  const shY = (ls.y + rs.y) / 2;
  const torso = visible(lh) && visible(rh) ? (lh.y + rh.y) / 2 - shY : sw * 1.4;
  if (torso <= 0) return false;
  const span = Math.hypot((w.x - s.x) * aspect, w.y - s.y);        // 肩到手腕（畫面上）
  const shortened = span < 0.6 * 1.2 * torso;                       // 手臂伸直約 1.2 個軀幹長
  const height = w.y > shY - torso * 0.35 && w.y < shY + torso * 0.9;
  const midX = (ls.x + rs.x) / 2;
  const sameSide = Math.sign(w.x - midX) === Math.sign(s.x - midX) || Math.abs(w.x - midX) * aspect < sw * 0.25;
  const elbowOk = !visible(e) || Math.hypot((e.x - s.x) * aspect, e.y - s.y) < 0.75 * torso;
  const hasZ = Number.isFinite(w.z) && Number.isFinite(s.z) && (w.z !== 0 || s.z !== 0);
  const zOk = !hasZ || w.z - s.z < -0.25 * (sw / aspect);
  return shortened && height && sameSide && elbowOk && zOk;
}

/** 找出和某隻手腕（姿勢模型）最接近的手（手部模型） */
export function matchHand(wrist, hands, aspect = 4 / 3, maxDist = 0.12) {
  if (!wrist || !Array.isArray(hands)) return null;
  let best = null, bd = maxDist;
  for (const h of hands) {
    const w = h.lms && h.lms[0];
    if (!w) continue;
    const d = Math.hypot((w.x - wrist.x) * aspect, w.y - wrist.y);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

/**
 * 「停到手上」手勢：哪一隻手臂向前伸、而且那隻手張開。
 * @returns {{side:'l'|'r', hand:object}|null}
 */
export function detectPalm(lms, hands, aspect = 4 / 3) {
  for (const side of ['r', 'l']) {
    if (!armForward(lms, side, aspect)) continue;
    const hand = matchHand(lms[side === 'l' ? LM.L_WRIST : LM.R_WRIST], hands, aspect);
    if (hand && isOpenHand(hand)) return { side, hand };
  }
  return null;
}

/** 手部模型結果 → 控制用的手（中心、估計距離） */
export function handInfo(hand, aspect = 4 / 3) {
  if (!hand) return null;
  const c = handCenter(hand);
  return { x: c.x, y: c.y, dist: handDistance(hand, aspect), open: isOpenHand(hand) };
}

/** 下視鏡頭的手：取畫面上最大的那隻（最近、最可能是要停的手） */
export function pickDownHand(hands, aspect = 4 / 3) {
  if (!Array.isArray(hands) || !hands.length) return null;
  let best = null, bs = 0;
  for (const h of hands) {
    if (!h || !Array.isArray(h.lms) || h.lms.length < 21) continue;
    const xs = h.lms.map((p) => p.x), ys = h.lms.map((p) => p.y);
    const size = (Math.max(...xs) - Math.min(...xs)) * aspect + (Math.max(...ys) - Math.min(...ys));
    if (size > bs) { bs = size; best = h; }
  }
  if (!best) return null;
  const c = handCenter(best);
  return { x: c.x, y: c.y, size: bs };
}

const ZERO = [0, 0, 0, 0];
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
const tofOk = (t) => Number.isFinite(t) && t > 0 && t < 500;

export const PALM_ACTIVE = new Set(['approach', 'switch', 'climb', 'seek', 'align', 'settle', 'landing']);
const DOWN_PHASES = new Set(['switch', 'climb', 'seek', 'align', 'settle']);

/**
 * 狀態機：approach → switch → climb → seek → align（下視）／settle（只有 ToF）→ landing → done；途中隨時可能 abort。
 */
export class PalmLander {
  constructor(cfg = PALM) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.phase = 'idle';
    this.reason = '';
    this.mode = null;            // 'cam'（下視鏡頭）| 'tof'（只用 ToF）
    this.phaseAt = 0;
    this.alignedSince = null;
    this.handSeenAt = 0;
    this.downSeenAt = 0;
    this.est = null;             // 切換鏡頭時估的手：{d: 前方距離 m, dz: 低於鏡頭 m}
    this.climbCm = 0;
    this.tofTarget = null;       // 爬升後要保持的（對地）ToF
    this.hTarget = null;         // ToF 無效時改用高度
    this.travel = 0;             // 往前找手已經走了幾 m（速度積分）
    this.lastNow = null;
    this.tofWin = [];
    this.tofHits = 0;
    this.tofClear = 0;
    this.under = false;          // ToF 判斷：機身正下方有手
    this.underBase = null;
    this.tof = null;
    this.lastTofAt = -Infinity;
  }

  get active() { return PALM_ACTIVE.has(this.phase); }
  /** 這個階段要用下視鏡頭（只用 ToF 時不需要） */
  get wantsDown() { return DOWN_PHASES.has(this.phase) && this.mode !== 'tof'; }

  _go(phase, now) { this.phase = phase; this.phaseAt = now; this.alignedSince = null; }

  start(now) {
    this.reset();
    this._go('approach', now);
    this.handSeenAt = now;
  }

  abort(reason) {
    if (!this.active || this.phase === 'landing') return;
    this.phase = 'abort';
    this.reason = reason;
  }

  /** 切換到下視鏡頭的結果（呼叫端送 downvision 1 之後回報；失敗就只用 ToF） */
  camResult(ok, now) {
    if (this.phase !== 'switch') return;
    this.mode = ok ? 'cam' : 'tof';
    this.downSeenAt = now;
    this._go('climb', now);
  }

  // ToF：每筆遙測更新一次；「突然比最近的基準短 tofDrop」＝手（或別的東西）在正下方
  _tofUpdate(now, tof) {
    if (!tofOk(tof)) { this.tof = null; return; }
    this.tof = tof;
    if (now - this.lastTofAt < 90) return;              // 遙測 10 Hz：每筆只算一次
    this.lastTofAt = now;
    const c = this.cfg;
    if (!this.under) {
      const base = this.tofWin.length >= 3 ? median(this.tofWin) : null;
      const drop = base !== null && tof <= base - c.tofDrop;
      this.tofHits = drop ? this.tofHits + 1 : 0;
      if (this.tofHits >= c.tofSamples) { this.under = true; this.tofClear = 0; this.underBase = base; return; }
      if (!drop) { this.tofWin.push(tof); if (this.tofWin.length > 6) this.tofWin.shift(); }
    } else {
      const clear = tof > this.underBase - c.tofDrop / 2;
      this.tofClear = clear ? this.tofClear + 1 : 0;
      if (this.tofClear >= c.tofSamples) { this.under = false; this.tofHits = 0; this.tofWin = [tof]; }
    }
  }

  // 高度：手在正下方時保持在手上方 clearance；否則保持爬升後的對地高度
  _up(h) {
    const c = this.cfg, lim = c.upMax * 0.8;
    if (this.under && this.tof !== null) return clamp((c.clearance - this.tof) * 0.8, -12, 12);
    if (this.tofTarget !== null && this.tof !== null) return clamp((this.tofTarget - this.tof) * 1.2, -lim, lim);
    if (this.hTarget !== null && Number.isFinite(h)) return clamp((this.hTarget - h) * 1.2, -lim, lim);
    return 0;
  }

  /**
   * @param o.now      毫秒
   * @param o.hand     前鏡頭的手 {x, y, dist}（approach 用；看不到＝null）
   * @param o.down     下視鏡頭的手，已換成機身方向 {right, fwd}（看不到＝null）
   * @param o.distMin  由肩寬估出的「人至少這麼近」（m），沒有就 null
   * @param o.tof      下方 ToF（cm）
   * @param o.h        高度（cm）
   * @param o.speed    水平速度（m/s，由遙測 vgx/vgy 換算；沒有就 null）
   * @param o.flying   是否在空中
   * @returns {{rc:number[], land:boolean}}
   */
  update({ now, hand = null, down = null, distMin = null, tof = null, h = null, speed = null, flying = true }) {
    const c = this.cfg;
    const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(0.2, (now - this.lastNow) / 1000));
    this.lastNow = now;
    if (this.phase === 'landing') {
      if (!flying) this.phase = 'done';
      return { rc: ZERO, land: false };
    }
    if (!this.active) return { rc: ZERO, land: false };
    this._tofUpdate(now, tof);
    const hv = Number.isFinite(h) ? h : null;
    const out = (a, b, u, y) => ({ rc: [Math.round(a), Math.round(b), Math.round(u), Math.round(y)], land: false });
    const hover = () => out(0, 0, this._up(hv), 0);
    const land = () => { this.phase = 'landing'; return { rc: ZERO, land: true }; };
    const fail = (why) => { this.abort(why); return { rc: ZERO, land: false }; };

    if (this.phase === 'approach') {
      if (hand) this.handSeenAt = now;
      else if (now - this.handSeenAt > c.lostMs) return fail('看不到手掌');
      if (!hand) return { rc: ZERO, land: false };
      const ex = hand.x - 0.5, ey = hand.y - c.handY;
      const yaw = clamp(dead(ex, 0.03) * 110, -c.yawMax, c.yawMax);
      const up = clamp(-dead(ey, 0.03) * 120, -c.upMax, c.upMax);       // 手在畫面偏下＝無人機太高 → 下降
      let fwd = 0;
      const aligned = Math.abs(ex) < c.tol * 1.5 && Math.abs(ey) < c.tol * 1.5;
      const d = hand.dist;
      if ((Number.isFinite(distMin) && distMin < c.retreatDist) || (Number.isFinite(d) && d < c.retreatDist)) fwd = -15;
      else if (Number.isFinite(d) && aligned && d > c.approachDist) fwd = clamp((d - c.approachDist) * 40, 0, c.fwdMax);
      const settled = Number.isFinite(d) && d <= c.holdDist && Math.abs(ex) < c.tol && Math.abs(ey) < c.tol;
      if (!settled) { this.alignedSince = null; return out(0, fwd, up, yaw); }
      if (this.alignedSince === null) this.alignedSince = now;
      if (now - this.alignedSince < c.settleMs) return out(0, fwd, up, yaw);
      // 手在前方 d、低於鏡頭 dz → 先爬升到手上方 clearance，再往前移到手上
      this.est = { d, dz: (hand.y - 0.5) * CAM_VSPAN * d };
      this.climbCm = clamp(c.clearance - this.est.dz * 100, 0, c.climbMax);
      const base = this.tofWin.length ? median(this.tofWin) : this.tof;
      this.tofTarget = tofOk(base) ? base + this.climbCm : null;
      this.hTarget = hv !== null ? hv + this.climbCm : null;
      this._go('switch', now);
      return { rc: ZERO, land: false };
    }

    if (this.phase === 'switch') {
      if (now - this.phaseAt > c.switchTimeoutMs) this.camResult(false, now);
      return { rc: ZERO, land: false };
    }

    const seen = this.mode === 'cam' && !!down;
    if (seen) this.downSeenAt = now;

    if (this.phase === 'climb') {
      if (this.under) { this._go(this.mode === 'cam' ? 'align' : 'settle', now); return hover(); }
      const err = this.tofTarget !== null && this.tof !== null ? this.tofTarget - this.tof
        : this.hTarget !== null && hv !== null ? this.hTarget - hv : 0;
      if (Math.abs(err) > c.climbTol) this.alignedSince = null;
      else if (this.alignedSince === null) this.alignedSince = now;
      if ((this.alignedSince !== null && now - this.alignedSince >= 300) || now - this.phaseAt > c.climbMaxMs) {
        this._go('seek', now);
        this.travel = 0;
      }
      return hover();
    }

    if (this.phase === 'seek') {
      if (seen || this.under) { this._go(this.mode === 'cam' ? 'align' : 'settle', now); return hover(); }
      if (Number.isFinite(speed) && speed > 0) this.travel += speed * dt;
      const maxTravel = (this.est ? this.est.d : c.approachDist) + c.travelExtra;
      if (this.travel > maxTravel || now - this.phaseAt > c.creepMaxMs) {
        return fail(`往前約 ${Math.round(this.travel * 100)} cm 仍沒有找到手掌`);
      }
      return out(0, c.creepFwd, this._up(hv), 0);
    }

    if (this.phase === 'settle') {                       // 只有 ToF：手在正下方 → 停住一下再降落
      if (!this.under) return fail('手掌離開了機身下方');
      if (now - this.phaseAt >= c.tofSettleMs) return land();
      return hover();
    }

    // align：下視鏡頭細微校準（前後左右），ToF 保持在手上方 clearance
    if (!seen) {
      if (now - this.downSeenAt > c.downLostMs) return fail('下視鏡頭看不到手掌');
      return hover();
    }
    const a = clamp(dead(down.right, 0.02) * c.downGain, -c.downMax, c.downMax);
    const b = clamp(dead(down.fwd, 0.02) * c.downGain, -c.downMax, c.downMax);
    const centered = Math.abs(down.right) < c.downTol && Math.abs(down.fwd) < c.downTol;
    const atHeight = this.under && this.tof !== null && Math.abs(this.tof - c.clearance) <= 15;
    if (!(centered && atHeight)) this.alignedSince = null;
    else if (this.alignedSince === null) this.alignedSince = now;
    else if (now - this.alignedSince >= c.alignMs) return land();
    return out(a, b, this._up(hv), 0);
  }
}
