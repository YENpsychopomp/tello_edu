"""Tello 模擬器：指令回應、10 Hz 狀態封包、ffmpeg testsrc H.264 影像。

    python -m sim.mock_tello                 # 監聽 0.0.0.0:8889
    python -m sim.mock_tello --not-activated # takeoff 一律回 error（模擬未啟用）
    python -m sim.mock_tello --no-state      # 不送狀態封包（模擬防火牆擋 8890）
    python -m sim.mock_tello --ignore-land   # 收到 land 不動作（測試自動降落重送／放棄）

行為盡量貼近真機：狀態與影像送往「送 command 過來的那個 IP」；rc 沒有回應；
15 秒沒收到任何指令會自動降落。
"""
from __future__ import annotations

import argparse
import asyncio
import math
import random
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class Options:
    host: str = "0.0.0.0"
    cmd_port: int = 8889
    state_port: int = 8890
    video_port: int = 11111
    battery: int = 87
    temp: int = 58
    activated: bool = True
    send_state: bool = True
    ignore_land: bool = False
    takeoff_delay: float = 1.5
    drain_s: float = 7.8          # 每掉 1% 電量的秒數（約 13 分鐘滿電）
    no_cmd_land: float = 15.0
    video: bool = True
    quiet: bool = False


@dataclass
class World:
    flying: bool = False
    motors: bool = False
    h: float = 0.0
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0
    vgx: float = 0.0
    vgy: float = 0.0
    vgz: float = 0.0
    bat: float = 87.0
    temph: float = 58.0
    flight_time: float = 0.0
    target_h: Optional[float] = None
    rc: tuple = (0, 0, 0, 0)


