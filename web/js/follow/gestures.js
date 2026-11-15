// 手勢（用手臂姿勢，不用手指）：無人機通常離人 2–5 m，手指在 960×720 畫面上只有十幾個像素，
// 手指手勢辨識不可靠；手臂姿勢在這個距離很穩定。左右一律是「被拍的人自己的」左右。
//
//   舉右手（有舉的意圖就算：手腕高於肩膀一截、在手肘上方、手臂偏直立，不必舉過頭） → up       升高
//   舉左手（同上）    → down     降低
//   雙手舉起（Y）     → farther  拉遠
//   雙手在胸前交叉    → closer   靠近
//   雙手側平舉（T：手臂接近水平、伸出去） → pause    暫停／恢復跟隨（暫停時原地懸停，仍持續追蹤）
//   手臂向前伸＋手掌張開 → palm 停到手上（需要手部模型判斷手掌張開，見 palm.js）
//
// 判斷用角度而不是絕對高度：舉手＝手臂比較接近直立（> 約 40°），T 字＝接近水平（< 約 27°），
// 所以斜斜舉到一半也算舉手、略高於肩的側平舉還是 T 字，兩者不會互相誤判。
import { LM, visible } from './geometry.js';

export const GESTURES = {
  up: { label: '升高', how: '舉右手過頭' },
  down: { label: '降低', how: '舉左手過頭' },
  farther: { label: '拉遠', how: '雙手高舉過頭' },
  closer: { label: '靠近', how: '雙手在胸前交叉' },
  pause: { label: '暫停／恢復', how: '雙手側平舉（T 字）' },
  palm: { label: '停到手上', how: '手臂向前伸、手掌張開' },
};

/** 單一幀的姿勢分類；看不清楚就回傳 null */
export function classifyPose(lms, aspect = 4 / 3) {
  if (!Array.isArray(lms) || lms.length < 25) return null;
  const P = (i) => lms[i];
  const ls = P(LM.L_SHOULDER), rs = P(LM.R_SHOULDER), nose = P(LM.NOSE);
  if (!visible(ls) || !visible(rs)) return null;
  const sw = Math.abs(ls.x - rs.x) * aspect;                       // 肩寬（影像高度單位）
  const lh = P(LM.L_HIP), rh = P(LM.R_HIP);
  const torso = visible(lh) && visible(rh) ? ((lh.y + rh.y) - (ls.y + rs.y)) / 2 : sw * 1.4;
  const unit = Math.max(0.02, Math.max(sw, torso * 0.7));
  const shY = (ls.y + rs.y) / 2;
  const headY = visible(nose) ? nose.y : shY - unit * 0.6;

  const lw = P(LM.L_WRIST), rw = P(LM.R_WRIST), le = P(LM.L_ELBOW), re = P(LM.R_ELBOW);
  const lwOk = visible(lw), rwOk = visible(rw);
  // 舉手的意圖：手腕比肩膀高 0.3 單位以上、在手肘上方，而且手臂偏直立（垂直分量 > 橫向分量 × 0.85 ≈ 40° 以上）
  const raised = (w, s, e) => {
    const up = s.y - w.y, side = Math.abs(w.x - s.x) * aspect;
    return up > unit * 0.3 && up > side * 0.85 && (!visible(e) || w.y < e.y);
  };
  const lUp = lwOk && raised(lw, ls, le), rUp = rwOk && raised(rw, rs, re);
  void headY;
  // 手放下：手腕低於肩膀（看不到也算放下）
  const lDown = !lwOk || lw.y > shY + unit * 0.2;
  const rDown = !rwOk || rw.y > shY + unit * 0.2;

  if (lUp && rUp) return 'farther';
  if (rUp && lDown) return 'up';
  if (lUp && rDown) return 'down';

  if (lwOk && rwOk) {
    const midX = (ls.x + rs.x) / 2;
    // T 字：手伸出去（橫向 > 0.8 單位）而且接近水平（垂直偏差 < 橫向的一半 ≈ 27° 以內），手肘也差不多在肩膀高度
    const out = (w, s, e) => {
      const side = Math.abs(w.x - s.x) * aspect;
      return side > unit * 0.8 && Math.abs(w.y - s.y) < Math.max(unit * 0.25, side * 0.5)
        && Math.sign(w.x - midX) === Math.sign(s.x - midX)
        && (!visible(e) || Math.abs(e.y - s.y) < unit * 0.6);
    };
    if (out(lw, ls, le) && out(rw, rs, re)) return 'pause';

    // 交叉：兩手腕都在肩膀到髖部之間、而且左右交換（左手腕跑到身體右側）
    const hipY = shY + torso;
    const chest = (w) => w.y > shY - unit * 0.1 && w.y < hipY;
    const crossed = Math.sign(lw.x - rw.x) !== Math.sign(ls.x - rs.x);
    if (chest(lw) && chest(rw) && crossed && Math.abs(lw.x - rw.x) * aspect < sw * 1.2) return 'closer';
  }
  return null;
}

/**
 * 手勢要「維持一段時間」才算數，避免揮手、轉身時誤觸發。
 * 升高／降低／拉遠／靠近維持不放會每 repeatMs 重複一次；暫停、停到手上必須放下手再做一次才會再觸發。
 */
export class GestureLatch {
  constructor({ holdMs = 500, repeatMs = 1100, minFrames = 3 } = {}) {
    Object.assign(this, { holdMs, repeatMs, minFrames });
    this.reset();
  }

  reset() { this.cur = null; this.since = 0; this.frames = 0; this.fired = 0; this.miss = 0; }

  /** 每次有新的偵測結果就呼叫；回傳這一次觸發的手勢（大多數時候是 null） */
  feed(g, now) {
    if (g !== this.cur) {
      // 偶爾一幀判斷失敗不要整個重來
      if (g === null && this.cur !== null && this.miss < 2) { this.miss++; return null; }
      this.cur = g; this.since = now; this.frames = 0; this.fired = 0; this.miss = 0;
    }
    this.miss = 0;
    if (g === null) return null;
    this.frames++;
    if (now - this.since < this.holdMs || this.frames < this.minFrames) return null;
    if (!this.fired) { this.fired = now; return g; }
    if (g !== 'pause' && g !== 'palm' && now - this.fired >= this.repeatMs) { this.fired = now; return g; }
    return null;
  }

  /** 正在累積中的手勢與進度（0–1），給畫面顯示 */
  pending(now) {
    if (!this.cur || this.fired) return null;
    return { g: this.cur, p: Math.min(1, (now - this.since) / this.holdMs) };
  }
}
