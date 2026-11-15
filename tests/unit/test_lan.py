"""LAN 模式（手機／平板連到電腦上的地面站）：Origin 白名單含本機 IP、HTTP 綁 0.0.0.0、hello 帶 lan 旗標。"""
import os
from unittest import mock

from fastapi.testclient import TestClient

from gcs import config
from gcs.config import Settings, local_ips
from gcs.server import create_app


def test_local_ips_returns_ipv4_without_loopback():
    ips = local_ips()
    assert isinstance(ips, list)
    for ip in ips:
        assert ip.count(".") == 3 and not ip.startswith("127.")


def test_default_is_localhost_only():
    s = Settings(public_port=8080, extra_origins="")
    assert s.lan is False and s.http_host == "127.0.0.1"
    assert s.allowed_origins == {"http://localhost:8080", "http://127.0.0.1:8080"}
    assert s.lan_ips == []


def test_lan_mode_adds_local_ip_origins_and_binds_all_interfaces():
    with mock.patch.dict(os.environ, {"GCS_LAN": "1"}, clear=False):
        os.environ.pop("HTTP_HOST", None)
        s = Settings(public_port=8080, extra_origins="")
    assert s.lan is True and s.http_host == "0.0.0.0"
    with mock.patch.object(config, "local_ips", return_value=["192.168.10.2", "10.0.0.5"]):
        o = s.allowed_origins
    assert {"http://192.168.10.2:8080", "http://10.0.0.5:8080", "http://localhost:8080"} <= o
    assert "http://192.168.10.3:8080" not in o


def test_lan_origin_accepted_by_websocket_and_hello_flags_lan():
    s = Settings(tello_host="127.0.0.1", cmd_port=9, state_port=0, video_port=0, http_port=8080,
                 public_port=8080, sim=True, extra_origins="", lan=True)
    with mock.patch.object(config, "local_ips", return_value=["192.168.10.2"]):
        with TestClient(create_app(s)) as c:
            with c.websocket_connect("/ws/control", headers={"origin": "http://192.168.10.2:8080"}) as ws:
                hello = ws.receive_json()
                assert hello["t"] == "hello" and hello["lan"] is True
