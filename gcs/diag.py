"""診斷計數器：滑動視窗的每秒封包數、位元率、指令 RTT。"""
from __future__ import annotations

import time
from collections import deque
from typing import Callable, Optional


class Rate:
    """最近 window 秒內的事件數與位元組數。"""

    def __init__(self, window: float = 2.0, clock: Callable[[], float] = time.monotonic):
        self.window = window
        self.clock = clock
        self.events: deque[tuple[float, int]] = deque()
        self.total = 0
        self.total_bytes = 0
        self.last_at: Optional[float] = None

    def add(self, nbytes: int = 0) -> None:
        now = self.clock()
        self.events.append((now, nbytes))
        self.total += 1
        self.total_bytes += nbytes
        self.last_at = now
        self._trim(now)

    def _trim(self, now: float) -> None:
        cutoff = now - self.window
        while self.events and self.events[0][0] < cutoff:
            self.events.popleft()

    def per_sec(self) -> float:
        self._trim(self.clock())
        return len(self.events) / self.window

    def bytes_per_sec(self) -> float:
        self._trim(self.clock())
        return sum(n for _, n in self.events) / self.window

    def age(self) -> Optional[float]:
        return None if self.last_at is None else self.clock() - self.last_at


class Diag:
    def __init__(self) -> None:
        self.state = Rate()
        self.video = Rate()
        self.au = Rate()
        self.keyframes = 0
        self.cmd_sent = 0
        self.cmd_ok = 0
        self.cmd_timeouts = 0
        self.cmd_errors = 0
        self.rtts: deque[float] = deque(maxlen=50)
        self.last_rtt: Optional[float] = None
        self.last_cmd: str = ""
        self.last_resp: str = ""
        self.ever_cmd_resp = False
        self.state_source: Optional[str] = None
        self.video_source: Optional[str] = None
        self.stray_responses = 0
        self.net_error: Optional[str] = None
        self.codec: Optional[str] = None
        self.video_drops = 0
        self.ws_control = 0
        self.ws_video = 0
        self.ws_mjpeg = 0
        self.ffmpeg_running = False

    def record_rtt(self, cmd: str, resp: str, rtt: Optional[float]) -> None:
        self.cmd_sent += 1
        self.last_cmd, self.last_resp = cmd, resp
        if resp == "timeout":
            self.cmd_timeouts += 1
        elif resp.startswith("error") or resp == "network error":
            self.cmd_errors += 1
            if resp != "network error":
                self.ever_cmd_resp = True
        elif resp != "interrupted":
            self.cmd_ok += 1
            self.ever_cmd_resp = True
        if rtt is not None:
            self.last_rtt = rtt
            self.rtts.append(rtt)

    def snapshot(self) -> dict:
        rtts = list(self.rtts)
        return {
            "cmd": {
                "sent": self.cmd_sent, "ok": self.cmd_ok, "timeouts": self.cmd_timeouts,
                "errors": self.cmd_errors, "last_cmd": self.last_cmd, "last_resp": self.last_resp,
                "rtt_ms": None if self.last_rtt is None else round(self.last_rtt * 1000, 1),
                "rtt_avg_ms": round(sum(rtts) / len(rtts) * 1000, 1) if rtts else None,
                "rtt_max_ms": round(max(rtts) * 1000, 1) if rtts else None,
                "ever_resp": self.ever_cmd_resp, "stray": self.stray_responses,
                "net_error": self.net_error,
            },
            "state": {
                "pps": round(self.state.per_sec(), 1), "total": self.state.total,
                "age": None if self.state.age() is None else round(self.state.age(), 2),
                "source": self.state_source,
            },
            "video": {
                "pps": round(self.video.per_sec(), 1), "total": self.video.total,
                "kbps": round(self.video.bytes_per_sec() * 8 / 1000, 1),
                "fps": round(self.au.per_sec(), 1), "keyframes": self.keyframes,
                "age": None if self.video.age() is None else round(self.video.age(), 2),
                "codec": self.codec, "drops": self.video_drops, "source": self.video_source,
                "ffmpeg_running": self.ffmpeg_running,
            },
            "ws": {"control": self.ws_control, "video": self.ws_video, "mjpeg": self.ws_mjpeg},
        }
