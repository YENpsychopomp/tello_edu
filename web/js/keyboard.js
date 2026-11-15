// 鍵盤備援控制：WASD 前後左右、方向鍵 升降／轉向；動作鍵交給 onAction。
const FLIGHT = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const ACTIONS = { KeyT: 'takeoff', KeyL: 'land', KeyV: 'video', KeyP: 'photo', KeyR: 'record', KeyF: 'fullscreen', KeyG: 'follow', KeyN: 'followNext', KeyC: 'downcam', KeyM: 'mission' };

export class KeyboardInput {
  constructor(onAction, isEnabled) {
    this.held = new Set();
    this.onAction = onAction;
    this.isEnabled = isEnabled;
    addEventListener('keydown', (e) => this._down(e));
    addEventListener('keyup', (e) => this.held.delete(e.code));
    addEventListener('blur', () => this.held.clear());
    document.addEventListener('visibilitychange', () => this.held.clear());
  }

  _typing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  }

  _down(e) {
    if (e.key === 'Escape' && e.shiftKey) {        // 緊急停槳：任何狀態都有效
      e.preventDefault();
      this.onAction('emergency');
      return;
    }
    if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
      if (!this._typing(e)) { e.preventDefault(); this.onAction('help'); }
      return;
    }
    if (!this.isEnabled() || this._typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (FLIGHT.has(e.code)) {
      e.preventDefault();
      this.held.add(e.code);
      return;
    }
    if (e.repeat) return;
    const a = ACTIONS[e.code];
    if (a) { e.preventDefault(); this.onAction(a); }
  }

  sticks() {
    if (!this.isEnabled() || document.querySelector('dialog[open]')) this.held.clear();
    const h = (c) => (this.held.has(c) ? 1 : 0);
    const s = {
      rx: h('KeyD') - h('KeyA'),
      ry: h('KeyS') - h('KeyW'),
      lx: h('ArrowRight') - h('ArrowLeft'),
      ly: h('ArrowDown') - h('ArrowUp'),
    };
    return { ...s, active: this.held.size > 0 };
  }
}