class MockTello(asyncio.DatagramProtocol):
    def __init__(self, opt: Options):
        self.o = opt
        self.w = World(bat=float(opt.battery), temph=float(opt.temp))
        self.client: Optional[tuple[str, int]] = None
        self.tr: Optional[asyncio.DatagramTransport] = None
        self.state_sock: Optional[asyncio.DatagramTransport] = None
        self.log: list[tuple[float, str]] = []
        self.rc_count = 0
        self.rc_log: deque = deque(maxlen=5000)     # (時間, rc 值)，給測試檢查時序
        self.last_packet = time.monotonic()
        self.ffmpeg: Optional[subprocess.Popen] = None
        self.tasks: list[asyncio.Task] = []
        self.wifi = 90

    # ---------------------------------------------------------------- 啟動
    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self.tr, _ = await loop.create_datagram_endpoint(lambda: self, local_addr=(self.o.host, self.o.cmd_port))
        self.state_sock, _ = await loop.create_datagram_endpoint(asyncio.DatagramProtocol,
                                                                 local_addr=("0.0.0.0", 0))
        self.tasks = [loop.create_task(self._physics()), loop.create_task(self._state_loop())]
        self.say(f"模擬 Tello 已啟動：UDP {self.o.host}:{self.o.cmd_port}"
                 f"{'（未啟用）' if not self.o.activated else ''}"
                 f"{'（不送狀態）' if not self.o.send_state else ''}")

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        self._stop_video()
        for tr in (self.tr, self.state_sock):
            if tr:
                tr.close()

    @property
    def cmd_port_bound(self) -> int:
        assert self.tr is not None
        return self.tr.get_extra_info("sockname")[1]

    def say(self, msg: str) -> None:
        if not self.o.quiet:
            print(time.strftime("[%H:%M:%S]"), "[mock]", msg, flush=True)

    def commands(self) -> list[str]:
        return [c for _, c in self.log]

    # ---------------------------------------------------------------- 指令
    def datagram_received(self, data: bytes, addr: Any) -> None:
        self.last_packet = time.monotonic()
        cmd = data.decode("utf-8", "replace").strip()
        self.client = (addr[0], addr[1])
        if cmd.startswith("rc "):
            self.rc_count += 1
            try:
                vals = tuple(max(-100, min(100, int(v))) for v in cmd.split()[1:5])
                if len(vals) == 4:
                    self.w.rc = vals
                    self.rc_log.append((self.last_packet, vals))
            except ValueError:
                pass
            return
        self.log.append((time.monotonic(), cmd))
        self.say(f"收到：{cmd}")
        asyncio.ensure_future(self._handle(cmd, addr))

    def reply(self, msg: str, addr: Any) -> None:
        if self.tr:
            self.tr.sendto(msg.encode(), addr)

    async def _handle(self, cmd: str, addr: Any) -> None:
        w = self.w
        if cmd == "command":
            self.reply("ok", addr)
        elif cmd == "takeoff":
            if not self.o.activated:
                await asyncio.sleep(0.2)
                self.reply("error", addr)
            elif w.bat < 10:
                self.reply("error No valid imu", addr)
            elif w.flying:
                self.reply("error", addr)
            else:
                w.motors = True
                w.target_h = 80.0
                await asyncio.sleep(self.o.takeoff_delay)
                if w.motors:           # 期間沒被 land / emergency 中斷
                    w.flying = True
                    self.reply("ok", addr)
        elif cmd == "land":
            if self.o.ignore_land:
                return
            if w.motors:
                w.target_h = 0.0
                await asyncio.sleep(0.5)
            self.reply("ok", addr)
        elif cmd == "emergency":
            w.motors = w.flying = False
            w.h, w.target_h = 0.0, None
            self.reply("ok", addr)
        elif cmd == "streamon":
            self._start_video(addr[0])
            self.reply("ok", addr)
        elif cmd == "streamoff":
            self._stop_video()
            self.reply("ok", addr)
        elif cmd.startswith("flip "):
            if w.bat < 50 or not w.flying:
                self.reply("error", addr)
            else:
                await asyncio.sleep(1.0)
                self.reply("ok", addr)
        elif cmd == "battery?":
            self.reply(str(int(w.bat)), addr)
        elif cmd == "wifi?":
            self.wifi = max(20, min(99, self.wifi + random.randint(-3, 3)))
            self.reply(str(self.wifi), addr)
        elif cmd == "sdk?":
            self.reply("30", addr)
        elif cmd == "sn?":
            self.reply("0TQZSIMULATOR", addr)
        else:
            self.reply("error", addr)

    # ---------------------------------------------------------------- 物理 / 狀態
    async def _physics(self) -> None:
        dt = 0.05
        while True:
            await asyncio.sleep(dt)
            w = self.w
            if w.motors:
                w.flight_time += dt
                w.bat = max(0.0, w.bat - dt / self.o.drain_s)
                w.temph = min(95.0, w.temph + dt * 0.02)
                a, b, c, d = w.rc
                if w.target_h is not None:
                    step = 60.0 * dt
                    if abs(w.h - w.target_h) <= step:
                        w.h = w.target_h
                        if w.target_h == 0.0:
                            w.motors = w.flying = False
                            self.say("已降落")
                        w.target_h = None
                    else:
                        w.h += step if w.target_h > w.h else -step
                    w.vgz = 0
                elif w.flying:
                    w.h = max(0.0, min(3000.0, w.h + c * dt))
                    w.vgz = -c / 10
                w.yaw = ((w.yaw + d * 0.9 * dt + 180) % 360) - 180
                w.vgx, w.vgy = b / 10, a / 10
                w.pitch += (-b * 0.15 - w.pitch) * 0.2
                w.roll += (a * 0.15 - w.roll) * 0.2
                if w.flying and time.monotonic() - self.last_packet > self.o.no_cmd_land and w.target_h is None:
                    self.say(f"{self.o.no_cmd_land:.0f} 秒沒收到指令 → 內建自動降落")
                    w.target_h = 0.0
            else:
                w.temph = max(float(self.o.temp), w.temph - dt * 0.01)
                w.vgx = w.vgy = w.vgz = 0
                w.pitch *= 0.8
                w.roll *= 0.8

    def state_string(self) -> str:
        w = self.w
        return ("mid:-1;x:-100;y:-100;z:-100;mpry:0,0,0;"
                f"pitch:{int(round(w.pitch))};roll:{int(round(w.roll))};yaw:{int(round(w.yaw))};"
                f"vgx:{int(round(w.vgx))};vgy:{int(round(w.vgy))};vgz:{int(round(w.vgz))};"
                f"templ:{int(w.temph) - 2};temph:{int(w.temph)};tof:{int(w.h) + 10};h:{int(w.h)};"
                f"bat:{int(math.ceil(w.bat))};baro:{100.0 + w.h / 100:.2f};time:{int(w.flight_time)};"
                "agx:-3.00;agy:1.00;agz:-999.00;\r\n")

    async def _state_loop(self) -> None:
        while True:
            await asyncio.sleep(0.1)
            if self.client and self.o.send_state and self.state_sock:
                self.state_sock.sendto(self.state_string().encode(), (self.client[0], self.o.state_port))

    # ---------------------------------------------------------------- 影像
    def _start_video(self, ip: str) -> None:
        if not self.o.video or (self.ffmpeg and self.ffmpeg.poll() is None):
            return
        ff = shutil.which("ffmpeg")
        if not ff:
            self.say("找不到 ffmpeg，模擬影像停用")
            return
        cmd = [ff, "-hide_banner", "-loglevel", "error", "-re",
               "-f", "lavfi", "-i", "testsrc2=size=960x720:rate=30",
               "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
               "-profile:v", "main", "-pix_fmt", "yuv420p", "-g", "30", "-bf", "0", "-b:v", "1500k",
               "-flush_packets", "1", "-f", "h264", f"udp://{ip}:{self.o.video_port}?pkt_size=1460"]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.ffmpeg = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, creationflags=flags)
        self.say(f"影像串流 → {ip}:{self.o.video_port}")

    def _stop_video(self) -> None:
        if self.ffmpeg and self.ffmpeg.poll() is None:
            self.ffmpeg.terminate()
            try:
                self.ffmpeg.wait(3)
            except subprocess.TimeoutExpired:
                self.ffmpeg.kill()
        self.ffmpeg = None


