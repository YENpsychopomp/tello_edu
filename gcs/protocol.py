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
}
# 不排隊、不等回應、立即送出（安全相關，不能被其他指令卡住）
IMMEDIATE_CMDS = frozenset({"land", "emergency"})
FLIP_CMDS = frozenset({"flip l", "flip r", "flip f", "flip b"})
FLIP_MIN_BATTERY = 50

RC_ZERO = (0, 0, 0, 0)


def normalize_cmd(cmd: object) -> str:
    return " ".join(str(cmd or "").strip().lower().split())


def is_allowed(cmd: str) -> bool:
    return cmd in ASK_CMDS or cmd in IMMEDIATE_CMDS


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
    if r in ("denied", "not allowed"):
        return "denied"
    if r.startswith("error") or r == "network error" or r == "false":
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
