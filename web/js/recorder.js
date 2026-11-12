// 拍照（canvas → PNG）與錄影（canvas.captureStream → MediaRecorder → WebM）。
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function snapshot(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) { resolve(null); return; }
      const name = `tello-${stamp()}.png`;
      download(blob, name);
      resolve(name);
    }, 'image/png');
  });
}

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  get active() { return !!this.rec && this.rec.state === 'recording'; }

  static supported() {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  start() {
    if (!Recorder.supported()) throw new Error('這個瀏覽器不支援 MediaRecorder');
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const stream = this.canvas.captureStream(30);
    this.chunks = [];
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.startedAt = performance.now();
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec) { resolve(null); return; }
      const rec = this.rec;
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: 'video/webm' });
        const name = `tello-${stamp()}.webm`;
        if (blob.size) download(blob, name);
        this.rec = null;
        resolve(blob.size ? name : null);
      };
      try { rec.stop(); } catch (e) { this.rec = null; resolve(null); }
    });
  }

  elapsed() { return this.active ? (performance.now() - this.startedAt) / 1000 : 0; }
}
