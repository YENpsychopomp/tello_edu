// 合成的 MediaPipe 姿勢（33 點）與手部（21 點），給 Node 單元測試與 E2E 的假偵測共用。
export const ASPECT = 4 / 3;
export const VSPAN = 1.055;

/**
 * 合成一個面向鏡頭站立的人。cx＝軀幹中心 x、cy＝軀幹中心 y、t＝軀幹長度（影像高度單位）。
 * 面向鏡頭 → 人的「左」在畫面右邊。arms: { l, r } = 'down' | 'up' | 'half' | 'slant' | 'out' | 'outhigh' | 'cross' | 'forward'
 * 'half'：手只舉到肩膀上方一截（有舉的意圖，沒過頭）；'slant'：斜 45° 舉；'outhigh'：側平舉但略高於肩；
 * 'forward'：手臂朝鏡頭伸直（畫面上縮短、手腕的深度 z 比肩膀近）。
 */
export function person({ cx = 0.5, cy = 0.5, t = 0.2, arms = {}, hips = true } = {}) {
  const P = Array.from({ length: 33 }, () => ({ x: cx, y: cy, z: 0, visibility: 0.1 }));
  const X = (dx) => cx + dx / ASPECT;          // dx 以影像高度為單位
  const sh = cy - t / 2, hip = cy + t / 2, sw = t * 0.75;
  const set = (i, dx, y, v = 0.95, z = 0) => { P[i] = { x: X(dx), y, z, visibility: v }; };
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
    if (a === 'half') { set(e, sx * 1.4, sh + t * 0.05); set(w, sx * 1.3, sh - t * 0.4); }
    if (a === 'slant') { set(e, sx + sgn * t * 0.35, sh - t * 0.3); set(w, sx + sgn * t * 0.6, sh - t * 0.7); }
    if (a === 'outhigh') { set(e, sx + sgn * t * 0.6, sh - t * 0.12); set(w, sx + sgn * t * 1.2, sh - t * 0.3); }
    if (a === 'out') { set(e, sx + sgn * t * 0.6, sh + t * 0.02); set(w, sx + sgn * t * 1.2, sh + t * 0.05); }
    if (a === 'cross') { set(e, sx * 1.1, sh + t * 0.45); set(w, -sgn * sw * 0.25, sh + t * 0.35); }
    if (a === 'forward') {
      set(e, sx * 0.9, sh + t * 0.18, 0.95, -0.15);
      set(w, sx * 0.6, sh + t * 0.3, 0.95, -0.35);
    }
  }
  return P;
}

/**
 * 合成一隻手（手掌朝鏡頭、手指朝上）。x、y＝手腕在影像中的位置，dist＝離鏡頭幾公尺。
 * open=false 時手指彎曲（握拳）。world 是公尺座標（MediaPipe worldLandmarks 的格式）。
 */
export function hand({ x = 0.5, y = 0.6, dist = 1.0, open = true } = {}) {
  const world = new Array(21);
  world[0] = { x: 0, y: 0, z: 0 };
  // 拇指（不計入張開判斷）
  [[0.03, -0.02], [0.045, -0.04], [0.055, -0.06], [0.06, -0.075]].forEach(([wx, wy], i) => { world[1 + i] = { x: wx, y: wy, z: 0 }; });
  const mcpX = [0.025, 0.008, -0.01, -0.028];
  mcpX.forEach((mx, f) => {
    const base = 5 + f * 4;
    const m = { x: mx, y: -0.09, z: 0 };
    world[base] = m;
    if (open) {
      world[base + 1] = { x: mx, y: -0.13, z: 0 };
      world[base + 2] = { x: mx, y: -0.155, z: 0 };
      world[base + 3] = { x: mx, y: -0.175, z: 0 };
    } else {
      world[base + 1] = { x: mx, y: -0.115, z: -0.02 };
      world[base + 2] = { x: mx, y: -0.105, z: -0.035 };
      world[base + 3] = { x: mx, y: -0.09, z: -0.025 };
    }
  });
  const k = 1 / (dist * VSPAN);                   // 1 m 在畫面上是多少個影像高
  const lms = world.map((p) => ({ x: x + (p.x * k) / ASPECT, y: y + p.y * k, z: p.z }));
  return { lms, world };
}
