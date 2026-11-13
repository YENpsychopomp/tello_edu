// 多人追蹤：每一幀的偵測結果 → 穩定的編號（#1、#2…），讓使用者選定「要跟誰」。
// 配對成本＝中心距離（以人的高度正規化）＋大小差異＋衣服顏色差異；貪婪配對。純邏輯，時間由呼叫端傳入。

export const TRACK_DROP_MS = 1500;   // 一般人消失多久就移除
export const TARGET_KEEP_MS = 3000;  // 被跟隨的目標消失後保留多久（期間可以自動找回）
export const GAP_MS = 450;           // 超過這麼久沒看到 → 再出現時算「找回」

// 顏色直方圖相似度（Bhattacharyya 係數，0–1；任一邊沒有特徵就回傳 null）
export function featSim(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]);
  return s;
}

function cost(track, det) {
  const scale = Math.max(0.08, (track.h + det.h) / 2);
  const d = Math.hypot(track.cx - det.cx, track.cy - det.cy) / scale;
  const size = Math.abs(Math.log(Math.max(1e-3, det.h) / Math.max(1e-3, track.h)));
  const sim = featSim(track.feat, det.feat);
  return { d, total: d + size * 0.8 + (sim === null ? 0 : (1 - sim) * 1.5), sim };
}

export class Tracker {
  constructor() {
    this.tracks = [];
    this.nextId = 1;
    this.targetId = null;
  }

  get target() { return this.tracks.find((t) => t.id === this.targetId) || null; }

  reset() { this.tracks = []; this.targetId = null; }

  /** 偵測暫停了 ms（例如切到下視鏡頭）：時間往後推，暫停期間不算遺失 */
  shift(ms) {
    if (!(ms > 0)) return;
    for (const t of this.tracks) t.seen += ms;
  }

  /** @param dets describePerson() 的結果（可帶 feat） @param now 毫秒 */
  update(dets, now) {
    const pairs = [];
    this.tracks.forEach((t, ti) => dets.forEach((d, di) => {
      const c = cost(t, d);
      // 閘門：離太遠，或衣服顏色明顯不同 → 不可能是同一個人。消失一陣子的人改用比較嚴格的「找回」條件
      const ok = now - t.seen > GAP_MS ? this._reacquire(t, d) : c.d < 1.2 && (c.sim === null || c.sim > 0.45);
      if (ok) pairs.push({ ti, di, c: c.total });
    }));
    pairs.sort((a, b) => a.c - b.c);
    const usedT = new Set(), usedD = new Set();
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedD.has(p.di)) continue;
      usedT.add(p.ti); usedD.add(p.di);
      this._assign(this.tracks[p.ti], dets[p.di], now);
    }

    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      usedD.add(di);
      const t = { id: this.nextId++, born: now, hits: 0, feat: null, reacquired: 0 };
      this._assign(t, d, now);
      this.tracks.push(t);
    });

    this.tracks = this.tracks.filter((t) => {
      const age = now - t.seen;
      if (t.id === this.targetId) return age <= TARGET_KEEP_MS;
      return age <= TRACK_DROP_MS;
    });
    if (this.targetId !== null && !this.target) this.targetId = null;
    return this.visible(now);
  }

  _reacquire(t, d) {
    const scale = Math.max(0.08, t.h);
    const near = Math.hypot(t.cx - d.cx, t.cy - d.cy) / scale < 2.0;
    const ratio = d.h / Math.max(1e-3, t.h);
    const sim = featSim(t.feat, d.feat);
    return near && ratio > 0.6 && ratio < 1.6 && (sim === null || sim > 0.7);
  }

  _assign(t, d, now) {
    if (t.hits && now - t.seen > GAP_MS) t.reacquired = now;
    const a = t.hits ? 0.6 : 1;                 // 位置做一點平滑，降低框框抖動
    const lerp = (o, n) => (o === undefined ? n : o + (n - o) * a);
    t.cx = lerp(t.cx, d.cx); t.cy = lerp(t.cy, d.cy); t.h = lerp(t.h, d.h);
    t.box = d.box; t.lms = d.lms; t.torso = d.torso; t.shoulder = d.shoulder;
    t.dist = d.dist === null ? null : (t.dist == null ? d.dist : t.dist + (d.dist - t.dist) * 0.5);
    t.distMin = d.distMin;
    if (d.feat) t.feat = t.feat ? t.feat.map((v, i) => v * 0.85 + d.feat[i] * 0.15) : d.feat.slice();
    t.seen = now;
    t.hits++;
  }

  /** 目前畫面上看得到的人（剛出現 1 幀的先不算，避免誤偵測閃一下），由左到右排序 */
  visible(now) {
    return this.tracks.filter((t) => t.seen === now && (t.hits >= 2 || t.id === this.targetId))
      .sort((a, b) => a.cx - b.cx);
  }

  select(id) {
    this.targetId = this.tracks.some((t) => t.id === id) ? id : null;
    return this.targetId;
  }

  /** 依畫面左右順序切換目標：dir = +1 下一個（往右）、-1 上一個 */
  cycle(dir, now) {
    const vis = this.visible(now);
    if (!vis.length) return null;
    const i = vis.findIndex((t) => t.id === this.targetId);
    const next = i < 0 ? (dir > 0 ? 0 : vis.length - 1) : (i + dir + vis.length) % vis.length;
    this.targetId = vis[next].id;
    return this.targetId;
  }
}
