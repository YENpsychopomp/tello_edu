"""飛行紀錄（黑盒子）：每一筆狀態封包、送出的指令與回應、事件，全部留在記憶體的環形緩衝區。

* 起飛→降落自動切成一趟「飛行」，落地後算出摘要（時間、最高高度、最大速度、用電、里程）
* 匯出 CSV（可以只匯出某一趟）或 JSON，給真機測試後對照：ToF 怎麼變、vgx 單位、rc 對應到多快
* 純邏輯、時間由呼叫端傳入，可以直接單元測試
"""
from __future__ import annotations

import csv
import io
import math
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Optional

# 狀態封包裡要記錄的欄位（順序就是 CSV 的欄位順序）
STATE_FIELDS = ("bat", "h", "tof", "pitch", "roll", "yaw", "vgx", "vgy", "vgz", "templ", "temph",
                "baro", "time", "mid", "x", "y", "z")
CSV_HEADER = ("t", "wall", "flight", "flying", *STATE_FIELDS, "rc_a", "rc_b", "rc_c", "rc_d", "cmd", "resp")

END_GRACE = 1.5         # 遙測顯示不在空中持續這麼久才算落地（避免 h 短暫跳動切成兩趟）
MAX_SAMPLES = 36000     # 10 Hz × 1 小時
MAX_FLIGHTS = 50
# Tello 的 vgx/vgy/vgz 是 dm/s（模擬器也照這個單位）；真機請用這份紀錄對照
SPEED_UNIT = 0.1


@dataclass
class Flight:
    n: int
    t0: float                       # 單調時鐘（秒）
    wall0: float                    # time.time()
    t1: Optional[float] = None
    wall1: Optional[float] = None
    bat0: Optional[int] = None
    bat1: Optional[int] = None
    max_h: int = 0
    max_speed: float = 0.0          # m/s（水平）
    max_vz: float = 0.0             # m/s（絕對值）
    max_temp: Optional[int] = None
    distance: float = 0.0           # m（水平速度積分，粗估）
    samples: int = 0
    cmds: list[str] = field(default_factory=list)   # 這趟送出的非 rc 指令（去重後最多 30 個）
    _last_t: Optional[float] = None

    @property
    def done(self) -> bool:
        return self.t1 is not None

    def duration(self, now: Optional[float] = None) -> float:
        end = self.t1 if self.t1 is not None else (now if now is not None else self.t0)
        return max(0.0, end - self.t0)

    def feed(self, now: float, st: dict[str, Any]) -> None:
        self.samples += 1
        bat = st.get("bat")
        if isinstance(bat, int):
            if self.bat0 is None:
                self.bat0 = bat
            self.bat1 = bat
        h = st.get("h")
        if isinstance(h, int):
            self.max_h = max(self.max_h, h)
        vx, vy, vz = (st.get(k) for k in ("vgx", "vgy", "vgz"))
        if isinstance(vx, (int, float)) and isinstance(vy, (int, float)):
            sp = math.hypot(vx, vy) * SPEED_UNIT
            self.max_speed = max(self.max_speed, sp)
            if self._last_t is not None:
                self.distance += sp * min(1.0, max(0.0, now - self._last_t))
        if isinstance(vz, (int, float)):
            self.max_vz = max(self.max_vz, abs(vz) * SPEED_UNIT)
        th = st.get("temph")
        if isinstance(th, int):
            self.max_temp = th if self.max_temp is None else max(self.max_temp, th)
        self._last_t = now

    def to_dict(self, now: Optional[float] = None) -> dict[str, Any]:
        d = asdict(self)
        d.pop("_last_t", None)
        d["duration_s"] = round(self.duration(now), 1)
        d["bat_used"] = (self.bat0 - self.bat1) if self.bat0 is not None and self.bat1 is not None else None
        d["max_speed"] = round(self.max_speed, 2)
        d["max_vz"] = round(self.max_vz, 2)
        d["distance"] = round(self.distance, 1)
        d["done"] = self.done
        return d

    def summary_text(self, now: Optional[float] = None) -> str:
        dur = self.duration(now)
        m, s = divmod(int(round(dur)), 60)
        parts = [f"第 {self.n} 趟飛行 {m} 分 {s:02d} 秒" if m else f"第 {self.n} 趟飛行 {s} 秒",
                 f"最高 {self.max_h / 100:.1f} m", f"最快 {self.max_speed:.1f} m/s"]
        if self.bat0 is not None and self.bat1 is not None:
            parts.append(f"用電 {self.bat0 - self.bat1}%（{self.bat0}% → {self.bat1}%）")
        if self.distance >= 1:
            parts.append(f"約 {self.distance:.0f} m 里程")
        return "、".join(parts)


