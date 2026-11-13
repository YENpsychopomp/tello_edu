// 從 MediaPipe 33 點姿勢算出人的框、軀幹長度、估計距離。純函式（Node 單元測試直接用）。
//
// 座標：x、y 都是 0–1（相對影像寬、高），y 向下。aspect = 影像寬 / 高（Tello 960×720 = 4/3）。
// 左右一律指「被拍的人自己的」左右（MediaPipe 的 LEFT_* 是人自己的左邊）。

export const LM = {
  NOSE: 0, L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
};

export const VIS = 0.5;          // 可見度門檻

// Tello 鏡頭：對角 82.6°，4:3 → 垂直視角約 55.6°。2·tan(垂直半角) ≈ 1.055
export const CAM_VSPAN = 1.055;
export const TORSO_M = 0.5;      // 成人肩膀中點到髖部中點約 0.5 m
export const SHOULDER_M = 0.36;  // 兩肩關節點距離約 0.36 m（側身時會變小 → 只用來判斷「太近」）

export const visible = (p) => !!p && (p.visibility === undefined || p.visibility >= VIS);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// 以「影像高度」為單位的距離（x 方向乘上寬高比）
export function spanH(a, b, aspect) {
  const dx = (a.x - b.x) * aspect, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/**
 * 把一組 landmarks 轉成人物描述；看不到肩膀就回傳 null（無法可靠追蹤）。
 * @returns {{box:{x0,y0,x1,y1}, cx, cy, h, torso:number|null, shoulder:number,
 *            dist:number|null, distMin:number, lms:Array}}
 */
export function describePerson(lms, aspect = 4 / 3) {
  if (!Array.isArray(lms) || lms.length < 29) return null;
  const ls = lms[LM.L_SHOULDER], rs = lms[LM.R_SHOULDER];
  if (!visible(ls) || !visible(rs)) return null;

  let x0 = 1, y0 = 1, x1 = 0, y1 = 0, n = 0;
  for (const p of lms) {
    if (!visible(p)) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    n++;
  }
  if (n < 4) return null;
  // landmarks 是關節點，頭頂與身體外緣再往外留一點
  const padX = (x1 - x0) * 0.12 + 0.01, padY = (y1 - y0) * 0.08 + 0.01;
  const box = { x0: Math.max(0, x0 - padX), y0: Math.max(0, y0 - padY * 1.6), x1: Math.min(1, x1 + padX), y1: Math.min(1, y1 + padY) };

  const sm = mid(ls, rs);
  const shoulder = spanH(ls, rs, aspect);
  const lh = lms[LM.L_HIP], rh = lms[LM.R_HIP];
  let torso = null, anchor = sm;
  if (visible(lh) && visible(rh)) {
    const hm = mid(lh, rh);
    torso = spanH(sm, hm, aspect);
    anchor = mid(sm, hm);       // 軀幹中心：比整個框穩定（手舉起來不會影響）
  }
  // 濾掉誤偵測：框太小（6 m 外的人全身也還有 0.25 個影像高），或肩膀、軀幹都擠成一點
  if (box.y1 - box.y0 < 0.08 || (shoulder < 0.02 && (torso ?? 0) < 0.03)) return null;
  // 鼻子在肩膀下面＝不是站著的人（常見於兩個人之間的縫隙被當成一個人）
  const nose = lms[LM.NOSE];
  if (visible(nose) && nose.y >= sm.y) return null;
  const dist = torso && torso > 0.01 ? TORSO_M / (torso * CAM_VSPAN) : null;
  // 肩寬只會在側身時變小 → 用它估出來的距離「只會偏遠」。所以它只拿來判斷「至少這麼近」
  const distMin = shoulder > 0.01 ? SHOULDER_M / (shoulder * CAM_VSPAN) : Infinity;
  return {
    box, cx: anchor.x, cy: anchor.y, h: box.y1 - box.y0, torso, shoulder,
    dist, distMin, lms,
  };
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return ua > 0 ? inter / ua : 0;
}

export const inBox = (b, x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
