// Gamepad API 讀取：標準 mapping 的按鍵索引、邊緣偵測、組合鍵。
import { shape } from './curve.js';

export const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

const down = (gp, i) => {
  const b = gp && gp.buttons && gp.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
};

export class GamepadInput {
  constructor() {
    this.prev = [];
    this.prevCombo = false;
    this.index = null;
  }

  static list() {
    try {
      return navigator.getGamepads ? Array.from(navigator.getGamepads()).filter((p) => p && p.connected) : [];
    } catch (e) {
      return [];
    }
  }

  pick() {
    const pads = GamepadInput.list();
    return pads.find((p) => p.mapping === 'standard') || pads[0] || null;
  }

  poll(dz, ex) {
    const gp = this.pick();
    const res = {
      gp, connected: !!gp, id: gp ? gp.id : '', mapping: gp ? gp.mapping : '',
      sticks: { lx: 0, ly: 0, rx: 0, ry: 0 }, raw: { lx: 0, ly: 0, rx: 0, ry: 0 },
      speed: 'normal', edges: new Set(), emergency: false, held: (i) => down(gp, i),
    };
    if (!gp) {
      this.index = null;
      this.prev = [];
      this.prevCombo = false;
      return res;
    }
    const states = gp.buttons.map((_, i) => down(gp, i));
    if (this.index !== gp.index) {
      // 換了一支手把：用目前狀態當基準，避免剛接上就誤觸發
      this.index = gp.index;
      this.prev = states;
      this.prevCombo = down(gp, BTN.LB) && down(gp, BTN.RB);
    }
    states.forEach((s, i) => { if (s && !this.prev[i]) res.edges.add(i); });
    this.prev = states;

    const combo = down(gp, BTN.LB) && down(gp, BTN.RB);
    res.emergency = combo && !this.prevCombo;
    this.prevCombo = combo;

    const ax = gp.axes || [];
    res.raw = { lx: ax[0] || 0, ly: ax[1] || 0, rx: ax[2] || 0, ry: ax[3] || 0 };
    res.sticks = {
      lx: shape(res.raw.lx, dz, ex), ly: shape(res.raw.ly, dz, ex),
      rx: shape(res.raw.rx, dz, ex), ry: shape(res.raw.ry, dz, ex),
    };
    if (down(gp, BTN.LT)) res.speed = 'fine';
    else if (down(gp, BTN.RT)) res.speed = 'full';
    return res;
  }
}

export function rumble(gp, pattern) {
  // 回傳 true 表示有震動；不支援時回傳 false 讓呼叫端改用視覺回饋
  try {
    const act = gp && gp.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return false;
    const p = {
      takeoff: [{ duration: 180, strongMagnitude: 0.4, weakMagnitude: 0.6 }],
      land: [{ duration: 260, strongMagnitude: 0.5, weakMagnitude: 0.3 }],
      tap: [{ duration: 80, strongMagnitude: 0.0, weakMagnitude: 0.5 }],
      warn: [{ duration: 160, strongMagnitude: 0.5, weakMagnitude: 0.5 }, { startDelay: 220, duration: 160, strongMagnitude: 0.5, weakMagnitude: 0.5 }],
      danger: [{ duration: 600, strongMagnitude: 1.0, weakMagnitude: 1.0 }],
    }[pattern] || [{ duration: 120, strongMagnitude: 0.3, weakMagnitude: 0.3 }];
    let t = 0;
    for (const e of p) {
      t += e.startDelay || 0;
      const eff = { startDelay: 0, duration: e.duration, strongMagnitude: e.strongMagnitude, weakMagnitude: e.weakMagnitude };
      setTimeout(() => { act.playEffect('dual-rumble', eff).catch(() => {}); }, t);
    }
    return true;
  } catch (e) {
    return false;
  }
}
