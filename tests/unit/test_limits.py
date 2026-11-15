"""飛行限制：高度上限擋掉「上升」的 rc、低電量自動降落（含重送）、設定值清洗、WS 只有機長能改、任務腳本 up 超過上限。"""
import asyncio

from fastapi.testclient import TestClient

from gcs import config
from gcs.config import Settings
from gcs.link import TelloLink
from gcs.mission import MissionRunner
from gcs.server import create_app
from sim.mock_tello import MockTello, Options


async def setup(**mock_kw):
    opt = Options(host="127.0.0.1", cmd_port=0, state_port=0, video=False, quiet=True,
                  takeoff_delay=mock_kw.pop("takeoff_delay", 0.2), **mock_kw)
    mock = MockTello(opt)
    await mock.start()
    s = Settings(tello_host="127.0.0.1", cmd_port=mock.cmd_port_bound, state_port=0, video_port=0, sim=True)
    events = []
    link = TelloLink(s, wifi_poll=999, wifi_first=999, on_event=lambda lv, code, msg: events.append((code, msg)))
    await link.start()
    mock.o.state_port = link.state_port_bound
    for _ in range(150):
        if link.connected():
            break
        await asyncio.sleep(0.02)
    assert link.connected()
    return mock, link, events


async def feed(link, vals, secs):
    for _ in range(int(secs / 0.03)):
        link.set_rc(vals)
        await asyncio.sleep(0.03)


async def teardown(mock, link):
    await link.shutdown()
    await mock.stop()


async def settled(mock):
    """模擬器的 takeoff 在爬到 80 cm 之前就回 ok（真機會等）；等它爬完再開始測。"""
    for _ in range(200):
        if mock.w.flying and mock.w.target_h is None:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("模擬器沒有爬完起飛高度")


def test_set_limits_sanitizes():
    link = TelloLink(Settings(tello_host="127.0.0.1", cmd_port=9, state_port=0, video_port=0, sim=True))
    assert link.limits == {"ceiling": config.CEILING_DEFAULT, "low_bat": config.LOW_BAT_LAND_DEFAULT}
    assert link.set_limits({"ceiling": 120, "low_bat": 15}) == {"ceiling": 120, "low_bat": 15}
    assert link.set_limits({"ceiling": 0, "low_bat": 0}) == {"ceiling": 0, "low_bat": 0}
    assert link.set_limits({"ceiling": 10, "low_bat": 99}) == {"ceiling": config.CEILING_MIN, "low_bat": config.LOW_BAT_LAND_MAX}
    assert link.set_limits({"ceiling": 5000}) == {"ceiling": config.CEILING_MAX, "low_bat": config.LOW_BAT_LAND_MAX}
    assert link.set_limits({"ceiling": "abc", "low_bat": True}) == {"ceiling": config.CEILING_MAX, "low_bat": config.LOW_BAT_LAND_MAX}
    assert link.set_limits("junk") == {"ceiling": config.CEILING_MAX, "low_bat": config.LOW_BAT_LAND_MAX}
    assert link.set_limits({"ceiling": 199.6}) == {"ceiling": 200, "low_bat": config.LOW_BAT_LAND_MAX}


def test_ceiling_blocks_climb_but_allows_descend():
    async def go():
        mock, link, events = await setup()
        link.set_limits({"ceiling": 100, "low_bat": 0})
        link.set_rc((0, 0, 0, 0))
        assert await link.command("takeoff") == "ok"
        await settled(mock)                                 # 80 cm
        await feed(link, (0, 0, 60, 0), 1.0)                # 全力上升（60 cm/s）
        assert 100 <= mock.w.h <= 112, mock.w.h             # 到上限附近就停住（最多多一拍）
        assert mock.w.rc[2] == 0 and link.rc[2] == 60       # 送給 Tello 的上升被改成 0，搖桿本身還是 60
        tel = link.telemetry()
        assert tel["ceiling_hit"] is True and tel["limits"]["ceiling"] == 100 and tel["rc_sent"][2] == 0
        await feed(link, (0, 30, -40, 0), 0.5)              # 下降與前進不受影響
        assert mock.w.rc == (0, 30, -40, 0) and mock.w.h < 100
        await feed(link, (0, 0, 0, 0), 1.1)
        assert link.telemetry()["ceiling_hit"] is False
        link.immediate("land")
        await teardown(mock, link)
    asyncio.run(go())


