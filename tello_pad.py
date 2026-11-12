#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tello_pad.py — 用 Android 手機 + Xbox 手把控制 Tello / Tello EDU（免官方 App）

架構：
  Xbox 手把 ──藍牙──> Chrome（Gamepad API）──HTTP 127.0.0.1──> 本程式（Termux）──UDP SDK──> Tello

特色：
  * 只用 Python 標準函式庫；有裝 ffmpeg 時額外提供即時影像
  * 控制端斷訊 0.5 秒自動懸停、8 秒自動降落；Ctrl+C 結束時若在空中會先送 land
  * 自動進入 SDK 模式，換電池 / Tello 重開機後會自己重連

用法：
  python tello_pad.py          然後用 Chrome 開 http://127.0.0.1:8080

環境變數（選用）：
  TELLO_IP   預設 192.168.10.1
  HTTP_PORT  預設 8080
"""
import json
import os
import queue
import shutil
import signal
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TELLO_IP = os.environ.get("TELLO_IP", "192.168.10.1")
TELLO_CMD_ADDR = (TELLO_IP, 8889)
STATE_PORT = 8890
VIDEO_PORT = 11111
HTTP_HOST = os.environ.get("HTTP_HOST", "127.0.0.1")
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))

RC_HZ = 20            # rc 指令送出頻率
HOVER_AFTER = 0.5     # 控制頁面斷訊多久 → 自動懸停（秒）
LAND_AFTER = 8.0      # 控制頁面斷訊多久 → 自動降落（秒）
STATE_STALE = 3.0     # 多久沒收到 Tello 狀態就視為斷線並重連（秒）

# 需要等回應的指令（白名單）
ASK_CMDS = {
    "takeoff": 12.0, "streamon": 5.0, "streamoff": 5.0,
    "flip l": 5.0, "flip r": 5.0, "flip f": 5.0, "flip b": 5.0,
    "battery?": 3.0, "sdk?": 3.0, "sn?": 3.0, "wifi?": 3.0,
}
# 直接送出、不排隊不等回應（安全相關，不能被其他指令卡住）
IMMEDIATE_CMDS = {"land", "emergency"}


def log(*args):
    print(time.strftime("[%H:%M:%S]"), *args, flush=True)


class Tello:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("", 0))
        self.state_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.state_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.state_sock.bind(("", STATE_PORT))

        self.resp_q = queue.Queue()
        self.cmd_lock = threading.Lock()
        self.asking = False
        self.sdk_ok = False
        self.state = {}
        self.state_time = 0.0
        self.airborne = False
        self.rc = (0, 0, 0, 0)
        self.rc_time = 0.0
        self.last = ""
        self._net_err = None
        self._auto_land_at = 0.0

        for fn in (self._recv_resp, self._recv_state, self._keep_sdk, self._rc_loop):
            threading.Thread(target=fn, daemon=True).start()

    # ---------- 低階收送 ----------
    def send(self, cmd):
        try:
            self.sock.sendto(cmd.encode(), TELLO_CMD_ADDR)
            if self._net_err:
                log("網路恢復")
                self._net_err = None
            return True
        except OSError as e:
            if str(e) != self._net_err:
                self._net_err = str(e)
                log(f"送不出去（手機 Wi-Fi 有連到 TELLO-xxxx 嗎？）：{e}")
            return False

    def ask(self, cmd, timeout=5.0):
        with self.cmd_lock:
            self.asking = True          # 暫停 rc，避免回應對錯指令
            try:
                while True:
                    try:
                        self.resp_q.get_nowait()
                    except queue.Empty:
                        break
                if not self.send(cmd):
                    resp = "network error"
                else:
                    try:
                        resp = self.resp_q.get(timeout=timeout)
                    except queue.Empty:
                        resp = "timeout"
            finally:
                self.asking = False
        if cmd != "command":
            self.last = f"{cmd} → {resp}"
            log(self.last)
        return resp

    def _recv_resp(self):
        while True:
            try:
                data, _ = self.sock.recvfrom(1518)
            except OSError:
                time.sleep(0.1)
                continue
            self.resp_q.put(data.decode("utf-8", "replace").strip())

    def _recv_state(self):
        while True:
            try:
                data, _ = self.state_sock.recvfrom(2048)
            except OSError:
                time.sleep(0.1)
                continue
            st = {}
            for kv in data.decode("utf-8", "replace").strip().split(";"):
                if ":" in kv:
                    k, v = kv.split(":", 1)
                    st[k.strip()] = v.strip()
            self.state = st
            self.state_time = time.time()

    # ---------- 背景迴圈 ----------
    def _keep_sdk(self):
        """確保 Tello 在 SDK 模式；斷線（例如換電池）後自動重連。"""
        while True:
            stale = time.time() - self.state_time > STATE_STALE
            if not self.sdk_ok or stale:
                if self.sdk_ok:
                    log("Tello 狀態中斷，重新連線中…")
                    self.sdk_ok = False
                if self.ask("command", timeout=2.0) == "ok":
                    self.sdk_ok = True
                    self.state_time = time.time()
                    log("已連上 Tello（SDK 模式）")
            time.sleep(1.0)

    def height(self):
        try:
            return int(self.state.get("h", "0"))
        except ValueError:
            return 0

    def _rc_loop(self):
        period = 1.0 / RC_HZ
        while True:
            t0 = time.time()
            if self.sdk_ok and not self.asking:
                silence = t0 - self.rc_time
                if (silence > LAND_AFTER and (self.airborne or self.height() > 20)
                        and t0 - self._auto_land_at > 5.0):
                    log(f"控制頁面斷訊超過 {LAND_AFTER:.0f} 秒 → 自動降落")
                    self.send("land")
                    self.airborne = False
                    self._auto_land_at = t0
                    self.last = "斷訊自動降落"
                a, b, c, d = self.rc if silence <= HOVER_AFTER else (0, 0, 0, 0)
                self.send(f"rc {a} {b} {c} {d}")
            time.sleep(max(0.0, period - (time.time() - t0)))

    # ---------- 給 HTTP 用 ----------
    def set_rc(self, vals):
        def clamp(v):
            try:
                return max(-100, min(100, int(v)))
            except (TypeError, ValueError):
                return 0
        vals = list(vals or [])[:4] + [0] * 4
        self.rc = tuple(clamp(v) for v in vals[:4])
        self.rc_time = time.time()

    def command(self, cmd):
        self.rc_time = time.time()          # 收到指令代表控制頁面還活著
        if cmd in IMMEDIATE_CMDS:
            self.send(cmd)
            self.airborne = False
            self.last = f"{cmd} → 已送出"
            log(self.last)
            return "sent"
        if cmd in ASK_CMDS:
            resp = self.ask(cmd, timeout=ASK_CMDS[cmd])
            if cmd == "takeoff":
                # timeout 也當作可能已起飛，讓斷訊保護生效
                self.airborne = not resp.startswith("error")
            return resp
        return "不允許的指令"

    def status(self):
        st = self.state
        return {
            "sdk": self.sdk_ok,
            "bat": st.get("bat"),
            "h": st.get("h"),
            "tof": st.get("tof"),
            "temp": st.get("temph"),
            "airborne": self.airborne,
            "last": self.last,
        }


class Video:
    """Tello H.264 (UDP 11111) → ffmpeg → MJPEG，給 <img> 直接顯示。"""

    def __init__(self):
        self.ffmpeg = shutil.which("ffmpeg")
        self.proc = None
        self.frame = None
        self.seq = 0
        self.cond = threading.Condition()

    def start(self):
        if not self.ffmpeg or (self.proc and self.proc.poll() is None):
            return
        cmd = [
            self.ffmpeg, "-hide_banner", "-loglevel", "error",
            "-fflags", "nobuffer", "-flags", "low_delay",
            "-f", "h264", "-probesize", "500000", "-analyzeduration", "1000000",
            "-i", f"udp://0.0.0.0:{VIDEO_PORT}?overrun_nonfatal=1&fifo_size=5000000",
            "-an", "-vf", "scale=640:-2", "-r", "20", "-q:v", "6",
            "-f", "mjpeg", "pipe:1",
        ]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
        threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()
        log("影像轉檔已啟動（ffmpeg）")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def _reader(self, proc):
        fd = proc.stdout.fileno()
        buf = b""
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            buf += chunk
            while True:
                s = buf.find(b"\xff\xd8")
                if s < 0:
                    buf = buf[-1:]
                    break
                e = buf.find(b"\xff\xd9", s + 2)
                if e < 0:
                    buf = buf[s:]
                    break
                frame, buf = buf[s:e + 2], buf[e + 2:]
                with self.cond:
                    self.frame = frame
                    self.seq += 1
                    self.cond.notify_all()
        log("影像轉檔結束")

    def serve(self, h):
        if not self.ffmpeg:
            h.send_error(404, "ffmpeg not installed")
            return
        h.close_connection = True
        h.send_response(200)
        h.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        h.send_header("Cache-Control", "no-cache")
        h.send_header("Connection", "close")
        h.end_headers()
        with self.cond:
            last = self.seq if self.frame is None else self.seq - 1
        idle = 0
        try:
            while idle < 60:
                with self.cond:
                    self.cond.wait_for(lambda: self.seq != last, timeout=1.0)
                    if self.seq == last or self.frame is None:
                        idle += 1
                        continue
                    frame, last, idle = self.frame, self.seq, 0
                h.wfile.write(
                    b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n"
                )
        except (BrokenPipeError, ConnectionResetError):
            pass


PAGE = r"""<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Tello 手把控制</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, sans-serif; background:#111; color:#eee;
         height:100vh; display:flex; flex-direction:column; overflow:hidden; }
  header { display:flex; flex-wrap:wrap; gap:.4rem 1rem; padding:.4rem .6rem; background:#1c1c1c;
           font-size:.9rem; align-items:center; }
  header b { font-variant-numeric: tabular-nums; }
  .ok { color:#5fd35f; } .bad { color:#ff6b6b; } .warn { color:#ffc04d; }
  main { flex:1; display:flex; align-items:center; justify-content:center; gap:1rem; min-height:0; padding:.4rem; }
  .stick { width:110px; height:110px; border:2px solid #444; border-radius:50%; position:relative; flex:none; }
  .stick span { position:absolute; left:45px; top:45px; width:20px; height:20px; border-radius:50%; background:#4da3ff; }
  .stick small { position:absolute; bottom:-1.3rem; width:100%; text-align:center; color:#888; }
  #vbox { flex:1; height:100%; max-width:960px; display:flex; align-items:center; justify-content:center;
          background:#000; border-radius:8px; color:#666; overflow:hidden; }
  #video { max-width:100%; max-height:100%; }
  footer { display:flex; gap:.5rem; padding:.5rem; justify-content:center; flex-wrap:wrap; }
  button { font-size:1rem; padding:.7rem 1.1rem; border:0; border-radius:8px; background:#333; color:#eee; }
  button:active { background:#555; }
  #btnEmg { background:#b3261e; font-weight:bold; }
  #help { font-size:.75rem; color:#999; text-align:center; padding:0 .5rem .4rem; }
</style></head>
<body>
<header>
  <span id="conn" class="bad">連線中…</span>
  <span>電量 <b id="bat">--</b>%</span>
  <span>高度 <b id="h">--</b> cm</span>
  <span>溫度 <b id="temp">--</b>°C</span>
  <span>速度 <b id="mode">一般</b></span>
  <span id="pad" class="warn">未偵測到手把（先按手把任一鍵）</span>
  <span id="last" style="color:#aaa"></span>
</header>
<main>
  <div class="stick" id="sl"><span></span><small>左：升降 / 轉向</small></div>
  <div id="vbox"><img id="video" alt=""><span id="vtip">按 Y 或「影像」開啟鏡頭畫面</span></div>
  <div class="stick" id="sr"><span></span><small>右：前後 / 左右</small></div>
</main>
<footer>
  <button onclick="cmd('takeoff')">起飛</button>
  <button onclick="cmd('land')">降落</button>
  <button onclick="toggleVideo()">影像</button>
  <button onclick="document.documentElement.requestFullscreen && document.documentElement.requestFullscreen()">全螢幕</button>
  <button id="btnEmg" onclick="cmd('emergency')">緊急停槳</button>
</footer>
<div id="help">A 起飛 ｜ B 降落 ｜ Y 影像 ｜ X＋十字鍵 翻滾 ｜ LT 按住精細 ／ RT 按住全速 ｜ LB＋RB 同按＝緊急停槳（會直接掉下來）</div>
<script>
const $ = id => document.getElementById(id);
const DZ = 0.12;
const dz = v => { const a = Math.abs(v); return a < DZ ? 0 : Math.sign(v) * (a - DZ) / (1 - DZ); };
const isDown = (gp, i) => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5);
const prev = {};
const edge = (gp, i) => { const now = isDown(gp, i), was = !!prev[i]; prev[i] = now; return now && !was; };
let rcBusy = false, videoOn = false;

async function cmd(c) {
  $('last').textContent = c + ' …';
  try {
    const r = await fetch('/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ cmd: c }) });
    const j = await r.json();
    $('last').textContent = c + ' → ' + j.resp;
    return j.resp;
  } catch (e) {
    $('last').textContent = c + ' 失敗：' + e;
  }
}

async function toggleVideo() {
  videoOn = !videoOn;
  if (videoOn) {
    $('vtip').textContent = '影像載入中…';
    await cmd('streamon');
    $('video').src = '/video?t=' + Date.now();
  } else {
    $('video').removeAttribute('src');
    $('vtip').textContent = '按 Y 或「影像」開啟鏡頭畫面';
    cmd('streamoff');
  }
}
$('video').onload = () => { $('vtip').textContent = ''; };

function drawStick(id, x, y) {
  document.querySelector('#' + id + ' span').style.transform = `translate(${x * 45}px, ${y * 45}px)`;
}

function showStatus(j) {
  $('conn').textContent = j.sdk ? 'Tello 已連線' : '等待 Tello…（確認 Wi-Fi 連到 TELLO-xxxx、行動數據已關）';
  $('conn').className = j.sdk ? 'ok' : 'bad';
  $('bat').textContent = j.bat ?? '--';
  $('bat').className = (j.bat && +j.bat < 20) ? 'bad' : '';
  $('h').textContent = j.h ?? '--';
  $('temp').textContent = j.temp ?? '--';
  if (j.last) $('last').textContent = j.last;
  if (!j.video) $('vtip').textContent = '沒有 ffmpeg，影像停用（Termux：pkg install ffmpeg）';
}

function tick() {
  const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
  const gp = pads.find(p => p && p.connected);
  let rc = [0, 0, 0, 0];
  if (gp) {
    $('pad').textContent = gp.id.slice(0, 32) + (gp.mapping === 'standard' ? '' : '（非標準按鍵對應）');
    $('pad').className = gp.mapping === 'standard' ? 'ok' : 'warn';
    let k = 0.6, mode = '一般';
    if (isDown(gp, 6)) { k = 0.3; mode = '精細'; }
    else if (isDown(gp, 7)) { k = 1.0; mode = '全速'; }
    $('mode').textContent = mode;
    const ax = gp.axes;
    const lx = dz(ax[0] || 0), ly = dz(ax[1] || 0), rx = dz(ax[2] || 0), ry = dz(ax[3] || 0);
    // Tello rc a b c d = 左右 前後 升降 轉向（Mode 2：左搖桿油門/轉向，右搖桿前後/左右）
    rc = [rx, -ry, -ly, lx].map(v => Math.round(v * 100 * k));
    drawStick('sl', lx, ly); drawStick('sr', rx, ry);

    const both = isDown(gp, 4) && isDown(gp, 5);
    if (both && !prev.both) cmd('emergency');
    prev.both = both;
    if (edge(gp, 0)) cmd('takeoff');
    if (edge(gp, 1)) cmd('land');
    if (edge(gp, 3)) toggleVideo();
    const xHeld = isDown(gp, 2);
    for (const [i, d] of [[12, 'f'], [13, 'b'], [14, 'l'], [15, 'r']]) {
      if (edge(gp, i) && xHeld) cmd('flip ' + d);
    }
  } else {
    $('pad').textContent = '未偵測到手把（先按手把任一鍵）';
    $('pad').className = 'warn';
  }
  if (!rcBusy) {
    rcBusy = true;
    fetch('/rc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rc }) })
      .then(r => r.json()).then(showStatus)
      .catch(() => { $('conn').textContent = '本機程式沒在跑？'; $('conn').className = 'bad'; })
      .finally(() => { rcBusy = false; });
  }
}
setInterval(tick, 50);

// 防止手把 B 鍵 / 返回手勢把頁面帶走
history.pushState(null, '', location.href);
addEventListener('popstate', () => history.pushState(null, '', location.href));
// 螢幕常亮
async function keepAwake() { try { await navigator.wakeLock.request('screen'); } catch (e) {} }
addEventListener('click', keepAwake);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
</script>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    tello = None
    video = None

    def log_message(self, *args):
        pass

    def _send(self, body, ctype="application/json; charset=utf-8", code=200):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return {}

    def _status(self):
        st = self.tello.status()
        st["video"] = bool(self.video.ffmpeg)
        return st

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._send(PAGE, "text/html; charset=utf-8")
        elif path == "/video":
            self.video.serve(self)
        elif path == "/state":
            self._send(self._status())
        else:
            self._send({"error": "not found"}, code=404)

    def do_POST(self):
        body = self._body()
        if self.path == "/rc":
            self.tello.set_rc(body.get("rc"))
            self._send(self._status())
        elif self.path == "/cmd":
            cmd = str(body.get("cmd", "")).strip()
            resp = self.tello.command(cmd)
            if cmd == "streamon" and resp == "ok":
                self.video.start()
            self._send({"cmd": cmd, "resp": resp})
        else:
            self._send({"error": "not found"}, code=404)


def main():
    tello = Tello()
    video = Video()
    Handler.tello, Handler.video = tello, video
    srv = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), Handler)
    srv.daemon_threads = True

    def _on_term(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _on_term)   # 被 kill 時也照樣降落、關掉 ffmpeg
    log(f"控制頁面：http://{HTTP_HOST}:{HTTP_PORT}  ← 用 Chrome 開")
    log(f"Tello 位址：{TELLO_IP}（手機 Wi-Fi 要先連上 TELLO-xxxx）")
    if not video.ffmpeg:
        log("找不到 ffmpeg，影像功能停用（Termux 安裝：pkg install ffmpeg）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if tello.airborne or tello.height() > 20:
            log("程式結束 → 送出降落")
            for _ in range(3):
                tello.send("land")
                time.sleep(0.1)
        video.stop()
        log("已結束")


if __name__ == "__main__":
    main()