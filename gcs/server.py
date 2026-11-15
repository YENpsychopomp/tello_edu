"""FastAPI：/ws/control（rc＋遙測＋指令）、/ws/video（H.264）、/video.mjpg、/api/diag、靜態檔。"""
from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import mimetypes
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config
from .config import Settings
from .diag import Diag
from .flightlog import Flight, filename
from .link import TelloLink
from .mission import EXAMPLE as MISSION_EXAMPLE, MissionRunner
from .preflight import as_dicts, run_checks
from .protocol import FLIP_MIN_BATTERY, IMMEDIATE_CMDS, clamp_rc, classify, normalize_cmd, takeoff_error_hint
from .video import VideoHub

log = logging.getLogger("gcs.server")
# Windows 的 mimetypes 讀登錄檔，常常不認得 .wasm／.mjs；WebAssembly 串流編譯一定要 application/wasm
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/octet-stream", ".task")
WEB = Path(__file__).resolve().parent.parent / "web"
_ids = itertools.count(1)


@dataclass(eq=False)
class Client:
    ws: WebSocket
    monitor: bool                 # 診斷頁：只看、不算機長候選
    id: int = field(default_factory=lambda: next(_ids))
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, msg: dict) -> bool:
        try:
            async with self.lock:
                await asyncio.wait_for(self.ws.send_text(json.dumps(msg, ensure_ascii=False)), 2.0)
            return True
        except Exception:
            return False


