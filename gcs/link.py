"""TelloLink：Tello SDK 的 UDP 收發、指令排程與斷訊保護（asyncio 版）。

移植自 tello_pad.py 的 Tello 類別，行為差異：
  * ask 進行中送出 land/emergency → 該 ask 立即回傳 "interrupted"
    （之後的回應靠「下一次 ask 前先清空佇列」丟掉）
  * 暫停 rc 之前（ask 或狀態中斷），如果在空中先送一次 rc 0 0 0 0
  * 自動降落：每次斷訊送 1 次，5 秒後遙測仍在空中才重送，最多 3 次；
    全部失敗就停止送任何指令，讓 Tello 內建的 15 秒無指令降落接手
"""
from __future__ import annotations

import asyncio
import logging
import re
import socket
import time
from typing import Any, Callable, Optional

from . import config
from .config import Settings
from .diag import Diag
from .flightlog import FlightLog
from .protocol import (ASK_CMDS, FLIP_CMDS, FLIP_MIN_BATTERY, IMMEDIATE_CMDS, RC_ZERO,
                       BatteryEstimator, ask_timeout, clamp_rc, classify, is_move, normalize_cmd,
                       parse_state, parse_wifi, rc_command)
from .safety import Safety

log = logging.getLogger("gcs.link")

EventCb = Callable[[str, str, str], None]   # (level, code, message)


class _Proto(asyncio.DatagramProtocol):
    def __init__(self, on_data: Callable[[bytes, Any], None], on_error: Callable[[Exception], None]):
        self.on_data = on_data
        self.on_error = on_error

    def datagram_received(self, data: bytes, addr: Any) -> None:
        self.on_data(data, addr)

    def error_received(self, exc: Exception) -> None:
        self.on_error(exc)


