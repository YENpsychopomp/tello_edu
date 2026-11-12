"""斷訊懸停與自動降落的時序（純邏輯，時間完全由測試控制）。"""
from gcs import config
from gcs.protocol import RC_ZERO
from gcs.safety import Safety

RC = (10, 20, 30, 40)
DT = 0.05   # 20 Hz


def run(s: Safety, start: float, end: float, rc_time: float, flying, rc=RC):
    """從 start 到 end 每 50 ms tick 一次；flying 可以是 bool 或 f(t)。"""
    out = []
    t = start
    while t <= end + 1e-9:
        f = flying(t) if callable(flying) else flying
        out.append((round(t, 3), s.tick(t, rc_time, rc, f)))
        t += DT
    return out


def test_defaults_match_spec():
    assert config.HOVER_AFTER == 0.5
    assert config.LAND_AFTER == 8.0
    assert config.LAND_RETRY_AFTER == 5.0
    assert config.LAND_MAX_TRIES == 3


def test_passes_rc_through_while_alive():
    s = Safety()
    d = s.tick(10.0, 9.9, RC, True)
    assert d.rc == RC and not d.land


def test_hover_after_half_second():
    s = Safety()
    assert s.tick(100.50, 100.0, RC, True).rc == RC          # 剛好 0.5 秒：還算活著
    d = s.tick(100.51, 100.0, RC, True)
    assert d.rc == RC_ZERO and not d.land and d.reason == "hover"


def test_auto_land_once_at_8s_then_retry_every_5s_max_3_then_silence():
    s = Safety()
    rc_time = 0.0
    log = run(s, 0.0, 30.0, rc_time, flying=True)
    lands = [t for t, d in log if d.land]
    # 第 1 次在剛超過 8 秒；之後每 5 秒（遙測仍在空中）重送，總共 3 次
    assert len(lands) == 3
    assert 8.0 < lands[0] <= 8.05 + 1e-9
    assert 5.0 - 1e-6 < lands[1] - lands[0] <= 5.05 + 1e-6
    assert 5.0 - 1e-6 < lands[2] - lands[1] <= 5.05 + 1e-6
    # 第 3 次之後 5 秒仍在空中 → 停止送任何 rc
    silenced = [t for t, d in log if d.rc is None]
    assert silenced and lands[2] + 5.0 - 1e-6 < silenced[0] <= lands[2] + 5.05 + 1e-6
    assert all(d.rc is None for t, d in log if t >= silenced[0])
    assert s.silenced
    # 8 秒之前：懸停（rc 0）而不是降落
    assert all(d.rc == RC_ZERO and not d.land for t, d in log if 0.5 < t <= 8.0)


def test_land_sent_only_once_when_drone_comes_down():
    s = Safety()
    # 第一次 land 後 2 秒落地
    log = run(s, 0.0, 30.0, 0.0, flying=lambda t: t < 10.0)
    assert sum(1 for _, d in log if d.land) == 1
    assert not s.silenced
    assert all(d.rc == RC_ZERO for t, d in log if t > 10.0)   # 在地面上繼續送 rc 0（維持 SDK）


def test_no_land_when_on_ground():
    s = Safety()
    log = run(s, 0.0, 30.0, 0.0, flying=False)
    assert not any(d.land for _, d in log)
    assert all(d.rc == RC_ZERO for t, d in log if t > 0.5)


def test_control_returns_resets_episode():
    s = Safety()
    run(s, 0.0, 9.0, 0.0, flying=True)            # 已送出第一次 land
    assert s.land_tries == 1
    d = s.tick(9.1, 9.05, RC, True)               # 控制端恢復
    assert d.rc == RC and s.land_tries == 0 and not s.silenced
    # 再斷一次：重新從「送 1 次」開始
    log = run(s, 9.1, 18.0, 9.05, flying=True)
    assert sum(1 for _, d in log if d.land) == 1


def test_control_returns_after_silence_resumes_rc():
    s = Safety()
    run(s, 0.0, 30.0, 0.0, flying=True)
    assert s.silenced
    d = s.tick(31.0, 30.9, RC, True)
    assert d.rc == RC and not s.silenced


def test_status_phases():
    s = Safety()
    assert s.status(1.0, 0.9)["phase"] == "normal"
    st = s.status(3.0, 0.0)
    assert st["phase"] == "hover" and st["land_in"] == 5.0
    run(s, 0.0, 9.0, 0.0, flying=True)
    assert s.status(9.0, 0.0)["phase"] == "landing"
    run(s, 9.0, 30.0, 0.0, flying=True)
    assert s.status(30.0, 0.0)["phase"] == "silenced"
