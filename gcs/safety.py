"""斷訊保護狀態機（純邏輯，時間由呼叫端傳入，方便精確測試時序）。

規則：
  * 超過 HOVER_AFTER 秒沒收到 rc（或 WebSocket 斷線）→ 送 rc 0 0 0 0 懸停
  * 超過 LAND_AFTER 秒且仍在空中 → 送 land（每次斷訊送 1 次）
  * 送出後 LAND_RETRY_AFTER 秒遙測仍顯示在空中 → 重送，最多 LAND_MAX_TRIES 次
  * 最後一次送出後再過 LAND_RETRY_AFTER 秒仍在空中 → 停止送任何指令（silenced），
    讓 Tello 內建的「15 秒沒收到指令自動降落」接手
  * 控制端恢復（又收到 rc）→ 重設，回到正常狀態
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from . import config
from .protocol import RC_ZERO


@dataclass
class Decision:
    rc: Optional[tuple[int, int, int, int]]   # None = 這一拍不要送 rc
    land: bool = False                        # 這一拍要送 land
    reason: str = ""


@dataclass
class Safety:
    hover_after: float = config.HOVER_AFTER
    land_after: float = config.LAND_AFTER
    retry_after: float = config.LAND_RETRY_AFTER
    max_tries: int = config.LAND_MAX_TRIES

    land_tries: int = 0
    last_land_at: float = field(default=-1e9)
    silenced: bool = False      # True = 已放棄，停止送任何指令
    hovering: bool = False

    def reset(self) -> None:
        self.land_tries = 0
        self.last_land_at = -1e9
        self.silenced = False

    def tick(self, now: float, rc_time: float, rc: tuple[int, int, int, int],
             flying: bool, control_lost: bool = False) -> Decision:
        """control_lost=True：機長的 WebSocket 已斷線 → 立刻懸停；降落時間仍從最後一次 rc 起算。"""
        silence = now - rc_time

        if silence <= self.hover_after and not control_lost:
            # 控制端活著：回到正常
            if self.land_tries or self.silenced:
                self.reset()
            self.hovering = False
            return Decision(rc=rc)

        self.hovering = True
        if self.silenced:
            return Decision(rc=None, reason="silenced")

        if silence > self.land_after and flying:
            if self.land_tries == 0:
                self.land_tries = 1
                self.last_land_at = now
                return Decision(rc=RC_ZERO, land=True, reason="auto-land")
            if now - self.last_land_at > self.retry_after:
                if self.land_tries < self.max_tries:
                    self.land_tries += 1
                    self.last_land_at = now
                    return Decision(rc=RC_ZERO, land=True, reason="auto-land-retry")
                self.silenced = True
                return Decision(rc=None, reason="silenced")
        return Decision(rc=RC_ZERO, reason="hover")

    def status(self, now: float, rc_time: float, control_lost: bool = False) -> dict:
        silence = now - rc_time
        if self.silenced:
            phase = "silenced"
        elif self.land_tries:
            phase = "landing"
        elif silence > self.hover_after or control_lost:
            phase = "hover"
        else:
            phase = "normal"
        return {
            "phase": phase,
            "land_tries": self.land_tries,
            "silence": round(min(silence, 9999.0), 2),
            "land_in": round(max(0.0, self.land_after - silence), 1) if phase == "hover" else None,
        }