class MockThread:
    """在背景執行緒跑模擬器（給測試用）。"""

    def __init__(self, opt: Options):
        self.opt = opt
        self.mock: Optional[MockTello] = None
        self.loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.mock = MockTello(self.opt)
        self.loop.run_until_complete(self.mock.start())
        self._ready.set()
        self.loop.run_forever()

    def start(self) -> "MockThread":
        self.thread.start()
        self._ready.wait(5)
        return self

    def stop(self) -> None:
        if self.mock:
            asyncio.run_coroutine_threadsafe(self.mock.stop(), self.loop).result(5)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)

    def call(self, fn, *args):
        """在模擬器的 loop 裡執行（修改世界狀態用）。"""
        fut = asyncio.run_coroutine_threadsafe(_acall(fn, *args), self.loop)
        return fut.result(5)


async def _acall(fn, *args):
    return fn(*args)


def parse_args(argv: Optional[list[str]] = None) -> Options:
    p = argparse.ArgumentParser(description="Tello 模擬器")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--cmd-port", type=int, default=8889)
    p.add_argument("--state-port", type=int, default=8890)
    p.add_argument("--video-port", type=int, default=11111)
    p.add_argument("--battery", type=int, default=87)
    p.add_argument("--temp", type=int, default=58)
    p.add_argument("--not-activated", action="store_true")
    p.add_argument("--no-state", action="store_true")
    p.add_argument("--no-video", action="store_true")
    p.add_argument("--ignore-land", action="store_true")
    p.add_argument("--takeoff-delay", type=float, default=1.5)
    p.add_argument("--drain", type=float, default=7.8, help="每掉 1%% 電量的秒數")
    a = p.parse_args(argv)
    return Options(host=a.host, cmd_port=a.cmd_port, state_port=a.state_port, video_port=a.video_port,
                   battery=a.battery, temp=a.temp, activated=not a.not_activated,
                   send_state=not a.no_state, video=not a.no_video, ignore_land=a.ignore_land,
                   takeoff_delay=a.takeoff_delay, drain_s=a.drain)


async def _main(opt: Options) -> None:
    m = MockTello(opt)
    await m.start()
    try:
        await asyncio.Event().wait()
    finally:
        await m.stop()


if __name__ == "__main__":
    try:
        asyncio.run(_main(parse_args()))
    except KeyboardInterrupt:
        sys.exit(0)
