"""任務腳本：一行一個 Tello SDK 指令，逐步執行；搖桿一動、降落、停槳、斷線、任何指令失敗都會中止。

腳本格式（# 之後是註解、空行略過、大小寫不拘）：
    takeoff
    up 50
    forward 100      # 公分 20–500
    cw 90            # 度 1–360
    wait 2           # 原地停 2 秒（本機計時，不送指令）
    go 50 0 0 30     # x y z（公分，-500–500）speed 10–100
    flip l
    land

所有指令都經過 protocol.ask_timeout 的白名單與範圍檢查；移動類指令只在空中才會送出。
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Optional

from .protocol import ASK_CMDS, FLIP_CMDS, ask_timeout, classify, is_move, move_info, normalize_cmd

MAX_STEPS = 60
WAIT_MAX = 30.0
STEP_CMDS = frozenset({"takeoff", "land", "stop"}) | FLIP_CMDS


@dataclass
class Step:
    line: int                 # 腳本中的行號（1 起算）
    cmd: str                  # 正規化後的指令；wait 類是 "wait 2.5"
    kind: str                 # tello | wait
    status: str = "pending"   # pending | running | ok | error | skipped
    resp: str = ""
    ms: Optional[int] = None


def parse(script: str) -> tuple[list[Step], list[str]]:
    """回傳 (steps, errors)。有任何錯誤就不該執行。"""
    steps: list[Step] = []
    errors: list[str] = []
    for i, raw in enumerate((script or "").splitlines(), start=1):
        text = raw.split("#", 1)[0].strip()
        if not text:
            continue
        cmd = normalize_cmd(text)
        parts = cmd.split()
        if parts[0] in ("wait", "hover", "sleep"):
            if len(parts) != 2:
                errors.append(f"第 {i} 行：wait 後面要接秒數，例如 wait 2")
                continue
            try:
                s = float(parts[1])
            except ValueError:
                errors.append(f"第 {i} 行：wait 的秒數「{parts[1]}」不是數字")
                continue
            if not 0.1 <= s <= WAIT_MAX:
                errors.append(f"第 {i} 行：wait 的秒數要在 0.1–{WAIT_MAX:g} 之間")
                continue
            steps.append(Step(line=i, cmd=f"wait {s:g}", kind="wait"))
            continue
        if cmd == "emergency":
            errors.append(f"第 {i} 行：腳本裡不能放 emergency（緊急停槳只能由人按）")
            continue
        mi = move_info(cmd)
        if mi is not None:
            if mi["error"]:
                errors.append(f"第 {i} 行：{mi['error']}")
                continue
            steps.append(Step(line=i, cmd=cmd, kind="tello"))
            continue
        if cmd in STEP_CMDS:
            steps.append(Step(line=i, cmd=cmd, kind="tello"))
            continue
        if cmd in ASK_CMDS or ask_timeout(cmd) is not None:
            errors.append(f"第 {i} 行：「{cmd}」不是飛行動作，任務腳本不支援")
            continue
        errors.append(f"第 {i} 行：不認得「{text}」。可用：takeoff、land、up/down/left/right/forward/back 公分、"
                      "cw/ccw 度、go x y z speed、curve x1 y1 z1 x2 y2 z2 speed、flip l/r/f/b、speed、stop、wait 秒")
    if not steps and not errors:
        errors.append("腳本是空的")
    if len(steps) > MAX_STEPS:
        errors.append(f"最多 {MAX_STEPS} 步（目前 {len(steps)} 步）")
    return steps, errors


class MissionRunner:
    """逐步送出腳本的指令。link 需要：connected()、flying()、command(cmd)、cancel_move()、state。"""

    def __init__(self, link: Any, on_change: Optional[Callable[[dict], None]] = None,
                 on_event: Optional[Callable[[str, str, str], None]] = None,
                 clock: Callable[[], float] = time.monotonic):
        self.link = link
        self.on_change = on_change or (lambda s: None)
        self.on_event = on_event or (lambda *a: None)
        self.clock = clock
        self.state = "idle"          # idle | running | done | aborted | error
        self.steps: list[Step] = []
        self.idx = -1
        self.reason = ""
        self.started_at: Optional[float] = None
        self.ended_at: Optional[float] = None
        self._task: Optional[asyncio.Task] = None
        self._abort: Optional[str] = None
        self.runs = 0

    @property
    def running(self) -> bool:
        return self.state == "running"

    # ------------------------------------------------------------ 控制
    def start(self, script: str) -> tuple[bool, list[str]]:
        if self.running:
            return False, ["任務正在執行中，先中止再開始新的"]
        steps, errors = parse(script)
        if errors:
            return False, errors
        if not self.link.connected():
            return False, ["Tello 尚未連線"]
        if not self.link.flying() and steps[0].cmd != "takeoff":
            return False, ["無人機在地面上：第一步必須是 takeoff（或先手動起飛）"]
        if self.link.flying() and steps[0].cmd == "takeoff":
            return False, ["已經在空中：把第一行的 takeoff 拿掉"]
        bat = self.link.state.get("bat")
        if isinstance(bat, int) and bat < 20:
            return False, [f"電量 {bat}% 太低，不執行任務"]
        self.steps = steps
        self.idx = -1
        self.reason = ""
        self.state = "running"
        self._abort = None
        self.started_at = self.clock()
        self.ended_at = None
        self.runs += 1
        self.on_event("ok", "mission_start", f"任務開始：{len(steps)} 步")
        self._task = asyncio.ensure_future(self._run())
        self._changed()
        return True, []

    def abort(self, reason: str = "已中止") -> bool:
        if not self.running:
            return False
        self._abort = reason
        try:
            self.link.cancel_move()      # 進行中的移動指令：送 stop 並讓 ask 立刻回 interrupted
        except Exception:
            pass
        return True

    # ------------------------------------------------------------ 執行
    async def _run(self) -> None:
        try:
            for i, step in enumerate(self.steps):
                if self._abort:
                    break
                self.idx = i
                step.status = "running"
                self._changed()
                t0 = self.clock()
                ok = await self._do(step)
                step.ms = int((self.clock() - t0) * 1000)
                if self._abort:
                    step.status = "skipped" if step.resp in ("", "interrupted") else step.status
                    if step.status == "running":
                        step.status = "skipped"
                    break
                if not ok:
                    step.status = "error"
                    self._finish("error", f"第 {step.line} 行「{step.cmd}」失敗：{step.resp}")
                    return
                step.status = "ok"
                self._changed()
                if not self.link.connected():
                    self._abort = "與 Tello 的連線中斷"
                    break
            if self._abort:
                for s in self.steps:
                    if s.status in ("pending", "running"):
                        s.status = "skipped"
                self._finish("aborted", self._abort)
            else:
                self._finish("done", f"任務完成：{len(self.steps)} 步")
        except asyncio.CancelledError:
            self._finish("aborted", "程式結束")
            raise
        except Exception as e:  # pragma: no cover - 防禦
            self._finish("error", f"內部錯誤：{e}")

    async def _do(self, step: Step) -> bool:
        if step.kind == "wait":
            secs = float(step.cmd.split()[1])
            end = self.clock() + secs
            while self.clock() < end:
                if self._abort:
                    return False
                await asyncio.sleep(min(0.1, end - self.clock()))
            step.resp = "ok"
            return True
        if is_move(step.cmd) and not self.link.flying():
            step.resp = "不在空中"
            return False
        over = self._exceeds_ceiling(step.cmd)
        if over:
            step.resp = over
            return False
        resp = await self.link.command(step.cmd)
        step.resp = resp
        kind = classify(resp)
        if resp == "interrupted":
            if not self._abort:
                self._abort = "被降落／緊急停槳取代"
            return False
        if kind not in ("ok", "sent"):
            return False
        if step.cmd == "land":
            # land 不等回應：等遙測顯示落地（最多 10 秒）
            for _ in range(100):
                if not self.link.flying() or self._abort:
                    break
                await asyncio.sleep(0.1)
        return True

    def _exceeds_ceiling(self, cmd: str) -> Optional[str]:
        """up N／go … z 會超過高度上限 → 回錯誤訊息（不送出）。"""
        limits = getattr(self.link, "limits", None) or {}
        c = limits.get("ceiling") or 0
        if not c:
            return None
        parts = cmd.split()
        dz = 0
        if parts[0] == "up":
            dz = int(parts[1])
        elif parts[0] == "go":
            dz = int(parts[3])
        elif parts[0] == "curve":
            dz = max(int(parts[3]), int(parts[6]))
        if dz <= 0:
            return None
        h = self.link.height() if hasattr(self.link, "height") else 0
        if h + dz > c:
            return f"會超過高度上限 {c} cm（目前 {h} cm，再升 {dz} cm）"
        return None

    def _finish(self, state: str, reason: str) -> None:
        self.state = state
        self.reason = reason
        self.ended_at = self.clock()
        level = "ok" if state == "done" else "warn" if state == "aborted" else "danger"
        self.on_event(level, f"mission_{state}", reason)
        self._changed()

    # ------------------------------------------------------------ 狀態
    def status(self) -> dict:
        now = self.clock()
        return {
            "state": self.state, "idx": self.idx, "reason": self.reason, "runs": self.runs,
            "total": len(self.steps),
            "elapsed_s": round((self.ended_at or now) - self.started_at, 1) if self.started_at is not None else None,
            "steps": [asdict(s) for s in self.steps],
        }

    def _changed(self) -> None:
        try:
            self.on_change(self.status())
        except Exception:  # pragma: no cover
            pass


EXAMPLE = """# 範例：起飛、升高、繞一圈、降落（每行一個指令，# 後面是註解）
takeoff
up 50
forward 60
cw 90
forward 60
cw 90
forward 60
cw 90
forward 60
cw 90
wait 2
land
"""
