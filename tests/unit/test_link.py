"""TelloLink 的行為：用 loopback UDP 實際連模擬器（同一個 event loop），時序縮短以加快測試。"""
import asyncio
import time

from gcs.config import Settings
from gcs.link import TelloLink
from gcs.safety import Safety
from sim.mock_tello import MockTello, Options


async def setup(safety=None, state_stale=3.0, **mock_kw):
    opt = Options(host="127.0.0.1", cmd_port=0, state_port=0, video=False, quiet=True,
                  takeoff_delay=mock_kw.pop("takeoff_delay", 0.3), **mock_kw)
    mock = MockTello(opt)
    await mock.start()
    s = Settings(tello_host="127.0.0.1", cmd_port=mock.cmd_port_bound, state_port=0, video_port=0, sim=True)
    events = []
    link = TelloLink(s, safety=safety, state_stale=state_stale, wifi_poll=999, wifi_first=999,
                     on_event=lambda lv, code, msg: events.append(code))
    await link.start()
    mock.o.state_port = link.state_port_bound
    await wait_for(lambda: link.connected(), 3.0)
    await wait_for(lambda: link.info["sn"] is not None, 3.0)   # 連上後的 sdk?/sn? 查詢做完再開始測
    return mock, link, events


async def wait_for(cond, timeout, step=0.02):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if cond():
            return True
        await asyncio.sleep(step)
    raise AssertionError("條件沒有在時限內成立")


async def teardown(mock, link):
    await link.shutdown()
    await mock.stop()


async def pilot_feed(link, vals, stop: asyncio.Event, hz=30):
    while not stop.is_set():
        link.set_rc(vals)
        await asyncio.sleep(1 / hz)


def run(coro):
    asyncio.run(coro)


# ---------------------------------------------------------------- 基本
def test_connects_and_parses_state():
    async def go():
        mock, link, events = await setup()
        assert link.sdk_ok and link.connected()
        assert link.state["bat"] == 87
        assert "link_ok" in events
        assert mock.commands()[0] == "command"
        await teardown(mock, link)
    run(go())


def test_whitelist_blocks_unknown_commands():
    async def go():
        mock, link, _ = await setup()
        for bad in ("reboot", "motoron", "go 10 0 0 50", "wifi ssid pw", "command"):
            assert await link.command(bad) == "denied"
        await asyncio.sleep(0.1)
        assert [c for c in mock.commands() if c not in ("sdk?", "sn?")] == ["command"]
        await teardown(mock, link)
    run(go())


# ---------------------------------------------------------------- ask 期間暫停 rc
def test_rc_paused_during_ask_and_zeroed_first():
    async def go():
        mock, link, _ = await setup(takeoff_delay=0.6)
        stop = asyncio.Event()
        feeder = asyncio.ensure_future(pilot_feed(link, [0, 40, 0, 0], stop))
        await asyncio.sleep(0.3)
        t_before = time.monotonic()
        resp = await link.command("takeoff")
        t_after = time.monotonic()
        assert resp == "ok"
        t_cmd = next(t for t, c in mock.log if c == "takeoff")
        during = [(t, v) for t, v in mock.rc_log if t_cmd < t < t_after - 0.02]
        assert during == [], f"ask 期間不應該送 rc：{during}"
        # 送 takeoff 之前的最後一個 rc 必須是 0 0 0 0（修法 2：暫停前先歸零）
        before = [(t, v) for t, v in mock.rc_log if t_before <= t <= t_cmd]
        assert before and before[-1][1] == (0, 0, 0, 0)
        # ask 結束後 rc 恢復
        await asyncio.sleep(0.2)
        assert mock.rc_log[-1][1] == (0, 40, 0, 0)
        stop.set(); await feeder
        await teardown(mock, link)
    run(go())


# ---------------------------------------------------------------- land 打斷 ask
def test_land_interrupts_pending_takeoff_and_next_ask_is_clean():
    async def go():
        mock, link, _ = await setup(takeoff_delay=2.0)
        stop = asyncio.Event()
        feeder = asyncio.ensure_future(pilot_feed(link, [0, 0, 0, 0], stop))
        task = asyncio.ensure_future(link.command("takeoff"))
        await asyncio.sleep(0.3)
        t0 = time.monotonic()
        assert await link.command("land") == "sent"             # 立即送出、不排隊
        resp = await task
        assert resp == "interrupted"
        assert time.monotonic() - t0 < 0.2                     # 不必等 takeoff 的 12 秒逾時
        assert not link.airborne
        assert mock.commands()[-1] == "land"
        # land 的 "ok" 晚點才回來；下一次 ask 前清空佇列 → 不會被當成 battery? 的回應
        await asyncio.sleep(0.8)
        assert await link.command("battery?") == str(int(mock.w.bat))
        stop.set(); await feeder
        await teardown(mock, link)
    run(go())


def test_emergency_is_immediate():
    async def go():
        mock, link, _ = await setup(takeoff_delay=0.2)
        assert await link.command("takeoff") == "ok"
        assert link.flying()
        assert await link.command("emergency") == "sent"
        await asyncio.sleep(0.1)
        assert mock.commands()[-1] == "emergency"
        assert not link.airborne
        await teardown(mock, link)
    run(go())


