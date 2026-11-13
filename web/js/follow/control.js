// 跟隨控制器：目標的位置／距離＋目前高度 → rc [左右, 前後, 升降, 轉向]。純函式，單元測試直接驗證。
//
//   轉向：讓目標的軀幹中心保持在畫面水平中央
//   前後：讓估計距離（由軀幹長度換算）等於設定距離
//   升降：讓 Tello 回報的高度（tel.h，cm）等於設定高度，但一律夾在「手臂看得見」的範圍內（見 armWindow）
//   左右：不用（0）。只轉向不平移，行為最好預測
//
// 安全：輸出有上限、每一步變化量有上限；太近（< MIN_DIST）只會後退；看不到髖部時不會往前；
//       近距離（< 1.5 m）前進速度再降低。
import { CAM_VSPAN } from './geometry.js';

export const LIMITS = Object.freeze({
  yaw: 50, fwd: 35, up: 40,          // rc 上限（-100..100）
  fwdNear: 18,                        // 1.5 m 以內的前進上限
  slew: 9,                            // 每次（30 Hz）最多變化多少
  minDist: 0.4,                       // 比這更近 → 強制後退
  distRange: [0.5, 6.0],              // 可設定的距離（m）
  heightRange: [60, 300],             // 可設定的高度（cm）
  distStep: 0.5, heightStep: 30,      // 每次手勢調整量
});

// 手臂可見的構圖：舉手時手腕約在肩膀上方 1.45 個軀幹長（手臂約 0.72 m，軀幹約 0.5 m）；
// 胸前交叉／T 字需要看到肩膀到髖部。上下各留 6% 的邊。
export const FRAME = Object.freeze({ margin: 0.06, reach: 1.45 });

const GAIN = { yaw: 130, fwd: 32, up: 0.55 };
const DEAD = { yaw: 0.035, fwd: 0.2, up: 8 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dead = (e, d) => (Math.abs(e) <= d ? 0 : e - Math.sign(e) * d);

export function clampSetpoint(sp) {
  return {
    dist: clamp(Number.isFinite(sp.dist) ? sp.dist : 3, ...LIMITS.distRange),
    height: clamp(Number.isFinite(sp.height) ? sp.height : 120, ...LIMITS.heightRange),
  };
}

/** 手勢 → 新的設定值 */
export function applyGesture(sp, g) {
  const s = { ...sp };
  if (g === 'up') s.height += LIMITS.heightStep;
  else if (g === 'down') s.height -= LIMITS.heightStep;
  else if (g === 'farther') s.dist += LIMITS.distStep;
  else if (g === 'closer') s.dist -= LIMITS.distStep;
  return clampSetpoint(s);
}

/**
 * 「手臂看得見」的高度範圍（cm，和 tel.h 同一個基準）。
 *   lo：再低，舉過頭的手會跑出畫面上緣
 *   hi：再高，髖部會跑出畫面下緣（看不到胸前交叉，也沒辦法估距離）
 * 距離太近時兩者無法同時滿足（fits=false）：優先保住軀幹（hi），舉起的手可能被切掉。
 *
 * @param target {lms, torso, shoulder, dist, distMin}
 * @param height 目前高度 cm
 * @returns {{lo:number, hi:number, fits:boolean}|null}  資料不足時回傳 null（不限制）
 */
export function armWindow(target, height) {
  if (!target || !Array.isArray(target.lms) || !Number.isFinite(height)) return null;
  const ls = target.lms[11], rs = target.lms[12];
  if (!ls || !rs) return null;
  const d = Number.isFinite(target.dist) ? target.dist : Number.isFinite(target.distMin) ? target.distMin : null;
  if (!d || d <= 0) return null;
  // 軀幹長（影像高度單位）：看不到髖部時用肩寬換算（0.5 m ÷ 0.36 m ≈ 1.39）
  const torso = Number.isFinite(target.torso) && target.torso > 0 ? target.torso
    : Number.isFinite(target.shoulder) && target.shoulder > 0 ? target.shoulder * 1.39 : null;
  if (!torso) return null;
  const shY = (ls.y + rs.y) / 2;
  const top = shY - FRAME.reach * torso;          // 舉手時手腕的位置
  const bottom = shY + torso;                     // 髖部
  const S = d * CAM_VSPAN * 100;                  // 無人機升高 S cm → 畫面內容往下移 1 個影像高
  const lo = height + (FRAME.margin - top) * S;
  const hi = height + (1 - FRAME.margin - bottom) * S;
  return { lo, hi, fits: lo <= hi };
}

/** 套用手臂可見範圍後的目標高度與原因 */
export function framedHeight(spHeight, win) {
  if (!win) return { h: spHeight, why: null };
  if (!win.fits) return { h: win.hi, why: 'arms-cut' };
  if (spHeight < win.lo) return { h: win.lo, why: 'frame-low' };
  if (spHeight > win.hi) return { h: win.hi, why: 'frame-high' };
  return { h: spHeight, why: null };
}

/**
 * @param target  {cx, dist|null, distMin, lms?, torso?, shoulder?}（null＝看不到目標）
 * @param sp      {dist, height}
 * @param height  目前高度 cm（null＝沒有遙測）
 * @returns {{raw:number[], why:string[], hTarget:number|null, win:object|null}}  raw＝還沒做變化量限制的 rc
 */
export function followRc(target, sp, height) {
  const why = [];
  if (!target) return { raw: [0, 0, 0, 0], why: ['no-target'], hTarget: null, win: null };

  const ex = target.cx - 0.5;
  let yaw = clamp(dead(ex, DEAD.yaw) * GAIN.yaw, -LIMITS.yaw, LIMITS.yaw);

  let fwd = 0;
  if (Number.isFinite(target.distMin) && target.distMin < LIMITS.minDist) {
    fwd = -25; why.push('too-close');
  } else if (Number.isFinite(target.dist)) {
    if (target.dist < LIMITS.minDist) { fwd = -25; why.push('too-close'); }
    else {
      const cap = target.dist < 1.5 ? LIMITS.fwdNear : LIMITS.fwd;
      fwd = clamp(dead(target.dist - sp.dist, DEAD.fwd) * GAIN.fwd, -LIMITS.fwd, cap);
    }
    // 目標快跑出畫面邊緣時先轉向，前進減半
    if (fwd > 0 && Math.abs(ex) > 0.25) { fwd *= 0.5; why.push('turn-first'); }
  } else {
    why.push('no-torso');      // 看不到髖部 → 不知道多遠 → 不前進
  }

  let up = 0, hTarget = null;
  const win = armWindow(target, height);
  if (Number.isFinite(height)) {
    const f = framedHeight(sp.height, win);
    hTarget = clamp(f.h, ...LIMITS.heightRange);
    if (f.why) why.push(f.why);
    up = clamp(dead(hTarget - height, DEAD.up) * GAIN.up, -LIMITS.up, LIMITS.up);
  } else why.push('no-height');

  return { raw: [0, Math.round(fwd), Math.round(up), Math.round(yaw)], why, hTarget, win };
}

/** 每一步的變化量限制（往 0 收的方向不限制，停下來要快） */
export function slew(prev, next, step = LIMITS.slew) {
  return next.map((v, i) => {
    const p = prev[i] || 0;
    if (Math.abs(v) < Math.abs(p) && Math.sign(v) !== -Math.sign(p)) return v;
    return clamp(v, p - step, p + step);
  });
}
