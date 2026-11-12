"""集中管理所有可調參數。環境變數只在這裡讀取。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


# ---- 安全時序（沿用原型已驗證的數值）----
RC_HZ = 20              # 送給 Tello 的 rc 頻率（與瀏覽器送來的頻率脫鉤）
HOVER_AFTER = 0.5       # 超過這麼久沒收到 rc → 送 rc 0 0 0 0 懸停
LAND_AFTER = 8.0        # 超過這麼久沒收到 rc → 自動降落
LAND_RETRY_AFTER = 5.0  # 自動降落送出後，遙測仍顯示在空中多久才重送
LAND_MAX_TRIES = 3      # 自動降落最多送幾次；全部失敗就停止送 rc，交給 Tello 內建的 15 秒逾時
STATE_STALE = 3.0       # 狀態封包超過這麼久沒進來 → 視為斷線並重送 command
WIFI_POLL = 5.0         # 每隔多久查一次 wifi?
AIRBORNE_HEIGHT = 20    # h 超過幾公分就視為在空中（即使旗標是 False）
TELEMETRY_HZ = 10       # 推給瀏覽器的遙測頻率

# ---- 電量估算 ----
DEFAULT_FLIGHT_MIN = 13.0   # 滿電飛行時間（分鐘），沒有實測資料時使用
BATTERY_RESERVE = 10        # 預估剩餘時間算到這個百分比為止


@dataclass
class Settings:
    tello_host: str = field(default_factory=lambda: os.environ.get("TELLO_IP", "192.168.10.1"))
    cmd_port: int = field(default_factory=lambda: _env_int("TELLO_CMD_PORT", 8889))
    state_port: int = field(default_factory=lambda: _env_int("STATE_PORT", 8890))
    video_port: int = field(default_factory=lambda: _env_int("VIDEO_PORT", 11111))
    http_host: str = field(default_factory=lambda: os.environ.get("HTTP_HOST", "127.0.0.1"))
    http_port: int = field(default_factory=lambda: _env_int("HTTP_PORT", 8080))
    # 瀏覽器看到的 port（Docker 若把 8080 映射成別的 port，要設 PUBLIC_PORT）
    public_port: int = field(default_factory=lambda: _env_int("PUBLIC_PORT", _env_int("HTTP_PORT", 8080)))
    sim: bool = field(default_factory=lambda: _env_bool("TELLO_SIM"))
    in_docker: bool = field(default_factory=lambda: _env_bool("GCS_IN_DOCKER") or os.path.exists("/.dockerenv"))
    extra_origins: str = field(default_factory=lambda: os.environ.get("GCS_ALLOWED_ORIGINS", ""))

    @property
    def allowed_origins(self) -> set[str]:
        o = {f"http://localhost:{self.public_port}", f"http://127.0.0.1:{self.public_port}"}
        o.update(x.strip() for x in self.extra_origins.split(",") if x.strip())
        return o
