// 合成的 MediaPipe 姿勢（33 點），給 Node 單元測試與 E2E 的假偵測共用。
export const ASPECT = 4 / 3;

/**
 * 合成一個面向鏡頭站立的人。cx＝軀幹中心 x、cy＝軀幹中心 y、t＝軀幹長度（影像高度單位）。
 * 面向鏡頭 → 人的「左」在畫面右邊。arms: { l, r } = 'down' | 'up' | 'out' | 'cross'
 */
export function person({ cx = 0.5, cy = 0.5, t = 0.2, arms = {}, hips = true } = {}) {
  const P = Array.from({ length: 33 }, () => ({ x: cx, y: cy, visibility: 0.1 }));
  const X = (dx) => cx + dx / ASPECT;          // dx 以影像高度為單位
  const sh = cy - t / 2, hip = cy + t / 2, sw = t * 0.75;
  const set = (i, dx, y, v = 0.95) => { P[i] = { x: X(dx), y, visibility: v }; };
  set(0, 0, sh - t * 0.45);                       // 鼻子
  set(7, sw * 0.2, sh - t * 0.45); set(8, -sw * 0.2, sh - t * 0.45);
  set(11, sw / 2, sh); set(12, -sw / 2, sh);      // 左肩在畫面右（+x）
  if (hips) { set(23, sw * 0.35, hip); set(24, -sw * 0.35, hip); }
  set(25, sw * 0.35, hip + t * 0.9); set(26, -sw * 0.35, hip + t * 0.9);
  set(27, sw * 0.35, hip + t * 1.8); set(28, -sw * 0.35, hip + t * 1.8);
  for (const [side, sgn, e, w] of [['l', 1, 13, 15], ['r', -1, 14, 16]]) {
    const a = arms[side] || 'down', sx = sgn * sw / 2;
    if (a === 'down') { set(e, sx * 1.1, sh + t * 0.45); set(w, sx * 1.15, sh + t * 0.9); }
    if (a === 'up') { set(e, sx * 1.2, sh - t * 0.4); set(w, sx * 1.1, sh - t * 0.95); }
    if (a === 'out') { set(e, sx + sgn * t * 0.6, sh + t * 0.02); set(w, sx + sgn * t * 1.2, sh + t * 0.05); }
    if (a === 'cross') { set(e, sx * 1.1, sh + t * 0.45); set(w, -sgn * sw * 0.25, sh + t * 0.35); }
  }
  return P;
}

