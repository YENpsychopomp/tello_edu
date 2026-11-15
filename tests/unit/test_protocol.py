import math

import pytest

from gcs.protocol import (ASK_CMDS, IMMEDIATE_CMDS, BatteryEstimator, clamp_rc, classify, is_allowed,
                          normalize_cmd, parse_state, parse_wifi, rc_command, takeoff_error_hint)

REAL_STATE = (b"mid:-1;x:-100;y:-100;z:-100;mpry:0,0,0;pitch:-2;roll:3;yaw:-45;vgx:1;vgy:-2;vgz:0;"
              b"templ:62;temph:65;tof:92;h:80;bat:87;baro:101.23;time:12;agx:-3.00;agy:1.00;agz:-999.00;\r\n")


# ---------------------------------------------------------------- rc 夾限
@pytest.mark.parametrize("vals,expected", [
    ([0, 0, 0, 0], (0, 0, 0, 0)),
    ([150, -150, 100, -100], (100, -100, 100, -100)),
    ([1e9, -1e9, 0, 0], (100, -100, 0, 0)),
    ([10.4, 10.6, -10.4, -10.6], (10, 11, -10, -11)),
    (["50", "x", None, True], (50, 0, 0, 0)),
    ([float("nan"), float("inf"), float("-inf"), 5], (0, 100, -100, 5)),
    ([1, 2], (1, 2, 0, 0)),
    ([1, 2, 3, 4, 5, 6], (1, 2, 3, 4)),
    (None, (0, 0, 0, 0)),
    ("garbage", (0, 0, 0, 0)),
    ({"a": 1}, (0, 0, 0, 0)),
])
def test_clamp_rc(vals, expected):
    out = clamp_rc(vals)
    assert out == expected
    assert all(isinstance(v, int) and -100 <= v <= 100 for v in out)


def test_rc_command_format():
    assert rc_command((1, -2, 3, -4)) == "rc 1 -2 3 -4"


# ---------------------------------------------------------------- 白名單
def test_whitelist():
    for c in ("takeoff", "land", "emergency", "streamon", "streamoff", "flip f", "wifi?", "battery?",
              "downvision 0", "downvision 1", "go 100 0 0 50", "speed 100", "forward 20", "stop"):
        assert is_allowed(c)
    for c in ("reboot", "motoron", "go 10 0 0 50", "rc 0 0 0 0", "command", "", "land; emergency",
              "ap ssid pass", "wifi ssid pass", "speed 101", "downvision 2", "downvision", "forward 10"):
        assert not is_allowed(c)
    assert IMMEDIATE_CMDS == {"land", "emergency"}
    assert not (set(ASK_CMDS) & IMMEDIATE_CMDS)


def test_normalize_cmd():
    assert normalize_cmd("  FLIP   F ") == "flip f"
    assert normalize_cmd(None) == ""
    assert normalize_cmd(123) == "123"


# ---------------------------------------------------------------- 狀態解析
def test_parse_state_real_packet():
    st = parse_state(REAL_STATE)
    assert st["bat"] == 87 and st["h"] == 80 and st["tof"] == 92
    assert st["templ"] == 62 and st["temph"] == 65
    assert (st["pitch"], st["roll"], st["yaw"]) == (-2, 3, -45)
    assert (st["vgx"], st["vgy"], st["vgz"]) == (1, -2, 0)
    assert st["time"] == 12
    assert math.isclose(st["baro"], 101.23)
    assert st["mpry"] == "0,0,0"          # 未知欄位保留字串
    assert isinstance(st["bat"], int) and isinstance(st["baro"], float)


def test_parse_state_tolerates_garbage():
    st = parse_state(b"bat:abc;h:12;;novalue;:5;tof:;baro:x;yaw:-7.0;\xff\xfe")
    assert st == {"h": 12, "yaw": -7}
    assert parse_state(b"") == {}
    assert parse_state("h:5") == {"h": 5}


def test_parse_wifi():
    assert parse_wifi("90") == 90
    assert parse_wifi("snr:72\r\n") == 72
    assert parse_wifi("timeout") is None
    assert parse_wifi("error") is None
    assert parse_wifi("") is None


def test_classify_denied_with_reason():
    # link.command 回「denied 原因」時也要算拒絕（之前會被當成 ok）
    assert classify("denied 不在空中") == "denied"
    assert classify("denied 電量低於 50%") == "denied"
    assert classify("denied") == "denied"


def test_classify():
    assert classify("ok") == "ok"
    assert classify("unknown command: downvision") == "error"     # 舊韌體不認得的指令
    assert classify("error") == "error"
    assert classify("error Motor stop") == "error"
    assert classify("timeout") == "timeout"
    assert classify("interrupted") == "interrupted"
    assert classify("sent") == "sent"
    assert classify("denied") == "denied"
    assert classify("network error") == "error"
    assert classify("87") == "ok"


def test_takeoff_hint_prefers_activation_when_nothing_else_explains():
    h = takeoff_error_hint("error", bat=80, temph=60)
    assert "啟用" in h["primary"] and "最可能" in h["primary"]
    assert len(h["others"]) >= 3
    assert "電量" in takeoff_error_hint("error", bat=5, temph=60)["primary"]
    assert "溫度" in takeoff_error_hint("error", bat=80, temph=90)["primary"]


# ---------------------------------------------------------------- 電量估算
def test_battery_default_estimate():
    be = BatteryEstimator(full_minutes=13, reserve=10)
    assert be.remaining_s(100) == int(90 / (100 / 780))
    assert be.remaining_s(10) == 0
    assert be.remaining_s(None) is None
    assert not be.measured


def test_battery_measured_rate():
    be = BatteryEstimator(full_minutes=13, reserve=10)
    t = 0.0
    be.update(t, 80, flying=True)
    for bat in range(79, 70, -1):   # 每 5 秒掉 1%
        t += 5
        be.update(t, bat, flying=True)
    assert be.measured
    assert abs(be.rate - 0.2) < 1e-9
    assert be.remaining_s(70) == 300          # (70-10)/0.2
    be.update(t + 100, 70, flying=False)      # 落地不影響已學到的放電率
    assert abs(be.rate - 0.2) < 1e-9


def test_battery_ignores_sudden_jumps():
    be = BatteryEstimator()
    be.update(0, 87, flying=True)
    be.update(1, 14, flying=True)             # 電壓驟降造成的跳動
    assert be.rate is None and not be.measured
    be.update(11, 13, flying=True)
    assert abs(be.rate - 0.1) < 1e-9