class ControlHub:
    """單一機長：第一個（也是唯一一個）控制頁自動成為機長；其他頁要按「接管控制」。"""

    def __init__(self, link: TelloLink, video: VideoHub, settings: Settings, diag: Diag):
        self.link, self.video, self.s, self.diag = link, video, settings, diag
        self.clients: set[Client] = set()
        self.pilot: Optional[Client] = None
        self.events: list[dict] = []
        self.link.flightlog.on_flight_end = self._flight_end
        self.mission = MissionRunner(link, on_change=self._mission_changed, on_event=self.event)

    def role(self, c: Client) -> str:
        if c.monitor:
            return "monitor"
        return "pilot" if c is self.pilot else "observer"

    def candidates(self) -> list[Client]:
        return [c for c in self.clients if not c.monitor]

    async def join(self, c: Client) -> None:
        if not c.monitor and self.pilot is None and not self.candidates():
            self.pilot = c
            self.link.touch()
        self.clients.add(c)
        self.diag.ws_control = len(self.clients)
        await c.send({"t": "hello", "role": self.role(c), "id": c.id, "sim": self.s.sim,
                      "version": __version__, "events": self.events[-20:],
                      "mission": self.mission.status(), "mission_example": MISSION_EXAMPLE,
                      "config": {"hover_after": config.HOVER_AFTER, "land_after": config.LAND_AFTER,
                                 "flip_min_battery": FLIP_MIN_BATTERY,
                                 "land_max_tries": config.LAND_MAX_TRIES,
                                 "ceiling_max": config.CEILING_MAX, "low_bat_max": config.LOW_BAT_LAND_MAX}})

    async def leave(self, c: Client) -> None:
        self.clients.discard(c)
        self.diag.ws_control = len(self.clients)
        if c is self.pilot:
            self.pilot = None
            self.mission.abort("機長的控制頁已斷線")
            self.link.control_lost()          # 立刻懸停
            self.event("danger", "pilot_lost", "機長的控制頁已斷線 → 懸停中；其他分頁需按「接管控制」才能操作")

    async def takeover(self, c: Client) -> None:
        if c.monitor:
            return
        old = self.pilot
        self.pilot = c
        self.link.touch()
        if old is not c:
            self.mission.abort("控制權已被接管")
        if old is not None and old is not c:
            await old.send({"t": "role", "role": "observer", "reason": "其他分頁接管了控制"})
        await c.send({"t": "role", "role": "pilot"})
        self.event("warn", "takeover", f"控制權已由分頁 #{c.id} 接管")

    def _mission_changed(self, st: dict) -> None:
        msg = {"t": "mission", **st}
        for c in list(self.clients):
            asyncio.ensure_future(c.send(msg))

    def _flight_end(self, f: Flight) -> None:
        self.event("ok", "flight_done", f.summary_text(), flight=f.to_dict())

    def event(self, level: str, code: str, msg: str, **extra: Any) -> None:
        ev = {"t": "event", "level": level, "code": code, "msg": msg, "ts": time.time(), **extra}
        if code != "flight_done":
            self.link.flightlog.event(level, code, msg)
        self.events.append(ev)
        del self.events[:-100]
        for c in list(self.clients):
            asyncio.ensure_future(c.send(ev))

    async def handle(self, c: Client, msg: dict) -> None:
        t = msg.get("t")
        is_pilot = c is self.pilot
        if t == "rc":
            if is_pilot:
                self.link.set_rc(msg.get("v"))
                if self.mission.running and any(self.link.rc):
                    self.mission.abort("搖桿介入")
        elif t == "cmd":
            cmd = normalize_cmd(msg.get("cmd"))
            if is_pilot:
                self.link.touch()
            if not is_pilot and cmd != "land":
                await c.send({"t": "res", "id": msg.get("id"), "cmd": cmd, "resp": "denied 你不是機長",
                              "kind": "denied"})
                return
            asyncio.ensure_future(self._run_cmd(c, msg.get("id"), cmd))   # 不阻塞 rc 的接收
        elif t == "mission":
            await self._mission_op(c, msg)
        elif t == "limits":
            if is_pilot:
                before = dict(self.link.limits)
                after = self.link.set_limits(msg)
                if after != before:
                    self.event("info", "limits", "飛行限制："
                               + (f"高度上限 {after['ceiling']} cm" if after["ceiling"] else "高度上限關閉")
                               + "、" + (f"電量 ≤ {after['low_bat']}% 自動降落" if after["low_bat"] else "低電量自動降落關閉"))
        elif t == "takeover":
            await self.takeover(c)
        elif t == "ping":
            await c.send({"t": "pong", "ts": msg.get("ts")})

    async def _mission_op(self, c: Client, msg: dict) -> None:
        op = msg.get("op")
        mid = msg.get("id")
        if op == "check":
            from .mission import parse
            steps, errors = parse(str(msg.get("script") or ""))
            await c.send({"t": "mission_check", "id": mid, "ok": not errors, "errors": errors,
                          "steps": [{"line": s.line, "cmd": s.cmd, "kind": s.kind} for s in steps]})
            return
        if c is not self.pilot:
            await c.send({"t": "mission_res", "id": mid, "op": op, "ok": False, "errors": ["你不是機長"]})
            return
        self.link.touch()
        if op == "start":
            ok, errors = self.mission.start(str(msg.get("script") or ""))
            await c.send({"t": "mission_res", "id": mid, "op": op, "ok": ok, "errors": errors})
        elif op == "abort":
            ok = self.mission.abort(str(msg.get("reason") or "已中止"))
            await c.send({"t": "mission_res", "id": mid, "op": op, "ok": ok, "errors": [] if ok else ["沒有正在執行的任務"]})

    async def _run_cmd(self, c: Client, mid: Any, cmd: str) -> None:
        if cmd == "streamon":
            self.video.reset_stream()
        resp = await self.link.command(cmd)
        kind = classify(resp)
        out: dict[str, Any] = {"t": "res", "id": mid, "cmd": cmd, "resp": resp, "kind": kind}
        if cmd == "takeoff" and kind == "error" and "尚未連上" not in resp:
            st = self.link.state
            out["hint"] = takeoff_error_hint(resp, st.get("bat"), st.get("temph"))
        if cmd == "streamoff" and kind == "ok":
            self.video.reset_stream()
        await c.send(out)
        if cmd in IMMEDIATE_CMDS or cmd == "takeoff":
            label = {"takeoff": "起飛", "land": "降落", "emergency": "緊急停槳"}[cmd]
            self.event("danger" if cmd == "emergency" else "ok" if kind in ("ok", "sent") else "warn",
                       cmd, f"{label}：{resp}（分頁 #{c.id}）")

    async def telemetry_loop(self) -> None:
        period = 1.0 / config.TELEMETRY_HZ
        while True:
            await asyncio.sleep(period)
            if not self.clients:
                continue
            tel = self.link.telemetry()
            snap = self.diag.snapshot()
            base = {"t": "tel", **tel, "sim": self.s.sim, "has_pilot": self.pilot is not None,
                    "clients": len(self.candidates()),
                    "video": {"fps": snap["video"]["fps"], "kbps": snap["video"]["kbps"],
                              "pps": snap["video"]["pps"], "codec": snap["video"]["codec"]},
                    "state_pps": snap["state"]["pps"], "rtt_ms": snap["cmd"]["rtt_ms"],
                    "mission": {"state": self.mission.state, "idx": self.mission.idx, "total": len(self.mission.steps)}}
            for c in list(self.clients):
                asyncio.ensure_future(c.send({**base, "role": self.role(c)}))


def origin_ok(ws: WebSocket, s: Settings) -> bool:
    return ws.headers.get("origin") in s.allowed_origins


