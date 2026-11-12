"""整合測試：真的啟動 `python -m gcs`（子行程）＋模擬 Tello，走完整條控制鏈。

涵蓋：WebSocket（Origin、機長）、起飛／rc／未啟用提示、WebCodecs 影像路徑（H.264 AU）、
MJPEG 備援、/api/diag、斷線懸停＋8 秒自動降落（實際時序）、Ctrl+Break（SIGBREAK/SIGINT）結束時降落。
"""
import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest
import websockets

from sim.mock_tello import MockThread, Options

ROOT = Path(__file__).resolve().parents[2]
PORTS = dict(cmd=28889, state=28890, video=31111, http=28080)
ORIGIN = f"http://localhost:{PORTS['http']}"
WS = f"ws://127.0.0.1:{PORTS['http']}"


def start_gcs():
    env = dict(os.environ, TELLO_IP="127.0.0.1", TELLO_CMD_PORT=str(PORTS["cmd"]), STATE_PORT=str(PORTS["state"]),
               VIDEO_PORT=str(PORTS["video"]), HTTP_PORT=str(PORTS["http"]), TELLO_SIM="1", PYTHONUNBUFFERED="1")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    p = subprocess.Popen([sys.executable, "-m", "gcs"], cwd=ROOT, env=env, creationflags=flags,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORTS['http']}/api/health", timeout=0.5)
            return p
        except OSError:
            if p.poll() is not None:
                raise RuntimeError(p.stdout.read().decode(errors="replace"))
            time.sleep(0.1)
    p.kill()
    raise RuntimeError("gcs 沒有啟動")