def test_low_battery_lands_and_resends():
    async def go():
        mock, link, events = await setup()
        link.set_limits({"ceiling": 0, "low_bat": 12})
        link.set_rc((0, 0, 0, 0))
        assert await link.command("takeoff") == "ok"
        mock.o.ignore_land = True                            # 模擬 land 沒被聽到
        mock.w.bat = 12
        feeder = asyncio.ensure_future(feed(link, (0, 0, 0, 0), 2.0))
        for _ in range(100):
            if any(c == "low_bat_land" for c, _ in events):
                break
            await asyncio.sleep(0.02)
        assert [c for c, _ in events].count("low_bat_land") == 1
        assert "12%" in [m for c, m in events if c == "low_bat_land"][0]
        assert mock.commands().count("land") == 1
        # 還在空中 → 5 秒內不重送；把重送間隔縮短來驗證重送
        await asyncio.sleep(0.5)
        assert mock.commands().count("land") == 1
        link._lowbat_at -= config.LOW_BAT_RESEND
        await asyncio.sleep(0.3)
        assert mock.commands().count("land") == 2
        feeder.cancel()
        mock.o.ignore_land = False
        link.immediate("land")
        await teardown(mock, link)
    asyncio.run(go())


def test_low_battery_off_when_zero_and_not_on_ground():
    async def go():
        mock, link, events = await setup()
        link.set_limits({"low_bat": 0})
        mock.w.bat = 5
        await asyncio.sleep(0.3)
        assert not [c for c, _ in events if c == "low_bat_land"]
        link.set_limits({"low_bat": 10})                    # 在地面上即使電量低也不送 land
        await asyncio.sleep(0.3)
        assert not [c for c, _ in events if c == "low_bat_land"] and "land" not in mock.commands()
        await teardown(mock, link)
    asyncio.run(go())


def test_mission_up_over_ceiling_fails_before_sending():
    async def go():
        mock, link, events = await setup()
        link.set_limits({"ceiling": 120})
        link.set_rc((0, 0, 0, 0))
        feeder = asyncio.ensure_future(feed(link, (0, 0, 0, 0), 10.0))
        assert await link.command("takeoff") == "ok"
        await settled(mock)                                 # 80 cm
        runner = MissionRunner(link)
        ok, _ = runner.start("up 30\nup 30\ncw 90")         # 80→110 可以；110→140 超過
        assert ok
        for _ in range(300):
            if not runner.running:
                break
            await asyncio.sleep(0.02)
        st = runner.status()
        assert st["state"] == "error" and "高度上限 120" in st["reason"], st
        assert [s["status"] for s in st["steps"]] == ["ok", "error", "pending"]
        assert mock.commands().count("up 30") == 1
        feeder.cancel()
        link.immediate("land")
        await teardown(mock, link)
    asyncio.run(go())


def test_ws_limits_only_from_pilot():
    s = Settings(tello_host="127.0.0.1", cmd_port=9, state_port=0, video_port=0, http_port=8080,
                 public_port=8080, sim=True, extra_origins="")
    with TestClient(create_app(s)) as client:
        link = client.app.state.ctx["link"]
        h = {"origin": "http://localhost:8080"}
        with client.websocket_connect("/ws/control", headers=h) as a, client.websocket_connect("/ws/control", headers=h) as b:
            hello = a.receive_json()
            assert hello["role"] == "pilot" and hello["config"]["ceiling_max"] == config.CEILING_MAX
            assert b.receive_json()["role"] == "observer"
            b.send_json({"t": "limits", "ceiling": 50, "low_bat": 30})
            a.send_json({"t": "limits", "ceiling": 250, "low_bat": 8})
            ev, tel = None, None
            for _ in range(60):
                m = a.receive_json()
                if m.get("t") == "event" and m.get("code") == "limits":
                    ev = m
                if m.get("t") == "tel" and m["limits"] == {"ceiling": 250, "low_bat": 8}:
                    tel = m
                if ev and tel:
                    break
            assert tel, f"遙測沒有帶新的限制：{link.limits}"
            assert link.limits == {"ceiling": 250, "low_bat": 8}
            assert ev and "250 cm" in ev["msg"] and "8%" in ev["msg"]