class TelloLink:
    def __init__(self, settings: Settings, diag: Optional[Diag] = None,
                 on_event: Optional[EventCb] = None, safety: Optional[Safety] = None,
                 flightlog: Optional[FlightLog] = None,
                 clock: Callable[[], float] = time.monotonic,
                 state_stale: float = config.STATE_STALE, rc_hz: int = config.RC_HZ,
                 wifi_poll: float = config.WIFI_POLL, wifi_first: float = 1.0):
        self.s = settings
        self.diag = diag or Diag()
        self.on_event = on_event or (lambda *a: None)
        self.safety = safety or Safety()
        self.flightlog = flightlog or FlightLog(clock=clock)
        self.clock = clock
        self.state_stale = state_stale
        self.rc_period = 1.0 / rc_hz
        self.wifi_poll = wifi_poll
        self.wifi_first = wifi_first

        self.target: Optional[tuple[str, int]] = None
        self.cmd_tr: Optional[asyncio.DatagramTransport] = None
        self.state_tr: Optional[asyncio.DatagramTransport] = None
        self.state_port_bound: Optional[int] = None

        self._resp_q: asyncio.Queue[str] = asyncio.Queue()
        self._lock = asyncio.Lock()
        self._interrupt = asyncio.Event()
        self._tasks: list[asyncio.Task] = []

        self.asking = False
        self.asking_cmd: Optional[str] = None
        self.sdk_ok = False
        self.sdk_at = -1e9
        self.state: dict[str, Any] = {}
        self.state_time = -1e9
        self.airborne = False
        self.rc: tuple[int, int, int, int] = RC_ZERO
        self.rc_time = -1e9
        self.rc_sent: tuple[int, int, int, int] = RC_ZERO
        self.rc_count = 0
        self.wifi: Optional[int] = None
        self.battery = BatteryEstimator()
        self.last = ""
        self._net_err: Optional[str] = None
        self._silence_logged = False
        self._control_lost = False
        self._was_connected = False
        self.sent_log: list[str] = []      # 最近送出的非 rc 指令（給測試與診斷）
        self.limits = {"ceiling": config.CEILING_DEFAULT, "low_bat": config.LOW_BAT_LAND_DEFAULT}
        self.info: dict[str, Any] = {"sdk": None, "sn": None}   # 連上後查一次 sdk? / sn?
        self.ceiling_hit_at = -1e9         # 最近一次因高度上限擋掉「上升」的時間
        self._lowbat_at = -1e9             # 最近一次低電量自動降落

    # ------------------------------------------------------------ 啟動 / 結束
    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._resolve()
        self.cmd_tr, _ = await loop.create_datagram_endpoint(
            lambda: _Proto(self._on_resp, self._on_net_error), local_addr=("0.0.0.0", 0))
        self.state_tr, _ = await loop.create_datagram_endpoint(
            lambda: _Proto(self._on_state, self._on_net_error),
            local_addr=("0.0.0.0", self.s.state_port))
        self.state_port_bound = self.state_tr.get_extra_info("sockname")[1]
        self._tasks = [loop.create_task(c) for c in (self._keep_sdk(), self._rc_loop(), self._wifi_loop())]

    async def shutdown(self) -> None:
        """程式結束：先送 land（如果在空中），再關閉 UDP socket。"""
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks = []
        if self.flying():
            log.warning("程式結束 → 送出降落")
            for _ in range(3):
                self.send("land")
                await asyncio.sleep(0.1)
            self.airborne = False
        for tr in (self.cmd_tr, self.state_tr):
            if tr is not None:
                tr.close()
        self.cmd_tr = self.state_tr = None

    # ------------------------------------------------------------ 低階收送
    def _resolve(self) -> None:
        try:
            ip = socket.gethostbyname(self.s.tello_host)
            self.target = (ip, self.s.cmd_port)
        except OSError as e:
            self._on_net_error(e)

    def send(self, cmd: str) -> bool:
        if self.cmd_tr is None or self.target is None:
            return False
        try:
            self.cmd_tr.sendto(cmd.encode(), self.target)
        except OSError as e:
            self._on_net_error(e)
            return False
        if cmd.startswith("rc "):
            self.rc_count += 1
        else:
            self.sent_log.append(cmd)
            del self.sent_log[:-50]
        return True

    def _on_net_error(self, exc: Exception) -> None:
        msg = str(exc)
        if msg != self._net_err:
            self._net_err = msg
            self.diag.net_error = msg
            log.warning("網路錯誤（Wi-Fi 有連到 TELLO-XXXXXX 嗎？）：%s", msg)

    def _from_tello(self, addr: Any) -> bool:
        return self.target is None or (addr and addr[0] == self.target[0])

    def _on_resp(self, data: bytes, addr: Any) -> None:
        if not self._from_tello(addr):
            self.diag.stray_responses += 1
            return
        if self._net_err:
            log.info("網路恢復")
            self._net_err = None
            self.diag.net_error = None
        self._resp_q.put_nowait(data.decode("utf-8", "replace").strip())

    def _on_state(self, data: bytes, addr: Any) -> None:
        st = parse_state(data)
        if not st:
            return
        now = self.clock()
        self.state = st
        self.state_time = now
        self.diag.state.add(len(data))
        self.diag.state_source = f"{addr[0]}:{addr[1]}" if addr else None
        bat = st.get("bat")
        self.battery.update(now, bat if isinstance(bat, int) else None, self.flying())
        self.flightlog.sample(st, self.rc_sent, self.flying(), now)
        self._check_low_battery(now, bat)
        if self.sdk_ok and not self._was_connected:
            self._was_connected = True
            log.info("已連上 Tello（SDK 模式，狀態封包正常）")
            self.on_event("ok", "link_ok", "已連上 Tello")
            if self.info["sdk"] is None:
                asyncio.ensure_future(self._query_info())

    async def _query_info(self) -> None:
        """連上後查一次韌體 SDK 版本與序號（舊韌體 sdk? 會回 unknown command）。"""
        await asyncio.sleep(0.3)
        for key, cmd in (("sdk", "sdk?"), ("sn", "sn?")):
            if not self.connected() or self.flying():
                return
            resp = await self.ask(cmd, 2.0, quiet=True)
            if resp in ("timeout", "interrupted", "network error") or resp.startswith("error") or resp.startswith("unknown"):
                self.info[key] = "unknown" if key == "sdk" else None
                continue
            self.info[key] = resp.strip()
        sdk = self.sdk_version()
        log.info("Tello 韌體 SDK %s，序號 %s", self.info["sdk"], self.info["sn"])
        if sdk is not None and sdk < 20:
            self.on_event("warn", "sdk_old", f"韌體 SDK {self.info['sdk']}：不支援 stop（任務中止用）與下視鏡頭，建議用官方 App 更新韌體")

    def sdk_version(self) -> Optional[int]:
        """sdk? 的回應轉成整數（'20' → 20、'30' → 30）；查不到回 None。"""
        v = self.info.get("sdk")
        if not isinstance(v, str):
            return None
        m = re.search(r"\d+", v)
        return int(m.group()) if m else None

    # ------------------------------------------------------------ 指令
    def _drain(self) -> None:
        while True:
            try:
                self._resp_q.get_nowait()
            except asyncio.QueueEmpty:
                return

    async def _wait_resp(self, timeout: float) -> str:
        get = asyncio.ensure_future(self._resp_q.get())
        intr = asyncio.ensure_future(self._interrupt.wait())
        try:
            done, _ = await asyncio.wait({get, intr}, timeout=timeout,
                                         return_when=asyncio.FIRST_COMPLETED)
        finally:
            for f in (get, intr):
                if not f.done():
                    f.cancel()
        if intr in done:
            return "interrupted"
        if get in done:
            return get.result()
        return "timeout"

    async def ask(self, cmd: str, timeout: float = 5.0, quiet: bool = False) -> str:
        async with self._lock:
            self.asking = True               # 暫停 rc，避免回應對錯指令
            self.asking_cmd = cmd
            self._interrupt.clear()
            rtt: Optional[float] = None
            try:
                if self.flying() and not cmd.endswith("?"):
                    self.send(rc_command(RC_ZERO))   # 暫停 rc 前先歸零（修法 2）
                self._drain()
                t0 = self.clock()
                if not self.send(cmd):
                    resp = "network error"
                else:
                    resp = await self._wait_resp(timeout)
                    # 只有查詢類指令的等待時間才是網路 RTT（takeoff/flip 要等動作完成）
                    if resp not in ("timeout", "interrupted") and (cmd == "command" or cmd.endswith("?")):
                        rtt = self.clock() - t0
            finally:
                self.asking = False
                self.asking_cmd = None
        self.diag.record_rtt(cmd, resp, rtt)
        if not quiet:
            self.flightlog.command(cmd, resp)
            self.last = f"{cmd} → {resp}"
            log.info(self.last)
        return resp

    def immediate(self, cmd: str) -> None:
        """land / emergency：不排隊、不等回應。進行中的 ask 立即回傳 interrupted。"""
        self.send(cmd)
        self.airborne = False
        self.flightlog.command(cmd, "sent")
        if self.asking:
            self._interrupt.set()
        self.last = f"{cmd} → 已送出"
        log.warning(self.last)

    def cancel_move(self) -> None:
        """任務中止：進行中的移動指令立刻回 interrupted，並送 stop 讓 Tello 懸停（rc 迴圈隨後接手）。"""
        if self.asking and self.asking_cmd and is_move(self.asking_cmd) and self.asking_cmd != "stop":
            if self.flying():
                self.send("stop")
                self.flightlog.command("stop", "sent")
            self._interrupt.set()

    async def command(self, raw: object) -> str:
        cmd = normalize_cmd(raw)
        if cmd in IMMEDIATE_CMDS:
            self.immediate(cmd)
            return "sent"
        timeout = ask_timeout(cmd)
        if timeout is None:
            return "denied"
        if cmd == "takeoff":
            if not self.connected():
                return "error 尚未連上 Tello"
            if self.flying():
                return "denied 已經在空中"
            self.airborne = True              # 先假設可能起飛，讓斷訊保護生效
            resp = await self.ask(cmd, ASK_CMDS[cmd])
            if classify(resp) == "error":
                self.airborne = False
            elif resp == "interrupted":
                pass                          # land/emergency 已把 airborne 設成 False
            return resp
        if cmd in FLIP_CMDS:
            bat = self.state.get("bat")
            if not isinstance(bat, int) or bat < FLIP_MIN_BATTERY:
                return f"denied 電量低於 {FLIP_MIN_BATTERY}%"
            if not self.flying():
                return "denied 不在空中"
        if is_move(cmd) and not self.flying():
            return "denied 不在空中"
        resp = await self.ask(cmd, timeout)
        if cmd == "wifi?":
            self.wifi = parse_wifi(resp)
        return resp

    # ------------------------------------------------------------ 飛行限制
    def set_limits(self, raw: object) -> dict:
        """高度上限（0 或 50–1000 cm）與低電量自動降落（0–30%）；壞資料保留原值。"""
        d = raw if isinstance(raw, dict) else {}

        def num(v, lo, hi, cur, zero_ok=True):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
                return cur
            v = int(round(v))
            if v <= 0:
                return 0 if zero_ok else cur
            return max(lo, min(hi, v))
        self.limits = {
            "ceiling": num(d.get("ceiling"), config.CEILING_MIN, config.CEILING_MAX, self.limits["ceiling"]),
            "low_bat": num(d.get("low_bat"), 1, config.LOW_BAT_LAND_MAX, self.limits["low_bat"]),
        }
        return dict(self.limits)

    def _apply_ceiling(self, rc: tuple[int, int, int, int], now: float) -> tuple[int, int, int, int]:
        c = self.limits["ceiling"]
        if c and rc[2] > 0 and self.height() >= c:
            self.ceiling_hit_at = now
            return (rc[0], rc[1], 0, rc[3])
        return rc

    def _check_low_battery(self, now: float, bat: object) -> None:
        lb = self.limits["low_bat"]
        if not lb or not isinstance(bat, int) or bat > lb or not self.flying():
            return
        if now - self._lowbat_at < config.LOW_BAT_RESEND:
            return
        self._lowbat_at = now
        self.immediate("land")
        self.flightlog.command("land", f"low-bat {bat}%")
        msg = f"電量 {bat}% ≤ {lb}% → 自動降落"
        log.warning(msg)
        self.on_event("danger", "low_bat_land", msg)

    # ------------------------------------------------------------ 來自 UI
    def set_rc(self, vals: object) -> None:
        self.rc = clamp_rc(vals)
        self.rc_time = self.clock()
        self._control_lost = False

    def touch(self) -> None:
        """收到機長的任何訊息都代表控制端還活著。"""
        self.rc_time = self.clock()
        self._control_lost = False

    def control_lost(self) -> None:
        """機長的 WebSocket 斷線 → 立刻懸停（不必等 0.5 秒）；8 秒降落仍從最後一次 rc 起算。"""
        self.rc = RC_ZERO
        self._control_lost = True

    # ------------------------------------------------------------ 狀態查詢
    def height(self) -> int:
        h = self.state.get("h", 0)
        return h if isinstance(h, int) else 0

    def flying(self) -> bool:
        return self.airborne or self.height() > config.AIRBORNE_HEIGHT

    def state_age(self) -> float:
        return self.clock() - self.state_time

    def connected(self) -> bool:
        """UI 的「已連線」：SDK 模式而且真的有收到狀態封包。"""
        return self.sdk_ok and self.state_age() <= self.state_stale

    # ------------------------------------------------------------ 背景迴圈
    async def _keep_sdk(self) -> None:
        while True:
            now = self.clock()
            if not self.safety.silenced:
                stale = now - max(self.state_time, self.sdk_at) > self.state_stale
                if self.sdk_ok and stale:
                    if self.flying():
                        self.send(rc_command(RC_ZERO))   # 停止送 rc 前先歸零（修法 2）
                    self.sdk_ok = False
                    if self._was_connected:            # 只在「真的連上過」之後通報一次，避免洗版
                        self._was_connected = False
                        log.warning("Tello 狀態中斷，重新連線中…")
                        self.on_event("danger", "link_lost", "Tello 狀態封包中斷，重新連線中…")
                if not self.sdk_ok:
                    self._resolve()
                    if await self.ask("command", 2.0, quiet=True) == "ok":
                        self.sdk_ok = True
                        self.sdk_at = self.clock()
                        log.info("Tello 回應 command → SDK 模式，等待狀態封包…")
            await asyncio.sleep(1.0)

    async def _rc_loop(self) -> None:
        while True:
            t0 = self.clock()
            if self.sdk_ok and not self.asking:
                d = self.safety.tick(t0, self.rc_time, self.rc, self.flying(), self._control_lost)
                if d.land:
                    n = self.safety.land_tries
                    self.send("land")
                    self.airborne = False
                    self.flightlog.command("land", f"auto-land {n}")
                    self.last = f"控制端斷訊 → 自動降落（第 {n} 次）"
                    log.warning(self.last)
                    self.on_event("danger", "auto_land", self.last)
                elif d.reason == "silenced" and self.safety.land_tries and not self._silence_logged:
                    self._silence_logged = True
                    msg = "自動降落 3 次後遙測仍在空中 → 停止送出指令，交給 Tello 內建 15 秒逾時降落"
                    log.error(msg)
                    self.on_event("danger", "silenced", msg)
                if d.rc is not None:
                    self._silence_logged = False
                    rc = self._apply_ceiling(d.rc, t0)
                    self.send(rc_command(rc))
                    self.rc_sent = rc
            await asyncio.sleep(max(0.0, self.rc_period - (self.clock() - t0)))

    async def _wifi_loop(self) -> None:
        while True:
            # 還沒拿到訊號強度時每 wifi_first 秒試一次（連上後很快就有數值），之後每 WIFI_POLL 秒
            await asyncio.sleep(self.wifi_first if self.wifi is None else self.wifi_poll)
            if self.connected() and not self.safety.silenced and not self._lock.locked():
                resp = await self.ask("wifi?", 1.0, quiet=True)
                w = parse_wifi(resp)
                if w is not None:
                    self.wifi = w

    # ------------------------------------------------------------ 給 UI 的遙測
    def telemetry(self) -> dict:
        st = self.state
        now = self.clock()
        bat = st.get("bat") if isinstance(st.get("bat"), int) else None
        return {
            "connected": self.connected(),
            "sdk": self.sdk_ok,
            "state_age": round(min(self.state_age(), 9999.0), 2),
            "bat": bat,
            "h": st.get("h"), "tof": st.get("tof"),
            "templ": st.get("templ"), "temph": st.get("temph"),
            "pitch": st.get("pitch"), "roll": st.get("roll"), "yaw": st.get("yaw"),
            "vgx": st.get("vgx"), "vgy": st.get("vgy"), "vgz": st.get("vgz"),
            "time": st.get("time"), "baro": st.get("baro"),
            "wifi": self.wifi,
            "airborne": self.airborne, "flying": self.flying(),
            "asking": self.asking_cmd,
            "remaining_s": self.battery.remaining_s(bat),
            "remaining_measured": self.battery.measured,
            "safety": self.safety.status(now, self.rc_time, self._control_lost),
            "rc_sent": list(self.rc_sent),
            "last": self.last,
            "flight_n": self.flightlog.current.n if self.flightlog.current else None,
            "limits": dict(self.limits),
            "info": dict(self.info),
            "ceiling_hit": now - self.ceiling_hit_at < 1.0,
        }
