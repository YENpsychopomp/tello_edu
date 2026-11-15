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
  yaw: 50, fwd: 45, fwdFar: 60, fwdVeryFar: 70, back: 60, up: 40, // rc 上限（-100..100）；後退 60：人朝無人機走來時要退得比他快
  fwdNear: 18,                        // 1.5 m 以內的前進上限；1.5–2.5 m 為 fwd；2.5–3.8 m fwdFar；更遠 fwdVeryFar（追得上快步走的人）
  slew: 9,                            // 每次（30 Hz）最多變化多少
  minDist: 0.4,                       // 比這更近 → 強制後退
  distRange: [0.5, 6.0],              // 可設定的距離（m）
  heightRange: [60, 300],             // 可設定的高度（cm）
  distStep: 0.5, heightStep: 30,      // 每次手勢調整量
});

// 手臂可見的構圖：舉手時手腕約在肩膀上方 1.45 個軀幹長（手臂約 0.72 m，軀幹約 0.5 m）；
// 胸前交叉／T 字需要看到肩膀到髖部。上下各留 6% 的邊。
export const FRAME = Object.freeze({ margin: 0.06, reach: 1.45 });

const GAIN = { yaw: 170, yawD: 55, yawI: 90, yawIMax: 22, fwd: 50, fwdV: 36, fwdVMax: 20, fwdI: 36, fwdIMax: 30, fwdVDead: 0.12, up: 0.55 };
// fwdI：距離積分（人等速走來／走開時消除穩態誤差），有上限、誤差換邊或進死區就放掉；fwdVDead：速度前饋的死區（量測雜訊）
// fwdV：目標距離變化率（m/s，估計器給的）的前饋——人走開就先加速、走近就先減速，不等誤差累積
// yawD：目標在畫面上的橫向速度（畫面寬/秒）的前饋／阻尼；yawI：積分（消除目標等速橫移時的穩態落後），有上限
const DEAD = { yaw: 0.03, fwd: 0.1, up: 8 };

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
 * @param opts    {vx?: 目標橫向速度（畫面寬/秒，估計器給的），gain?: 0.4–1 增益縮放（偵測 fps 低、延遲大時調小），
 *                 integ?: 上一拍的轉向積分（rc），dt?: 距上一拍幾秒（給積分用；不給就不積分），vd?: 目標距離變化率（m/s）}
 *                 gain 只作用在轉向（前後不縮）
 * @returns {{raw:number[], why:string[], hTarget:number|null, win:object|null, integ:number, integD:number}}  raw＝還沒做變化量限制的 rc
 */