def stop_gcs(p, timeout=10):
    if p.poll() is not None:
        return p.returncode
    p.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
    try:
        return p.wait(timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        raise


@pytest.fixture()
def env():
    mock = MockThread(Options(host="127.0.0.1", cmd_port=PORTS["cmd"], state_port=PORTS["state"],
                              video_port=PORTS["video"], takeoff_delay=0.8, quiet=True)).start()
    gcs = start_gcs()
    yield mock, gcs
    if gcs.poll() is None:
        gcs.kill()
    mock.stop()


class Pilot:
    def __init__(self, ws):
        self.ws = ws
        self.tel = None
        self.res = {}
        self.events = []
        self.hello = None
        self.task = asyncio.ensure_future(self._pump())
        self.n = 0

    async def _pump(self):
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                if m["t"] == "tel":
                    self.tel = m
                elif m["t"] == "res":
                    self.res[m["id"]] = m
                elif m["t"] == "event":
                    self.events.append(m)
                elif m["t"] == "hello":
                    self.hello = m
        except websockets.ConnectionClosed:
            pass

    async def cmd(self, c, timeout=15):
        self.n += 1
        i = self.n
        await self.ws.send(json.dumps({"t": "cmd", "cmd": c, "id": i}))
        await until(lambda: i in self.res, timeout)
        return self.res[i]

    async def rc(self, v, seconds, hz=30):
        t0 = time.monotonic()
        while time.monotonic() - t0 < seconds:
            await self.ws.send(json.dumps({"t": "rc", "v": v}))
            await asyncio.sleep(1 / hz)


async def until(cond, timeout, step=0.05):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if cond():
            return
        await asyncio.sleep(step)
    raise AssertionError("條件沒有在時限內成立")


async def connect():
    ws = await websockets.connect(f"{WS}/ws/control", origin=ORIGIN)
    p = Pilot(ws)
    await until(lambda: p.hello is not None, 3)
    return p


def test_full_flight_cycle(env):
    mock, gcs = env

    async def go():
        # Origin 不對 → 拒絕
        with pytest.raises(Exception):
            await websockets.connect(f"{WS}/ws/control", origin="http://evil.example")

        p = await connect()
        assert p.hello["role"] == "pilot" and p.hello["sim"] is True
        await until(lambda: p.tel and p.tel["connected"], 5)
        assert p.tel["bat"] == 87

        # 未啟用：takeoff 回 error，附「最可能的原因」
        mock.mock.o.activated = False
        r = await p.cmd("takeoff")
        assert r["kind"] == "error" and "最可能" in r["hint"]["primary"] and "啟用" in r["hint"]["primary"]
        mock.mock.o.activated = True

        # 起飛、爬升
        keep = asyncio.ensure_future(p.rc([0, 0, 0, 0], 2.5))
        r = await p.cmd("takeoff")
        assert r["kind"] == "ok"
        await keep
        await p.rc([0, 0, 60, 0], 1.0)
        await until(lambda: p.tel["h"] > 100, 3)
        assert mock.mock.w.flying

        # 白名單
        assert (await p.cmd("reboot"))["kind"] == "denied"

        # 影像：WebCodecs 路徑（/ws/video）
        rc_task = asyncio.ensure_future(p.rc([0, 0, 0, 0], 8))
        assert (await p.cmd("streamon"))["kind"] == "ok"
        v = await websockets.connect(f"{WS}/ws/video", origin=ORIGIN, max_size=None)
        cfg = None
        aus = []
        t0 = time.monotonic()
        while time.monotonic() - t0 < 3:
            try:
                m = await asyncio.wait_for(v.recv(), 1)
            except asyncio.TimeoutError:
                continue
            if isinstance(m, str):
                cfg = json.loads(m)
            else:
                aus.append(m)
        await v.close()
        assert cfg and cfg["codec"].startswith("avc1.")
        assert len(aus) >= 30, f"3 秒只收到 {len(aus)} 個 AU"
        assert aus[0][0] == 1                                  # 第一個一定是關鍵幀
        assert b"\x00\x00\x00\x01\x67" in aus[0][:200]        # 而且帶 SPS（必要時由後端補上）

        # MJPEG 備援
        if shutil.which("ffmpeg"):
            def read_jpeg():
                with urllib.request.urlopen(f"http://127.0.0.1:{PORTS['http']}/video.mjpg", timeout=10) as r:
                    buf = b""
                    while b"\xff\xd9" not in buf:
                        buf += r.read(4096)
                    return buf
            buf = await asyncio.get_running_loop().run_in_executor(None, read_jpeg)
            assert b"\xff\xd8" in buf and b"image/jpeg" in buf

        d = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORTS['http']}/api/diag").read())
        assert d["state"]["pps"] >= 5 and d["video"]["pps"] > 0 and d["video"]["keyframes"] >= 1
        assert d["cmd"]["rtt_ms"] is not None and d["cmd"]["rtt_ms"] < 200
        rc_task.cancel()

        # 機長斷線 → 立刻懸停 → 約 8 秒後自動降落（只送一次）
        await p.rc([0, 40, 0, 0], 0.5)
        t_last = time.monotonic()
        await p.ws.close()
        await until(lambda: mock.mock.w.rc == (0, 0, 0, 0), 1.0)
        await until(lambda: "land" in mock.mock.commands(), 10)
        t_land = next(t for t, c in mock.mock.log if c == "land")
        assert 7.7 < t_land - t_last < 8.8, t_land - t_last
        await until(lambda: not mock.mock.w.flying, 6)
        await asyncio.sleep(1)
        assert mock.mock.commands().count("land") == 1

    asyncio.run(go())


def test_ctrl_break_lands_before_exit(env):
    """原生模式按 Ctrl+C / 關閉視窗 / docker stop：在空中就先送 land。"""
    mock, gcs = env

    async def go():
        p = await connect()
        await until(lambda: p.tel and p.tel["connected"], 5)
        keep = asyncio.ensure_future(p.rc([0, 0, 0, 0], 2.5))
        assert (await p.cmd("takeoff"))["kind"] == "ok"
        await keep
        n_before = mock.mock.commands().count("land")
        t0 = time.monotonic()
        code = await asyncio.get_running_loop().run_in_executor(None, stop_gcs, gcs)
        elapsed = time.monotonic() - t0
        assert mock.mock.commands().count("land") > n_before
        t_land = next(t for t, c in mock.mock.log if c == "land")
        assert t_land - t0 < 0.5, "land 應該在收到訊號當下就送出"
        assert elapsed < 6, f"結束花了 {elapsed:.1f} 秒"
        return code

    asyncio.run(go())
    out = gcs.stdout.read().decode("utf-8", "replace")
    assert "降落" in out
