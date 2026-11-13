// 跟隨控制器：目標的位置／距離＋目前高度 → rc [左右, 前後, 升降, 轉向]。純函式，單元測試直接驗證。
//
//   轉向：讓目標的軀幹中心保持在畫面水平中央
//   前後：讓估計距離（由軀幹長度換算）等於設定距離
//   升降：讓 Tello 回報的高度（tel.h，cm）等於設定高度
//   左右：不用（0）。只轉向不平移，行為最好預測
//
// 安全：輸出有上限、每一步變化量有上限；太近（< MIN_DIST）只會後退；看不到髖部時不會往前。

export const LIMITS = Object.freeze({
  yaw: 50, fwd: 35, up: 40,          // rc 上限（-100..100）
  slew: 9,                            // 每次（30 Hz）最多變化多少
  minDist: 1.2,                       // 比這更近 → 強制後退
  distRange: [1.5, 6.0],              // 可設定的距離（m）
  heightRange: [60, 300],             // 可設定的高度（cm）
  distStep: 0.5, heightStep: 30,      // 每次手勢調整量
});

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
 * @param target  {cx, dist|null, distMin}（null＝看不到目標）
 * @param sp      {dist, height}
 * @param height  目前高度 cm（null＝沒有遙測）
 * @returns {{raw:number[], why:string[]}}  raw＝還沒做變化量限制的 rc
 */
export function followRc(target, sp, height) {
  const why = [];
  if (!target) return { raw: [0, 0, 0, 0], why: ['no-target'] };

  const ex = target.cx - 0.5;
  let yaw = clamp(dead(ex, DEAD.yaw) * GAIN.yaw, -LIMITS.yaw, LIMITS.yaw);

  let fwd = 0;
  if (Number.isFinite(target.distMin) && target.distMin < LIMITS.minDist) {
    fwd = -25; why.push('too-close');
  } else if (Number.isFinite(target.dist)) {
    if (target.dist < LIMITS.minDist) { fwd = -25; why.push('too-close'); }
    else fwd = clamp(dead(target.dist - sp.dist, DEAD.fwd) * GAIN.fwd, -LIMITS.fwd, LIMITS.fwd);
    // 目標快跑出畫面邊緣時先轉向，前進減半
    if (fwd > 0 && Math.abs(ex) > 0.25) { fwd *= 0.5; why.push('turn-first'); }
  } else {
    why.push('no-torso');      // 看不到髖部 → 不知道多遠 → 不前進
  }

  let up = 0;
  if (Number.isFinite(height)) up = clamp(dead(sp.height - height, DEAD.up) * GAIN.up, -LIMITS.up, LIMITS.up);
  else why.push('no-height');

  return { raw: [0, Math.round(fwd), Math.round(up), Math.round(yaw)], why };
}

/** 每一步的變化量限制（往 0 收的方向不限制，停下來要快） */
export function slew(prev, next, step = LIMITS.slew) {
  return next.map((v, i) => {
    const p = prev[i] || 0;
    if (Math.abs(v) < Math.abs(p) && Math.sign(v) !== -Math.sign(p)) return v;
    return clamp(v, p - step, p + step);
  });
}
