// 「停到手上」：手臂向前伸、手掌張開 → 無人機飛到手前方、比手略高處懸停 →
// 使用者把手掌移到機身正下方 → 下方 ToF 測到距離突然變短 → 送 land，落在手上後螺旋槳自動停止。
//
// 鏡頭只能看前方、看不到正下方，所以最後一段由人把手伸到下面，而不是讓無人機盲飛過去。
// 全部是純邏輯（時間、偵測結果、遙測都由呼叫端傳入），Node 單元測試直接驗證。
import { CAM_VSPAN, LM, visible } from './geometry.js';

export const PALM = Object.freeze({
  approachDist: 0.5,     // 飛到離手約這麼遠（m）
  holdDist: 0.6,         // 這個距離以內、而且對準了 → 懸停等手伸到下方
  retreatDist: 0.35,     // 比這更近 → 後退
  handY: 0.66,           // 手掌在畫面中的目標高度（偏下＝無人機比手高）
  tol: 0.1,              // 對準容許誤差（影像比例）
  settleMs: 800,         // 對準要維持多久才進入懸停等待
  lostMs: 1500,          // 接近途中看不到手多久就取消
  holdTimeoutMs: 20000,  // 懸停等待多久沒偵測到手掌就取消
  baselineMs: 600,       // 進入懸停後用多久的 ToF 當基準
  tofDrop: 25,           // ToF 比基準少這麼多（cm）…
  tofMax: 60,            // …而且小於這個值，才算手掌在正下方
  tofSamples: 3,         // 連續幾筆遙測都符合才降落（遙測 10 Hz → 約 0.3 秒）
  fwdMax: 18, yawMax: 30, upMax: 25,
});

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

const ZERO = [0, 0, 0, 0];

/**
 * 狀態機：approach（飛向手）→ hold（懸停，等手伸到正下方）→ landing（已送 land）→ done／abort。
 */
export class PalmLander {
  constructor(cfg = PALM) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.phase = 'idle';
    this.reason = '';
    this.startedAt = 0;
    this.alignedSince = null;
    this.handSeenAt = 0;
    this.holdAt = 0;
    this.tofBase = [];
    this.baseline = null;
    this.hits = 0;
    this.lastTofAt = -Infinity;
  }

  get active() { return this.phase === 'approach' || this.phase === 'hold' || this.phase === 'landing'; }

  start(now) {
    this.reset();
    this.phase = 'approach';
    this.startedAt = now;
    this.handSeenAt = now;
  }

  abort(reason) {
    if (!this.active) return;
    this.phase = 'abort';
    this.reason = reason;
  }

  /**
   * @param o.now         毫秒
   * @param o.hand        {x, y, dist}（看不到手＝null）
   * @param o.distMin     由肩寬估出的「人至少這麼近」（m），沒有就 null
   * @param o.tof         下方 ToF（cm）
   * @param o.flying      是否在空中
   * @returns {{rc:number[], land:boolean}}
   */
  update({ now, hand, distMin = null, tof = null, flying = true }) {
    const c = this.cfg;
    if (this.phase === 'landing') {
      if (!flying) this.phase = 'done';
      return { rc: ZERO, land: false };
    }
    if (!this.active) return { rc: ZERO, land: false };

    if (this.phase === 'approach') {
      if (hand) this.handSeenAt = now;
      else if (now - this.handSeenAt > c.lostMs) { this.abort('看不到手掌'); return { rc: ZERO, land: false }; }
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
      if (settled) {
        if (this.alignedSince === null) this.alignedSince = now;
        if (now - this.alignedSince >= c.settleMs) { this.phase = 'hold'; this.holdAt = now; return { rc: ZERO, land: false }; }
      } else this.alignedSince = null;
      return { rc: [0, Math.round(fwd), Math.round(up), Math.round(yaw)], land: false };
    }

    // hold：不前進；手伸到下方之後鏡頭就看不到手了，這是正常的
    if (now - this.holdAt > c.holdTimeoutMs) { this.abort(`${Math.round(c.holdTimeoutMs / 1000)} 秒內沒有偵測到手掌在正下方`); return { rc: ZERO, land: false }; }
    const valid = Number.isFinite(tof) && tof > 0 && tof < 500;
    if (valid && now - this.lastTofAt >= 90) {          // 遙測 10 Hz：每筆只算一次
      this.lastTofAt = now;
      if (now - this.holdAt < c.baselineMs) this.tofBase.push(tof);
      else {
        if (this.baseline === null) {
          const s = [...this.tofBase].sort((a, b) => a - b);
          this.baseline = s.length ? s[Math.floor(s.length / 2)] : tof;
        }
        const under = tof <= c.tofMax && tof <= this.baseline - c.tofDrop;
        this.hits = under ? this.hits + 1 : 0;
        if (this.hits >= c.tofSamples) { this.phase = 'landing'; return { rc: ZERO, land: true }; }
      }
    }
    // 懸停時仍小幅修正，讓手留在畫面中（看得到的話）
    if (hand) {
      const yaw = clamp(dead(hand.x - 0.5, 0.05) * 60, -15, 15);
      return { rc: [0, 0, 0, Math.round(yaw)], land: false };
    }
    return { rc: ZERO, land: false };
  }
}
