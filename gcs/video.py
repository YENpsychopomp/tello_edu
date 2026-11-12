"""影像：接收 UDP 11111 → H.264 重組 → 扇出給 /ws/video；備援路徑 ffmpeg → MJPEG。

後端獨占 UDP 11111。ffmpeg 備援改成從 stdin 讀 H.264（原型是讓 ffmpeg 自己 bind UDP），
其餘 ffmpeg 參數沿用原型已驗證的設定。
"""
from __future__ import annotations

import asyncio
import logging
import queue
import shutil
import subprocess
import threading
from typing import Any, Optional

from .config import Settings
from .diag import Diag
from .h264 import AccessUnit, H264Reassembler

log = logging.getLogger("gcs.video")

TELLO_PACKET = 1460


class Subscriber:
    """一個 /ws/video 用戶端。塞車時清空並等下一個 IDR，不讓延遲累積。"""

    def __init__(self, maxsize: int = 8):
        self.q: asyncio.Queue[AccessUnit] = asyncio.Queue(maxsize)
        self.need_key = True
        self.codec_sent: Optional[str] = None
        self.drops = 0

    def offer(self, au: AccessUnit) -> bool:
        if self.need_key and not au.key:
            return False
        try:
            self.q.put_nowait(au)
            self.need_key = False
            return True
        except asyncio.QueueFull:
            while not self.q.empty():
                self.q.get_nowait()
            self.drops += 1
            self.need_key = True
            if au.key:
                self.q.put_nowait(au)
                self.need_key = False
            return False


class _VideoProto(asyncio.DatagramProtocol):
    def __init__(self, hub: "VideoHub"):
        self.hub = hub

    def datagram_received(self, data: bytes, addr: Any) -> None:
        self.hub.on_packet(data, addr)

    def error_received(self, exc: Exception) -> None:
        log.debug("video socket error: %s", exc)


class VideoHub:
    def __init__(self, settings: Settings, diag: Diag):
        self.s = settings
        self.diag = diag
        self.rx = H264Reassembler()
        self.subs: set[Subscriber] = set()
        self.tr: Optional[asyncio.DatagramTransport] = None
        self.port_bound: Optional[int] = None
        self.max_pkt = TELLO_PACKET
        self.mjpeg = Mjpeg(diag)
        self.last_key: Optional[AccessUnit] = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self.tr, _ = await loop.create_datagram_endpoint(
            lambda: _VideoProto(self), local_addr=("0.0.0.0", self.s.video_port))
        self.port_bound = self.tr.get_extra_info("sockname")[1]
        self.mjpeg.loop = loop

    async def stop(self) -> None:
        self.mjpeg.stop()
        if self.tr is not None:
            self.tr.close()
            self.tr = None

    def on_packet(self, data: bytes, addr: Any) -> None:
        self.diag.video.add(len(data))
        self.diag.video_source = f"{addr[0]}:{addr[1]}" if addr else None
        if len(data) > self.max_pkt:
            self.max_pkt = len(data)
        self.mjpeg.feed(data)
        for au in self.rx.feed(data, end_hint=len(data) < self.max_pkt):
            self.diag.au.add(len(au.data))
            if au.key:
                self.diag.keyframes += 1
                self.last_key = au
            if au.codec:
                self.diag.codec = au.codec
            for sub in list(self.subs):
                before = sub.drops
                sub.offer(au)
                self.diag.video_drops += sub.drops - before

    def subscribe(self) -> Subscriber:
        sub = Subscriber()
        if self.last_key is not None:
            sub.offer(self.last_key)        # 讓新用戶端不用等下一個 IDR
        self.subs.add(sub)
        self.diag.ws_video = len(self.subs)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self.subs.discard(sub)
        self.diag.ws_video = len(self.subs)

    def reset_stream(self) -> None:
        """streamoff 之後重設，避免下一段串流接到舊的半個 NAL。"""
        self.rx = H264Reassembler()
        self.last_key = None


class Mjpeg:
    """ffmpeg 備援：stdin 餵 H.264 → stdout 讀 MJPEG。用執行緒避免阻塞 event loop。"""

    def __init__(self, diag: Diag):
        self.diag = diag
        self.ffmpeg = shutil.which("ffmpeg")
        self.proc: Optional[subprocess.Popen] = None
        self.inq: "queue.Queue[Optional[bytes]]" = queue.Queue(maxsize=2000)
        self.frame: Optional[bytes] = None
        self.seq = 0
        self.clients = 0
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.cond: Optional[asyncio.Condition] = None
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return bool(self.ffmpeg)

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> None:
        with self._lock:
            if not self.ffmpeg or self.running():
                return
            cmd = [
                self.ffmpeg, "-hide_banner", "-loglevel", "error",
                "-fflags", "nobuffer", "-flags", "low_delay",
                "-f", "h264", "-probesize", "500000", "-analyzeduration", "1000000",
                "-i", "pipe:0",
                "-an", "-vf", "scale=640:-2", "-r", "20", "-q:v", "6",
                "-f", "mjpeg", "pipe:1",
            ]
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, creationflags=flags)
            self.inq = queue.Queue(maxsize=2000)
            threading.Thread(target=self._writer, args=(self.proc, self.inq), daemon=True).start()
            threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()
            self.diag.ffmpeg_running = True
            log.info("MJPEG 備援已啟動（ffmpeg）")

    def stop(self) -> None:
        with self._lock:
            if self.proc is not None:
                try:
                    self.inq.put_nowait(None)
                except queue.Full:
                    pass
                if self.proc.poll() is None:
                    self.proc.terminate()
                self.proc = None
            self.diag.ffmpeg_running = False

    def feed(self, data: bytes) -> None:
        if self.running():
            try:
                self.inq.put_nowait(data)
            except queue.Full:
                pass

    def _writer(self, proc: subprocess.Popen, q: "queue.Queue[Optional[bytes]]") -> None:
        try:
            while True:
                data = q.get()
                if data is None or proc.stdin is None:
                    break
                proc.stdin.write(data)
                proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass

    def _reader(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        buf = b""
        while True:
            chunk = proc.stdout.read1(65536) if hasattr(proc.stdout, "read1") else proc.stdout.read(65536)
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
                self._publish(frame)
        self.diag.ffmpeg_running = False
        log.info("MJPEG 備援結束")

    def _publish(self, frame: bytes) -> None:
        self.frame = frame
        self.seq += 1
        if self.loop is not None and self.cond is not None:
            self.loop.call_soon_threadsafe(self._notify)

    def _notify(self) -> None:
        async def go() -> None:
            assert self.cond is not None
            async with self.cond:
                self.cond.notify_all()
        asyncio.ensure_future(go())

    async def stream(self):
        """multipart/x-mixed-replace 產生器。"""
        if self.cond is None:
            self.cond = asyncio.Condition()
        self.clients += 1
        self.diag.ws_mjpeg = self.clients
        self.start()
        last = self.seq
        try:
            idle = 0
            while idle < 60:
                try:
                    async with self.cond:
                        await asyncio.wait_for(self.cond.wait_for(lambda: self.seq != last), 1.0)
                except asyncio.TimeoutError:
                    idle += 1
                    continue
                idle = 0
                frame, last = self.frame, self.seq
                if frame is None:
                    continue
                yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                       + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
        finally:
            self.clients -= 1
            self.diag.ws_mjpeg = self.clients
            if self.clients <= 0:
                self.stop()