class FlightLog:
    def __init__(self, clock: Callable[[], float] = time.monotonic, wall: Callable[[], float] = time.time,
                 max_samples: int = MAX_SAMPLES, max_flights: int = MAX_FLIGHTS,
                 on_flight_end: Optional[Callable[[Flight], None]] = None):
        self.clock = clock
        self.wall = wall
        self.on_flight_end = on_flight_end or (lambda f: None)
        self.samples: deque[tuple] = deque(maxlen=max_samples)
        self.cmds: deque[tuple[float, str, str]] = deque(maxlen=500)
        self.events: deque[tuple[float, str, str, str]] = deque(maxlen=300)
        self.flights: deque[Flight] = deque(maxlen=max_flights)
        self.current: Optional[Flight] = None
        self._not_flying_since: Optional[float] = None
        self._pending_cmd: Optional[tuple[str, str]] = None
        self.started_wall = wall()
        self.total_samples = 0

    # ------------------------------------------------------------ 輸入
    def sample(self, st: dict[str, Any], rc: tuple[int, int, int, int], flying: bool,
               now: Optional[float] = None) -> Optional[Flight]:
        """每收到一筆狀態封包呼叫一次。回傳剛結束的那趟飛行（如果這一筆剛好判定落地）。"""
        now = self.clock() if now is None else now
        ended = self._track(now, flying, st)
        cmd, resp = self._pending_cmd or ("", "")
        self._pending_cmd = None
        row = (round(now, 3), round(self.wall(), 3), self.current.n if self.current else (ended.n if ended else ""),
               1 if flying else 0, *(st.get(k, "") for k in STATE_FIELDS), *rc, cmd, resp)
        self.samples.append(row)
        self.total_samples += 1
        return ended

    def command(self, cmd: str, resp: str, now: Optional[float] = None) -> None:
        now = self.clock() if now is None else now
        self.cmds.append((round(now, 3), cmd, resp))
        self._pending_cmd = (cmd, resp)        # 掛到下一筆樣本上，CSV 裡才看得到指令和遙測的對應
        if self.current is not None and cmd not in self.current.cmds and len(self.current.cmds) < 30:
            self.current.cmds.append(cmd)

    def event(self, level: str, code: str, msg: str, now: Optional[float] = None) -> None:
        now = self.clock() if now is None else now
        self.events.append((round(now, 3), level, code, msg))

    def _track(self, now: float, flying: bool, st: dict[str, Any]) -> Optional[Flight]:
        if flying:
            self._not_flying_since = None
            if self.current is None:
                n = (self.flights[-1].n + 1) if self.flights else 1
                self.current = Flight(n=n, t0=now, wall0=self.wall())
                # 起飛指令是在「開始在空中」之前送的，把最近 15 秒內的指令算進這趟
                for t, c, _ in list(self.cmds)[-10:]:
                    if now - t <= 15.0 and c not in self.current.cmds:
                        self.current.cmds.append(c)
            self.current.feed(now, st)
            return None
        if self.current is None:
            return None
        if self._not_flying_since is None:
            self._not_flying_since = now
        self.current.feed(now, st)
        if now - self._not_flying_since < END_GRACE:
            return None
        f = self.current
        f.t1 = self._not_flying_since
        f.wall1 = self.wall() - (now - self._not_flying_since)
        self.flights.append(f)
        self.current = None
        self._not_flying_since = None
        self.on_flight_end(f)
        return f

    # ------------------------------------------------------------ 輸出
    def flight(self, n: int) -> Optional[Flight]:
        if self.current is not None and self.current.n == n:
            return self.current
        for f in self.flights:
            if f.n == n:
                return f
        return None

    def status(self, now: Optional[float] = None) -> dict[str, Any]:
        now = self.clock() if now is None else now
        return {
            "flights": [f.to_dict() for f in self.flights],
            "current": self.current.to_dict(now) if self.current else None,
            "samples": len(self.samples), "total_samples": self.total_samples,
            "since_wall": round(self.started_wall, 3),
            "cmds": len(self.cmds), "events": len(self.events),
        }

    def _window(self, n: Optional[int], pad: float = 3.0) -> Optional[tuple[float, float]]:
        if n is None:
            return None
        f = self.flight(n)
        if f is None:
            return (math.inf, -math.inf)        # 不存在的趟次 → 什麼都不匯出
        return (f.t0 - pad, (f.t1 if f.t1 is not None else math.inf) + pad)

    def rows(self, n: Optional[int] = None) -> list[tuple]:
        w = self._window(n)
        if w is None:
            return list(self.samples)
        return [r for r in self.samples if w[0] <= r[0] <= w[1]]

    def to_csv(self, n: Optional[int] = None) -> str:
        buf = io.StringIO()
        wr = csv.writer(buf, lineterminator="\n")
        wr.writerow(CSV_HEADER)
        wr.writerows(self.rows(n))
        return buf.getvalue()

    def to_json(self, n: Optional[int] = None) -> dict[str, Any]:
        w = self._window(n)
        pick = (lambda t: True) if w is None else (lambda t: w[0] <= t <= w[1])
        return {
            "header": list(CSV_HEADER),
            "samples": [list(r) for r in self.samples if pick(r[0])],
            "cmds": [list(c) for c in self.cmds if pick(c[0])],
            "events": [list(e) for e in self.events if pick(e[0])],
            "flights": [f.to_dict() for f in self.flights if n is None or f.n == n],
            "current": self.current.to_dict(self.clock()) if self.current and (n is None or self.current.n == n) else None,
            "speed_unit": SPEED_UNIT,
        }


def filename(prefix: str, n: Optional[int], ext: str, wall: Optional[float] = None) -> str:
    t = time.localtime(wall if wall is not None else time.time())
    stamp = time.strftime("%Y%m%d-%H%M%S", t)
    return f"{prefix}-{stamp}{f'-flight{n}' if n is not None else ''}.{ext}"
