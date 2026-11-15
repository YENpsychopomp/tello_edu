// 觸控虛擬搖桿（手機／平板）：影像左右下角各一個拇指區，按下的位置就是中心，拖多遠＝推多少。
// 輸出和鍵盤／手把一樣的 sticks {lx, ly, rx, ry, active}，交給 main.js 的輸入迴圈；放開立刻歸零。
// 純邏輯的部分（pointer 座標 → 搖桿值）抽成 stickValue，給 Node 測試。
export const TOUCH = Object.freeze({ radius: 70, dead: 0.08 });

/** 指頭離中心 (dx, dy) 像素 → −1..1 的搖桿值（死區內 0，超過半徑夾到 1） */
export function stickValue(dx, dy, radius = TOUCH.radius, dead = TOUCH.dead) {
  const r = Math.hypot(dx, dy);
  if (!(r > 0)) return { x: 0, y: 0 };
  const n = Math.min(1, r / radius);
  if (n <= dead) return { x: 0, y: 0 };
  const k = (n - dead) / (1 - dead) / r;      // 死區外重新縮放到 0–1
  return { x: dx * k, y: dy * k };
}

export class TouchSticks {
  /**
   * @param left  左半邊的觸控區元素（升降／轉向）
   * @param right 右半邊的觸控區元素（前後／左右）
   */
  constructor(left, right, { onTap = null } = {}) {
    this.onTap = onTap;
    this.zones = { left, right };
    this.active = { left: null, right: null };     // { id, x0, y0, dot }
    this.sticks = { lx: 0, ly: 0, rx: 0, ry: 0 };
    this.enabled = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    for (const side of ['left', 'right']) {
      const el = this.zones[side];
      if (!el) continue;
      el.addEventListener('pointerdown', (e) => this._down(side, e));
      el.addEventListener('pointermove', (e) => this._move(side, e));
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, (e) => this._up(side, e));
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.clear(); });
  }

  _down(side, e) {
    if (!this.enabled || this.active[side]) return;
    e.preventDefault();
    const el = this.zones[side];
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    this.active[side] = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false };
    el.classList.add('on');
    this._place(side, 0, 0);
  }

  _move(side, e) {
    const a = this.active[side];
    if (!a || a.id !== e.pointerId) return;
    e.preventDefault();
    const v = stickValue(e.clientX - a.x0, e.clientY - a.y0);
    if (v.x || v.y) a.moved = true;
    if (side === 'left') { this.sticks.lx = v.x; this.sticks.ly = v.y; } else { this.sticks.rx = v.x; this.sticks.ry = v.y; }
    this._place(side, v.x, v.y);
  }

  _up(side, e) {
    const a = this.active[side];
    if (!a || (e && e.pointerId !== undefined && a.id !== e.pointerId)) return;
    this.active[side] = null;
    this.zones[side].classList.remove('on');
    // 短按、沒有推動 → 當成點一下（跟隨模式用來選人），不算搖桿輸入
    if (e && !a.moved && performance.now() - a.t0 < 300 && this.onTap) this.onTap(e.clientX, e.clientY);
    if (side === 'left') { this.sticks.lx = 0; this.sticks.ly = 0; } else { this.sticks.rx = 0; this.sticks.ry = 0; }
    this._place(side, 0, 0);
  }

  _place(side, x, y) {
    const el = this.zones[side];
    const a = this.active[side];
    const dot = el.querySelector('.tdot'), ring = el.querySelector('.tring');
    if (ring && a) {
      const r = el.getBoundingClientRect();
      ring.style.left = `${a.x0 - r.left}px`; ring.style.top = `${a.y0 - r.top}px`;
    }
    if (dot) dot.style.transform = `translate(${x * TOUCH.radius}px, ${y * TOUCH.radius}px)`;
  }

  clear() {
    for (const side of ['left', 'right']) if (this.active[side]) this._up(side, null);
  }

  /** 和 KeyboardInput.sticks() 相同的介面 */
  read() {
    const s = this.sticks;
    return { ...s, active: !!(this.active.left || this.active.right) };
  }
}
