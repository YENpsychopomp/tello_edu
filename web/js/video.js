// 影像播放：主要路徑 /ws/video → WebCodecs VideoDecoder（Annex B）→ canvas；
// 備援路徑 /video.mjpg（ffmpeg）→ <img> → 畫到同一個 canvas（拍照、錄影共用）。

export function webCodecsAvailable() {
  return typeof window.VideoDecoder === 'function' && window.isSecureContext;
}

export class VideoPlayer {
  constructor(canvas, img, { onStatus, onFirstFrame }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.img = img;
    this.onStatus = onStatus || (() => {});
    this.onFirstFrame = onFirstFrame || (() => {});
    this.mode = null;          // 'webcodecs' | 'mjpeg' | null
    this.ws = null;
    this.decoder = null;
    this.codec = null;
    this.waitKey = true;
    this.errors = 0;
    this.frames = 0;
    this.hasFrame = false;
    this.ts = 0;
    this._raf = 0;
    this._watchdog = 0;
    this.preference = 'auto';
  }

  get running() { return this.mode !== null; }

  start(preference = 'auto') {
    this.stop();
    this.preference = preference;
    if (preference !== 'mjpeg' && webCodecsAvailable()) this._startWebCodecs();
    else if (preference === 'webcodecs') this.onStatus('error', '這個瀏覽器不支援 WebCodecs（請用 Chrome / Edge，並以 http://localhost 開啟）');
    else this._startMjpeg('瀏覽器不支援 WebCodecs，改用 MJPEG');
  }

  stop() {
    this.mode = null;
    clearTimeout(this._watchdog);
    cancelAnimationFrame(this._raf);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (e) {} this.ws = null; }
    this._closeDecoder();
    this.img.removeAttribute('src');
    this.hasFrame = false;
    this.frames = 0;
  }

  // ---------------- WebCodecs ----------------
  _startWebCodecs() {
    this.mode = 'webcodecs';
    this.waitKey = true;
    this.errors = 0;
    this.onStatus('loading', '等待第一個關鍵幀（IDR）…');
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/video`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws || this.mode !== 'webcodecs') return;
      this.onStatus('loading', '影像連線中斷，重新連線…');
      setTimeout(() => { if (this.mode === 'webcodecs' && this.ws === ws) this._startWebCodecs(); }, 1000);
    };
    this._armWatchdog(8000);
  }

  _armWatchdog(ms) {
    clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (this.mode === 'webcodecs' && !this.hasFrame && this.preference === 'auto') {
        this._startMjpeg('WebCodecs 一直沒有畫面，改用 MJPEG 備援');
      } else if (this.mode === 'webcodecs' && !this.hasFrame) {
        this.onStatus('loading', '還沒有收到影像。若持續沒有畫面，請開診斷頁檢查 UDP 11111');
      }
    }, ms);
  }

  async _configure(codec) {
    try {
      const cfg = { codec, optimizeForLatency: true };
      const sup = await VideoDecoder.isConfigSupported(cfg);
      if (!sup.supported) throw new Error(`不支援 ${codec}`);
      this._closeDecoder();
      this.decoder = new VideoDecoder({
        output: (frame) => this._draw(frame),
        error: (e) => this._decoderError(e),
      });
      this.decoder.configure(cfg);
      this.codec = codec;
      this.waitKey = true;
    } catch (e) {
      this._fallback(`WebCodecs 無法解碼（${e.message || e}）`);
    }
  }

  _onMessage(data) {
    if (typeof data === 'string') {
      try {
        const m = JSON.parse(data);
        if (m.t === 'config' && m.codec && m.codec !== this.codec) this._configure(m.codec);
      } catch (e) {}
      return;
    }
    const d = this.decoder;
    if (!d || d.state !== 'configured') return;
    const u8 = new Uint8Array(data);
    const key = (u8[0] & 1) === 1;
    if (this.waitKey && !key) return;
    if (d.decodeQueueSize > 4 && !key) { this.waitKey = true; return; }   // 解碼跟不上：丟到下一個 IDR
    this.waitKey = false;
    this.ts += 33333;
    try {
      d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.ts, data: u8.subarray(1) }));
    } catch (e) {
      this._decoderError(e);
    }
  }

  _draw(frame) {
    try {
      const w = frame.displayWidth, h = frame.displayHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      this.ctx.drawImage(frame, 0, 0, w, h);
      this.frames++;
      if (!this.hasFrame) { this.hasFrame = true; this.onFirstFrame(this.mode); this.onStatus('playing', ''); }
    } finally {
      frame.close();
    }
  }

  _decoderError(e) {
    this.errors++;
    if (this.errors >= 3) { this._fallback(`WebCodecs 解碼錯誤（${e && e.message ? e.message : e}）`); return; }
    const codec = this.codec;
    this.codec = null;
    if (codec) this._configure(codec);
  }

  _fallback(reason) {
    if (this.preference === 'auto') this._startMjpeg(`${reason}，改用 MJPEG 備援`);
    else { this.onStatus('error', reason); }
  }

  _closeDecoder() {
    if (this.decoder) { try { this.decoder.close(); } catch (e) {} }
    this.decoder = null;
    this.codec = null;
  }

  // ---------------- MJPEG 備援 ----------------
  _startMjpeg(reason) {
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (e) {} this.ws = null; }
    this._closeDecoder();
    clearTimeout(this._watchdog);
    this.mode = 'mjpeg';
    this.hasFrame = false;
    this.onStatus('loading', reason || 'MJPEG 載入中…');
    this.img.onerror = () => {
      if (this.mode === 'mjpeg') this.onStatus('error', 'MJPEG 備援無法使用（伺服器沒有 ffmpeg？）');
    };
    this.img.src = `/video.mjpg?t=${Date.now()}`;
    const loop = () => {
      if (this.mode !== 'mjpeg') return;
      const im = this.img;
      if (im.complete && im.naturalWidth) {
        if (this.canvas.width !== im.naturalWidth || this.canvas.height !== im.naturalHeight) {
          this.canvas.width = im.naturalWidth; this.canvas.height = im.naturalHeight;
        }
        try { this.ctx.drawImage(im, 0, 0); } catch (e) {}
        this.frames++;
        if (!this.hasFrame) { this.hasFrame = true; this.onFirstFrame('mjpeg'); this.onStatus('playing', ''); }
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
}