export function followRc(target, sp, height, opts = {}) {
  const why = [];
  if (!target) return { raw: [0, 0, 0, 0], why: ['no-target'], hTarget: null, win: null, integ: 0, integD: 0 };
  let integD = Number.isFinite(opts.integD) ? opts.integD : 0;
  const gain = clamp(Number.isFinite(opts.gain) ? opts.gain : 1, 0.3, 1);
  const vx = Number.isFinite(opts.vx) ? clamp(opts.vx, -1, 1) : 0;

  const ex = target.cx - 0.5;
  // PID：比例項對準；速度項在目標橫移時提早跟（前饋）、機身轉向時減速（阻尼）；
  // 積分項消除目標等速橫移時的穩態落後（有上限、誤差換邊就放掉，避免累積過頭）
  const pTerm = dead(ex, DEAD.yaw) * GAIN.yaw;
  let dTerm = vx * GAIN.yawD;
  // 阻尼只能減速，不能把方向反過來（否則目標在右邊、機身正在右轉時會突然左轉）
  if (pTerm !== 0 && Math.sign(dTerm) === -Math.sign(pTerm)) dTerm = Math.sign(dTerm) * Math.min(Math.abs(dTerm), Math.abs(pTerm) * 0.8);
  let integ = Number.isFinite(opts.integ) ? opts.integ : 0;
  if (Number.isFinite(opts.dt) && opts.dt > 0 && opts.dt < 1) {
    if (pTerm === 0 || Math.sign(pTerm) !== Math.sign(integ)) integ *= 0.8;          // 對準了／換邊 → 放掉
    integ = clamp(integ + dead(ex, DEAD.yaw) * GAIN.yawI * opts.dt, -GAIN.yawIMax, GAIN.yawIMax);
  }
  let yaw = clamp((pTerm + dTerm + integ) * gain, -LIMITS.yaw, LIMITS.yaw);
  if (Math.abs(ex) <= DEAD.yaw && Math.abs(vx) < 0.05 && Math.abs(integ) < 1) yaw = 0;

  let fwd = 0;
  if (Number.isFinite(target.distMin) && target.distMin < LIMITS.minDist) {
    fwd = -25; why.push('too-close');
  } else if (Number.isFinite(target.dist)) {
    if (target.dist < LIMITS.minDist) { fwd = -25; why.push('too-close'); }
    else {
      const cap = target.dist < 1.5 ? LIMITS.fwdNear : target.dist < 2.5 ? LIMITS.fwd : target.dist < 3.8 ? LIMITS.fwdFar : LIMITS.fwdVeryFar;
      const vd0 = Number.isFinite(opts.vd) ? dead(opts.vd, GAIN.fwdVDead) : 0;
      const vd = clamp(vd0 * GAIN.fwdV, -GAIN.fwdVMax, GAIN.fwdVMax);
      const e = dead(target.dist - sp.dist, DEAD.fwd);
      if (Number.isFinite(opts.dt) && opts.dt > 0 && opts.dt < 1) {
        if (e === 0 || Math.sign(e) !== Math.sign(integD)) integD *= 0.8;
        integD = clamp(integD + e * GAIN.fwdI * opts.dt, -GAIN.fwdIMax, GAIN.fwdIMax);
      }
      // 前後的增益只隨 fps 小幅縮（0.6–1 倍）：縮太多追不上走動的人，不縮在延遲很大時會前後擺
      fwd = clamp(e * GAIN.fwd * (0.6 + 0.4 * gain) + vd + integD * gain, -LIMITS.back, cap);
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

  return { raw: [0, Math.round(fwd), Math.round(up), Math.round(yaw)], why, hTarget, win, integ, integD };
}

/**
 * 擺盪偵測：影像延遲在真機上量不到，延遲太大時固定增益會讓機身左右來回擺。
 * 轉向指令在 windowMs 內大幅（|rc| > big）換向 flips 次以上 → 增益因子乘 shrink（最低 min），之後每秒慢慢恢復。
 * 前後軸也用同一個因子。純邏輯。
 */
export class OscillationGuard {
  constructor({ windowMs = 3000, flips = 3, big = 20, shrink = 0.75, min = 0.4, recoverPerSec = 0.03 } = {}) {
    Object.assign(this, { windowMs, flips, big, shrink, min, recoverPerSec });
    this.reset();
  }

  reset() { this.factor = 1; this.sign = 0; this.times = []; this.last = 0; this.trips = 0; }

  /** @param yaw 這一拍的轉向指令（未做變化量限制的 raw）@returns 增益因子 0.4–1 */
  feed(yaw, now) {
    const dt = this.last ? Math.min(1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (Math.abs(yaw) > this.big) {
      const s = Math.sign(yaw);
      if (this.sign && s !== this.sign) this.times.push(now);
      this.sign = s;
    }
    this.times = this.times.filter((t) => now - t <= this.windowMs);
    if (this.times.length >= this.flips) {
      this.factor = Math.max(this.min, this.factor * this.shrink);
      this.times = [];
      this.trips++;
    } else this.factor = Math.min(1, this.factor + this.recoverPerSec * dt);
    return this.factor;
  }
}

/** 每一步的變化量限制（往 0 收的方向不限制，停下來要快） */
export function slew(prev, next, step = LIMITS.slew) {
  return next.map((v, i) => {
    const p = prev[i] || 0;
    if (Math.abs(v) < Math.abs(p) && Math.sign(v) !== -Math.sign(p)) return v;
    return clamp(v, p - step, p + step);
  });
}
