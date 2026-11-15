// /ws/control：rc（上行 30 Hz）＋遙測（下行 10 Hz）＋指令結果。自動重連。
export class ControlSocket {
  constructor(path, { onMessage, onState }) {
    this.path = path;
    this.onMessage = onMessage;
    this.onState = onState || (() => {});
    this.ws = null;
    this.state = 'connecting';
    this.everOpen = false;
    this.backoff = 300;
    this.nextId = 1;
    this.pending = new Map();
    setTimeout(() => this.connect(), 0);   // 讓呼叫端先完成初始化，再觸發 onState
  }

  get open() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${this.path}`;
    this._set('connecting');
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.backoff = 300; this.everOpen = true; this._set('open'); };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id != null && this.pending.has(m.id) && (m.t === 'res' || m.t === 'mission_check' || m.t === 'mission_res')) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve(m);
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this._set('closed');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ t: 'res', id, cmd: p.cmd, resp: 'network error', kind: 'error', local: true });
      }
      this.pending.clear();
      this._retry();
    };
    ws.onerror = () => {};
  }

  _retry() {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(3000, this.backoff * 1.7);
  }

  _set(s) { this.state = s; this.onState(s); }

  send(obj) {
    if (!this.open) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  /** 任意帶 id 的請求（任務腳本的 check / start / abort）；斷線或逾時回 { ok: false, errors: [...] , local: true }。 */
  request(obj, timeoutMs = 5000) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      if (!this.send({ ...obj, id })) {
        resolve({ t: 'mission_res', id, ok: false, errors: ['本機程式未連線'], local: true });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ t: 'mission_res', id, ok: false, errors: ['地面站程式沒有回應'], local: true });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, cmd: obj.t });
    });
  }

  cmd(cmd, timeoutMs = 16000) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      if (!this.send({ t: 'cmd', cmd, id })) {
        resolve({ t: 'res', id, cmd, resp: '本機程式未連線', kind: 'error', local: true });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ t: 'res', id, cmd, resp: 'timeout', kind: 'timeout', local: true });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, cmd });
    });
  }
}
