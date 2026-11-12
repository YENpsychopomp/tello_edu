"""WebSocket 的 Origin 檢查與單一機長規則。"""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from gcs.config import Settings
from gcs.server import create_app

OK_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"]


@pytest.fixture()
def client():
    s = Settings(tello_host="127.0.0.1", cmd_port=9, state_port=0, video_port=0, http_port=8080,
                 public_port=8080, sim=True, extra_origins="")
    with TestClient(create_app(s)) as c:
        yield c


def connect(client, origin="http://localhost:8080", monitor=False):
    path = "/ws/control" + ("?monitor=1" if monitor else "")
    return client.websocket_connect(path, headers={"origin": origin} if origin else {})


def recv_until(ws, t, limit=50):
    for _ in range(limit):
        m = ws.receive_json()
        if m.get("t") == t:
            return m
    raise AssertionError(f"沒收到 {t}")


# ---------------------------------------------------------------- Origin
@pytest.mark.parametrize("origin", OK_ORIGINS)
def test_allowed_origins(client, origin):
    with connect(client, origin) as ws:
        assert ws.receive_json()["t"] == "hello"


@pytest.mark.parametrize("origin", [None, "http://evil.example", "http://localhost:9999",
                                    "http://192.168.10.2:8080", "https://localhost:8080", "null",
                                    "http://localhost:8080.evil.example"])
def test_rejected_origins(client, origin):
    with pytest.raises(WebSocketDisconnect):
        with connect(client, origin) as ws:
            ws.receive_json()


def test_video_ws_checks_origin_too(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/video", headers={"origin": "http://evil.example"}) as ws:
            ws.receive_bytes()


# ---------------------------------------------------------------- 單一機長
def test_first_client_is_pilot_second_is_observer(client):
    with connect(client) as a:
        assert a.receive_json()["role"] == "pilot"
        with connect(client) as b:
            assert b.receive_json()["role"] == "observer"
            # 觀看者不能起飛
            b.send_json({"t": "cmd", "cmd": "takeoff", "id": 7})
            r = recv_until(b, "res")
            assert r["kind"] == "denied" and r["id"] == 7
            # 觀看者的 rc 被忽略
            link = client.app.state.ctx["link"]
            a.send_json({"t": "rc", "v": [0, 10, 0, 0]})
            recv_until(a, "tel")
            b.send_json({"t": "rc", "v": [0, 99, 0, 0]})
            recv_until(b, "tel")
            assert link.rc == (0, 10, 0, 0)
            # 觀看者可以送 land（安全動作）
            b.send_json({"t": "cmd", "cmd": "land", "id": 8})
            assert recv_until(b, "res")["kind"] == "sent"


def test_observer_not_auto_promoted_when_pilot_leaves(client):
    with connect(client) as obs_holder:
        pass
    with connect(client) as a:
        assert a.receive_json()["role"] == "pilot"
        b = connect(client).__enter__()
        assert b.receive_json()["role"] == "observer"
    # a 已離開；b 仍是觀看者，必須按「接管控制」
    assert recv_until(b, "tel")["role"] == "observer"
    hub = client.app.state.ctx["hub"]
    assert hub.pilot is None
    # 新加入的分頁也不會自動升格（已經有其他控制頁在）
    with connect(client) as c:
        assert c.receive_json()["role"] == "observer"
        b.send_json({"t": "takeover"})
        assert recv_until(b, "role")["role"] == "pilot"
        assert hub.pilot is not None
    b.__exit__(None, None, None)


def test_takeover_demotes_old_pilot(client):
    with connect(client) as a, connect(client) as b:
        assert a.receive_json()["role"] == "pilot"
        assert b.receive_json()["role"] == "observer"
        b.send_json({"t": "takeover"})
        assert recv_until(b, "role")["role"] == "pilot"
        m = recv_until(a, "role")
        assert m["role"] == "observer"
        assert recv_until(a, "tel")["role"] == "observer"


def test_pilot_disconnect_triggers_hover(client):
    link = client.app.state.ctx["link"]
    with connect(client) as a:
        a.receive_json()
        a.send_json({"t": "rc", "v": [0, 50, 0, 0]})
        recv_until(a, "tel")
        assert link.rc == (0, 50, 0, 0)
    assert link.rc == (0, 0, 0, 0)
    assert link.safety.status(link.clock(), link.rc_time, link._control_lost)["phase"] == "hover"


def test_monitor_does_not_block_auto_pilot(client):
    with connect(client, monitor=True) as m:
        assert m.receive_json()["role"] == "monitor"
        with connect(client) as a:
            assert a.receive_json()["role"] == "pilot"


def test_unknown_command_denied(client):
    with connect(client) as a:
        a.receive_json()
        a.send_json({"t": "cmd", "cmd": "reboot", "id": 1})
        assert recv_until(a, "res")["kind"] == "denied"


def test_static_and_api(client):
    assert client.get("/").status_code == 200
    assert client.get("/diag").status_code == 200
    assert client.get("/static/js/main.js").status_code == 200
    assert client.get("/static/js/main.js").headers["cache-control"] == "no-cache"
    d = client.get("/api/diag").json()
    assert {"cmd", "state", "video", "ws", "checks", "link", "env"} <= set(d)