def create_app(settings: Optional[Settings] = None, checks: Optional[list] = None) -> FastAPI:
    s = settings or Settings()
    diag = Diag()
    state: dict[str, Any] = {}

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        hub_ref: dict[str, ControlHub] = {}
        link = TelloLink(s, diag, on_event=lambda lv, code, msg: hub_ref["hub"].event(lv, code, msg))
        video = VideoHub(s, diag)
        hub = ControlHub(link, video, s, diag)
        hub_ref["hub"] = hub
        startup_checks = checks if checks is not None else run_checks(s, before_bind=False)
        await link.start()
        await video.start()
        state.update(link=link, video=video, hub=hub, checks=startup_checks)
        tel = asyncio.ensure_future(hub.telemetry_loop())
        app.state.link = link
        log.info("gcs 已啟動：Tello %s:%s，狀態 UDP %s，影像 UDP %s", s.tello_host, s.cmd_port,
                 link.state_port_bound, video.port_bound)
        try:
            yield
        finally:
            tel.cancel()
            await link.shutdown()       # 先送 land（若在空中），再關 UDP socket
            await video.stop()
            log.info("gcs 已結束")

    app = FastAPI(title="Tello GCS", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = s
    app.state.diag = diag
    app.state.ctx = state

    no_cache = {"Cache-Control": "no-cache"}

    @app.middleware("http")
    async def revalidate(request, call_next):
        # 靜態檔每次都用 ETag 重新驗證：更新程式後瀏覽器不會拿到舊的 JS/CSS
        resp = await call_next(request)
        if request.url.path.startswith("/static/"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.get("/")
    async def index() -> Response:
        return FileResponse(WEB / "index.html", headers=no_cache)

    @app.get("/diag")
    async def diag_page() -> Response:
        return FileResponse(WEB / "diag.html", headers=no_cache)

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "version": __version__}

    @app.get("/api/diag")
    async def api_diag() -> JSONResponse:
        link: TelloLink = state["link"]
        video: VideoHub = state["video"]
        hub: ControlHub = state["hub"]
        return JSONResponse({
            **diag.snapshot(),
            "checks": as_dicts(state["checks"]),
            "link": {"sdk": link.sdk_ok, "connected": link.connected(),
                     "state_age": round(min(link.state_age(), 9999.0), 2),
                     "target": f"{s.tello_host}:{s.cmd_port}",
                     "target_ip": link.target[0] if link.target else None,
                     "state_port": link.state_port_bound, "video_port": video.port_bound,
                     "flying": link.flying(), "silenced": link.safety.silenced,
                     "rc_count": link.rc_count},
            "env": {"in_docker": s.in_docker, "sim": s.sim, "version": __version__,
                    "ffmpeg": video.mjpeg.available},
            "pilot": hub.pilot.id if hub.pilot else None,
        }, headers={"Cache-Control": "no-store"})

    # ---- 飛行紀錄（黑盒子）
    @app.get("/api/flights")
    async def api_flights() -> JSONResponse:
        link: TelloLink = state["link"]
        return JSONResponse(link.flightlog.status(), headers={"Cache-Control": "no-store"})

    @app.get("/api/flightlog.csv")
    async def api_flightlog_csv(flight: Optional[int] = None) -> Response:
        link: TelloLink = state["link"]
        f = link.flightlog.flight(flight) if flight is not None else None
        name = filename("tello-flightlog", flight, "csv", f.wall0 if f else None)
        return PlainTextResponse(link.flightlog.to_csv(flight), media_type="text/csv; charset=utf-8",
                                 headers={"Content-Disposition": f'attachment; filename="{name}"',
                                          "Cache-Control": "no-store"})

    @app.get("/api/flightlog.json")
    async def api_flightlog_json(flight: Optional[int] = None) -> JSONResponse:
        link: TelloLink = state["link"]
        f = link.flightlog.flight(flight) if flight is not None else None
        name = filename("tello-flightlog", flight, "json", f.wall0 if f else None)
        return JSONResponse(link.flightlog.to_json(flight),
                            headers={"Content-Disposition": f'attachment; filename="{name}"',
                                     "Cache-Control": "no-store"})

    @app.get("/video.mjpg")
    async def mjpeg() -> Response:
        video: VideoHub = state["video"]
        if not video.mjpeg.available:
            return JSONResponse({"error": "ffmpeg not installed"}, status_code=404)
        return StreamingResponse(video.mjpeg.stream(),
                                 media_type="multipart/x-mixed-replace; boundary=frame",
                                 headers={"Cache-Control": "no-cache"})

    @app.websocket("/ws/control")
    async def ws_control(ws: WebSocket) -> None:
        if not origin_ok(ws, s):
            log.warning("拒絕 WebSocket（Origin=%s）", ws.headers.get("origin"))
            await ws.close(code=1008)
            return
        await ws.accept()
        hub: ControlHub = state["hub"]
        c = Client(ws, monitor=ws.query_params.get("monitor") == "1")
        await hub.join(c)
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    await hub.handle(c, msg)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            await hub.leave(c)

    @app.websocket("/ws/video")
    async def ws_video(ws: WebSocket) -> None:
        if not origin_ok(ws, s):
            await ws.close(code=1008)
            return
        await ws.accept()
        video: VideoHub = state["video"]
        sub = video.subscribe()

        async def sender() -> None:
            while True:
                au = await sub.q.get()
                if au.codec and au.codec != sub.codec_sent:
                    await ws.send_text(json.dumps({"t": "config", "codec": au.codec}))
                    sub.codec_sent = au.codec
                await ws.send_bytes(bytes([1 if au.key else 0]) + au.data)

        async def receiver() -> None:
            while True:
                m = await ws.receive()
                if m.get("type") == "websocket.disconnect":
                    return

        tasks = [asyncio.ensure_future(sender()), asyncio.ensure_future(receiver())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in tasks:
                t.cancel()
            video.unsubscribe(sub)

    app.mount("/static", StaticFiles(directory=WEB), name="static")
    return app