def test_takeoff_error_clears_airborne_and_flip_needs_battery():
    async def go():
        mock, link, _ = await setup(activated=False, battery=40)
        assert (await link.command("takeoff")).startswith("error")
        assert not link.airborne
        r = await link.command("flip f")
        assert r.startswith("denied") and "50" in r
        assert "flip f" not in mock.commands()
        await teardown(mock, link)
    run(go())


# ---------------------------------------------------------------- 斷訊懸停 / 自動降落
FAST = dict(hover_after=0.1, land_after=0.6, retry_after=0.4, max_tries=3)


def test_control_lost_hovers_then_lands_once():
    async def go():
        # retry 設長一點：模擬器以 60 cm/s 下降，80 cm 要 1.3 秒才落地
        mock, link, events = await setup(safety=Safety(**{**FAST, "retry_after": 2.5}))
        stop = asyncio.Event()
        feeder = asyncio.ensure_future(pilot_feed(link, [0, 50, 0, 0], stop))
        assert await link.command("takeoff") == "ok"
        await asyncio.sleep(0.3)
        assert mock.w.rc == (0, 50, 0, 0)
        stop.set(); await feeder
        t_lost = time.monotonic()
        link.control_lost()                                       # WebSocket 斷線
        await wait_for(lambda: mock.w.rc == (0, 0, 0, 0), 0.2)    # 立刻懸停
        await wait_for(lambda: "land" in mock.commands(), 2.0)
        t_land = next(t for t, c in mock.log if c == "land")
        assert 0.55 < t_land - t_lost < 0.9
        await wait_for(lambda: not mock.w.flying, 3.0)
        await asyncio.sleep(1.0)
        assert mock.commands().count("land") == 1                 # 落地了就不再重送
        assert "auto_land" in events
        await teardown(mock, link)
    run(go())


def test_autoland_retries_then_goes_silent():
    async def go():
        mock, link, events = await setup(safety=Safety(**FAST), ignore_land=True)
        link.set_rc([0, 0, 0, 0])
        assert await link.command("takeoff") == "ok"
        link.control_lost()
        await wait_for(lambda: link.safety.silenced, 4.0)
        assert mock.commands().count("land") == 3
        lands = [t for t, c in mock.log if c == "land"]
        assert all(0.38 < b - a < 0.6 for a, b in zip(lands, lands[1:]))
        n = mock.rc_count
        k = len(mock.log)
        await asyncio.sleep(1.5)                                  # 安靜期間：不送 rc，也不送 command
        assert mock.rc_count == n and len(mock.log) == k
        assert "silenced" in events
        # 控制端回來 → 恢復送 rc
        link.set_rc([0, 0, 0, 0])
        await wait_for(lambda: mock.rc_count > n, 1.0)
        assert not link.safety.silenced
        await teardown(mock, link)
    run(go())


# ---------------------------------------------------------------- 重連（換電池）
def test_reconnects_after_state_goes_stale():
    async def go():
        mock, link, events = await setup(state_stale=0.5)
        mock.o.send_state = False
        await wait_for(lambda: "link_lost" in events, 2.0)
        assert not link.connected()
        await asyncio.sleep(2.0)
        assert events.count("link_lost") == 1             # 持續沒有狀態也只通報一次
        assert not link.connected()
        n_cmd = mock.commands().count("command")
        mock.o.send_state = True
        await wait_for(lambda: link.connected(), 3.0)
        await wait_for(lambda: events.count("link_ok") >= 2, 1.0)  # 恢復時通報一次
        assert mock.commands().count("command") >= n_cmd          # 斷線期間一直在重送 command
        await teardown(mock, link)
    run(go())


# ---------------------------------------------------------------- 結束時降落
def test_shutdown_lands_when_flying_then_closes_sockets():
    async def go():
        mock, link, _ = await setup()
        assert await link.command("takeoff") == "ok"
        await link.shutdown()
        await asyncio.sleep(0.1)
        assert mock.commands().count("land") >= 1
        assert link.cmd_tr is None and link.state_tr is None
        await mock.stop()
    run(go())


def test_shutdown_on_ground_does_not_send_land():
    async def go():
        mock, link, _ = await setup()
        await link.shutdown()
        await asyncio.sleep(0.1)
        assert "land" not in mock.commands()
        await mock.stop()
    run(go())


def test_queries_sdk_and_serial_once_connected():
    async def go():
        mock, link, events = await setup()
        await wait_for(lambda: link.info["sn"] is not None, 3.0)
        assert link.info == {"sdk": "30", "sn": "0TQZSIMULATOR"}
        assert link.sdk_version() == 30
        assert "sdk_old" not in events
        assert link.telemetry()["info"]["sdk"] == "30"
        await teardown(mock, link)
    run(go())


def test_sdk_version_parsing_and_old_firmware_warning():
    link = TelloLink(Settings(tello_host="127.0.0.1", cmd_port=9, state_port=0, video_port=0, sim=True))
    assert link.sdk_version() is None
    link.info["sdk"] = "20"
    assert link.sdk_version() == 20
    link.info["sdk"] = "unknown"
    assert link.sdk_version() is None
