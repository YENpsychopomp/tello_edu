"""Tello SDK 協定的純函式部分：白名單、rc 夾限、狀態解析、回應分類、電量估算。

這裡沒有任何 I/O，全部可以直接單元測試。
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

from . import config

# 需要等回應的指令（白名單）與逾時秒數 —— 沿用原型
ASK_CMDS: dict[str, float] = {
    "takeoff": 12.0, "streamon": 5.0, "streamoff": 5.0,
    "flip l": 5.0, "flip r": 5.0, "flip f": 5.0, "flip b": 5.0,
    "battery?": 3.0, "sdk?": 3.0, "sn?": 3.0, "wifi?": 3.0,
    # 切換影像來源：0 前鏡頭、1 下視鏡頭（SDK 3.0；舊韌體回 error／unknown command）
    "downvision 0": 3.0, "downvision 1": 3.0,
    "stop": 5.0,            # 懸停（中斷進行中的移動）
}
# 不排隊、不等回應、立即送出（安全相關，不能被其他指令卡住）
IMMEDIATE_CMDS = frozenset({"land", "emergency"})
FLIP_CMDS = frozenset({"flip l", "flip r", "flip f", "flip b"})
FLIP_MIN_BATTERY = 50

RC_ZERO = (0, 0, 0, 0)


def normalize_cmd(cmd: object) -> str:
    return " ".join(str(cmd or "").strip().lower().split())


# ---- 任務腳本用的移動指令（樣式比對＋範圍檢查；逾時依距離估算）----
_MOVE_RE = re.compile(r"^(up|down|left|right|forward|back) (\d{1,4})$")
_TURN_RE = re.compile(r"^(cw|ccw) (\d{1,4})$")
_GO_RE = re.compile(r"^go (-?\d{1,4}) (-?\d{1,4}) (-?\d{1,4}) (\d{1,3})$")
_CURVE_RE = re.compile(r"^curve (-?\d{1,4}) (-?\d{1,4}) (-?\d{1,4}) (-?\d{1,4}) (-?\d{1,4}) (-?\d{1,4}) (\d{1,3})$")
_SPEED_RE = re.compile(r"^speed (\d{1,3})$")
MOVE_MIN, MOVE_MAX = 20, 500
TURN_MIN, TURN_MAX = 1, 360
GO_MAX = 500
SPEED_MIN, SPEED_MAX, CURVE_SPEED_MAX = 10, 100, 60
MOVE_TIMEOUT_MAX = 40.0


def _move_timeout(dist_cm: float, speed_cm_s: float) -> float:
    return min(MOVE_TIMEOUT_MAX, 5.0 + dist_cm / max(10.0, speed_cm_s))


def move_info(cmd: str) -> Optional[dict]:
    """移動類指令：回 {"error": None|訊息, "timeout": 秒, "flying_only": bool}；不是移動類指令回 None。"""
    m = _MOVE_RE.match(cmd)
    if m:
        d = int(m.group(2))
        err = None if MOVE_MIN <= d <= MOVE_MAX else f"{m.group(1)} 的距離要在 {MOVE_MIN}–{MOVE_MAX} 公分之間"
        return {"error": err, "timeout": _move_timeout(d, 15.0), "flying_only": True}
    m = _TURN_RE.match(cmd)
    if m:
        a = int(m.group(2))
        err = None if TURN_MIN <= a <= TURN_MAX else f"{m.group(1)} 的角度要在 {TURN_MIN}–{TURN_MAX} 度之間"
        return {"error": err, "timeout": min(MOVE_TIMEOUT_MAX, 5.0 + a / 40.0), "flying_only": True}
    m = _GO_RE.match(cmd)
    if m:
        x, y, z, sp = (int(v) for v in m.groups())
        err = None
        if max(abs(x), abs(y), abs(z)) > GO_MAX:
            err = f"go 的 x/y/z 要在 -{GO_MAX}–{GO_MAX} 公分之間"
        elif max(abs(x), abs(y), abs(z)) < MOVE_MIN:
            err = f"go 的 x/y/z 至少要有一個大於等於 {MOVE_MIN} 公分"
        elif not SPEED_MIN <= sp <= SPEED_MAX:
            err = f"go 的速度要在 {SPEED_MIN}–{SPEED_MAX} 之間"
        dist = (x * x + y * y + z * z) ** 0.5
        return {"error": err, "timeout": _move_timeout(dist, sp), "flying_only": True}
    m = _CURVE_RE.match(cmd)
    if m:
        v = [int(t) for t in m.groups()]
        p1, p2, sp = v[0:3], v[3:6], v[6]
        err = None
        if max(abs(t) for t in v[:6]) > GO_MAX:
            err = f"curve 的座標要在 -{GO_MAX}–{GO_MAX} 公分之間"
        elif max(abs(t) for t in p1) < MOVE_MIN or max(abs(t) for t in p2) < MOVE_MIN:
            err = f"curve 的兩個點都至少要有一個座標大於等於 {MOVE_MIN} 公分"
        elif not SPEED_MIN <= sp <= CURVE_SPEED_MAX:
            err = f"curve 的速度要在 {SPEED_MIN}–{CURVE_SPEED_MAX} 之間"
        d1 = sum(t * t for t in p1) ** 0.5
        d2 = sum((a - b) ** 2 for a, b in zip(p2, p1)) ** 0.5
        return {"error": err, "timeout": _move_timeout(d1 + d2, sp), "flying_only": True}
    m = _SPEED_RE.match(cmd)
    if m:
        sp = int(m.group(1))
        err = None if SPEED_MIN <= sp <= SPEED_MAX else f"speed 要在 {SPEED_MIN}–{SPEED_MAX} 之間"
        return {"error": err, "timeout": 3.0, "flying_only": False}
    return None


def is_move(cmd: str) -> bool:
    """會讓無人機移動的指令（只能在空中送）。"""
    mi = move_info(cmd)
    return (mi is not None and mi["flying_only"]) or cmd == "stop"


def ask_timeout(cmd: str) -> Optional[float]:
    """允許的「等回應」指令回逾時秒數；不允許（含範圍錯誤）回 None。"""
    if cmd in ASK_CMDS:
        return ASK_CMDS[cmd]
    mi = move_info(cmd)
    if mi is not None and mi["error"] is None:
        return mi["timeout"]
    return None


def is_allowed(cmd: str) -> bool:
    return cmd in IMMEDIATE_CMDS or ask_timeout(cmd) is not None


def clamp_rc(vals: object) -> tuple[int, int, int, int]:
    """把任意輸入變成 4 個 -100..100 的整數；壞資料一律當 0。"""
    def one(v: object) -> int:
        if isinstance(v, bool):
            return 0
        try:
            f = float(v)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return 0
        if f != f:  # NaN
            return 0
        if f >= 100:
            return 100
        if f <= -100:
            return -100
        return int(round(f))

    if not isinstance(vals, (list, tuple)):
        vals = []
    vs = [one(v) for v in list(vals)[:4]] + [0] * 4
    return (vs[0], vs[1], vs[2], vs[3])


def rc_command(rc: Iterable[int]) -> str:
    a, b, c, d = rc
    return f"rc {a} {b} {c} {d}"


# ---- 狀態封包 ----
INT_FIELDS = ("bat", "h", "tof", "templ", "temph", "pitch", "roll", "yaw",
              "vgx", "vgy", "vgz", "time", "mid", "x", "y", "z")
FLOAT_FIELDS = ("baro", "agx", "agy", "agz")


def parse_state(data: bytes | str) -> dict[str, float | int | str]:
    """解析 'pitch:0;roll:0;...;\\r\\n'。未知欄位保留原始字串，數值欄位轉型失敗就略過。"""
    if isinstance(data, bytes):
        data = data.decode("utf-8", "replace")
    out: dict[str, float | int | str] = {}
    for kv in data.strip().split(";"):
        if ":" not in kv:
            continue
        k, v = kv.split(":", 1)
        k, v = k.strip(), v.strip()
        if not k:
            continue
        if k in INT_FIELDS:
            try:
                out[k] = int(float(v))
            except ValueError:
                continue
        elif k in FLOAT_FIELDS:
            try:
                out[k] = float(v)
            except ValueError:
                continue
        else:
            out[k] = v
    return out


def parse_wifi(resp: str) -> Optional[int]:
    """wifi? 回應通常是純數字（SNR），某些韌體會帶前綴。"""
    if not resp or resp.startswith("error") or resp in ("timeout", "interrupted", "network error"):
        return None
    m = re.search(r"-?\d+", resp)
    return int(m.group()) if m else None


def classify(resp: str) -> str:
    """把回應歸類成 UI 的 ok / error / timeout / interrupted / sent / denied。"""
    r = (resp or "").strip().lower()
    if r == "ok":
        return "ok"
    if r == "timeout":
        return "timeout"
    if r == "interrupted":
        return "interrupted"
    if r == "sent":
        return "sent"
    if r.startswith("denied") or r == "not allowed":
        return "denied"
    if r.startswith("error") or r.startswith("unknown command") or r == "network error" or r == "false":
        return "error"
    return "ok"  # 查詢指令（battery? 等）回的是數值


def takeoff_error_hint(resp: str, bat: Optional[int], temph: Optional[int],
                       temp_limit: int = 85) -> dict:
    """takeoff 回 error 時推測原因。Tello 沒有「未啟用」專屬錯誤碼，只能推測。"""
    r = (resp or "").lower()
    others = []
    if bat is not None and bat < 10:
        primary = "電量過低（低於 10% 時 Tello 會拒絕起飛）"
    elif temph is not None and temph >= temp_limit:
        primary = "機身溫度過高，請關機散熱 5–10 分鐘"
    elif "motor" in r or "imu" in r:
        primary = "IMU 或馬達異常，請把 Tello 放在平坦地面重新開機"
    else:
        primary = "最可能是這台 Tello 尚未啟用：請先用官方 Tello App 或 TelloFPV 連線啟用一次"
    others = [
        "電量過低（< 10%）",
        "機身過熱",
        "未放在平坦地面、IMU 需要校正",
        "螺旋槳卡住或保護罩變形",
        "尚未用官方 App 啟用",
    ]
    return {"primary": primary, "others": others, "raw": resp}


class BatteryEstimator:
    """用飛行中實測的放電率（EMA）預估剩餘飛行時間。

    沒有實測資料時用 DEFAULT_FLIGHT_MIN × 電量%。
    """

    ALPHA = 0.3

    def __init__(self, full_minutes: float = config.DEFAULT_FLIGHT_MIN,
                 reserve: int = config.BATTERY_RESERVE):
        self.default_rate = 100.0 / (full_minutes * 60.0)  # %/s
        self.reserve = reserve
        self.rate: Optional[float] = None
        self._last_bat: Optional[int] = None
        self._last_t: Optional[float] = None
        self.measured = False

    def update(self, now: float, bat: Optional[int], flying: bool) -> None:
        if bat is None:
            return
        if not flying:
            # 落地時保留已學到的放電率，但重設取樣點
            self._last_bat, self._last_t = bat, now
            return
        if self._last_bat is None or self._last_t is None or bat > self._last_bat:
            self._last_bat, self._last_t = bat, now
            return
        if self._last_bat - bat > 5:
            # 一次掉超過 5%（電壓驟降、換電池讀值跳動）不拿來估算，只重設取樣點
            self._last_bat, self._last_t = bat, now
            return
        if bat < self._last_bat:
            dt = now - self._last_t
            if dt > 0.5:
                inst = (self._last_bat - bat) / dt
                self.rate = inst if self.rate is None else (self.ALPHA * inst + (1 - self.ALPHA) * self.rate)
                self.measured = True
            self._last_bat, self._last_t = bat, now

    def remaining_s(self, bat: Optional[int]) -> Optional[int]:
        if bat is None:
            return None
        rate = self.rate if self.rate else self.default_rate
        return int(max(0.0, bat - self.reserve) / rate)
