"""任務腳本：解析與範圍檢查、逐步執行、搖桿／降落中止、失敗即停、模擬器的移動指令。"""
import asyncio

import pytest

from gcs.config import Settings
from gcs.link import TelloLink
from gcs.mission import EXAMPLE, MissionRunner, parse
from gcs.protocol import ask_timeout, is_allowed, is_move, move_info
from sim.mock_tello import MockTello, Options


# ---------------------------------------------------------------- 白名單／範圍
@pytest.mark.parametrize("cmd", ["forward 20", "back 500", "up 50", "down 20", "left 100", "right 100",
                                 "cw 1", "ccw 360", "go 50 0 0 30", "go -500 500 -500 100",
                                 "curve 50 50 0 100 0 0 30", "speed 10", "speed 100", "stop"])
def test_move_commands_allowed(cmd):
    assert is_allowed(cmd)
    assert ask_timeout(cmd) is not None
    assert is_move(cmd) == (not cmd.startswith("speed"))


@pytest.mark.parametrize("cmd", ["forward 19", "forward 501", "forward", "forward -20", "cw 0", "cw 361",
                                 "go 10 10 10 30", "go 50 0 0 5", "go 50 0 0 101", "go 600 0 0 30",
                                 "curve 50 0 0 100 0 0 61", "curve 10 0 0 100 0 0 30", "speed 9", "speed 101",
                                 "forward 100 200", "jump 20", "reboot", "forward 1e2"])
def test_bad_move_commands_denied(cmd):
    assert not is_allowed(cmd)
    assert ask_timeout(cmd) is None


def test_move_timeout_scales_with_distance():
    assert move_info("forward 20")["timeout"] < move_info("forward 500")["timeout"] <= 40.0
    assert move_info("go 300 400 0 10")["timeout"] > move_info("go 300 400 0 100")["timeout"]
    assert move_info("speed 50")["flying_only"] is False
    assert move_info("takeoff") is None and not is_move("takeoff") and not is_move("battery?")


# ---------------------------------------------------------------- 解析
def test_parse_example_and_comments():
    steps, errors = parse(EXAMPLE)
    assert errors == []
    assert [s.cmd for s in steps][:3] == ["takeoff", "up 50", "forward 60"]
    assert steps[-2].cmd == "wait 2" and steps[-2].kind == "wait"
    assert steps[-1].cmd == "land"
    assert steps[0].line == 2                     # 第 1 行是註解


def test_parse_errors_have_line_numbers():
    script = "takeoff\nforward 10\nwait\nwait abc\nwait 99\nemergency\nbattery?\nfly away\n  CW  90  # ok\n"
    steps, errors = parse(script)
    assert [s.cmd for s in steps] == ["takeoff", "cw 90"]
    joined = "\n".join(errors)
    for line in ("第 2 行", "第 3 行", "第 4 行", "第 5 行", "第 6 行", "第 7 行", "第 8 行"):
        assert line in joined, joined
    assert "20–500" in joined and "emergency" in joined and "不是飛行動作" in joined
    assert parse("")[1] == ["腳本是空的"]
    assert parse("# only comment")[1] == ["腳本是空的"]
    assert parse("\n".join(["cw 10"] * 61))[1][-1].startswith("最多 60 步")


# ---------------------------------------------------------------- 執行（真的 TelloLink ＋ loopback 模擬器）
async def setup(**mock_kw):
    opt = Options(host="127.0.0.1", cmd_port=0, state_port=0, video=False, quiet=True,
                  takeoff_delay=mock_kw.pop("takeoff_delay", 0.2), **mock_kw)
    mock = MockTello(opt)
    await mock.start()
    s = Settings(tello_host="127.0.0.1", cmd_port=mock.cmd_port_bound, state_port=0, video_port=0, sim=True)
    events = []
    link = TelloLink(s, wifi_poll=999, wifi_first=999, on_event=lambda lv, code, msg: events.append(code))
    await link.start()
    mock.o.state_port = link.state_port_bound
    for _ in range(150):
        if link.connected():
            break
        await asyncio.sleep(0.02)
    assert link.connected()
    changes = []
    runner = MissionRunner(link, on_change=changes.append, on_event=lambda lv, code, msg: events.append(code))
    # 像真的機長一樣持續送 rc 0（否則 8 秒斷訊保護會自動降落；rc_time 初始值極早，第一拍就會觸發）
    link.set_rc((0, 0, 0, 0))
    link._feeder = asyncio.ensure_future(feed_rc(link, (0, 0, 0, 0), lambda: False))
    return mock, link, runner, events, changes


async def teardown(mock, link):
    link._feeder.cancel()
    await link.shutdown()
    await mock.stop()


async def feed_rc(link, vals, until, step=0.03):
    while not until():
        link.set_rc(vals)
        await asyncio.sleep(step)


async def wait_done(runner, timeout=15.0):
    for _ in range(int(timeout / 0.02)):
        if not runner.running:
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"任務沒有在 {timeout} 秒內結束：{runner.status()}")


def test_mission_runs_to_completion_and_lands():
    async def go():
        mock, link, runner, events, changes = await setup()
        mock.w.speed = 100.0
        ok, errors = runner.start("takeoff\nup 20\nforward 30\ncw 90\nwait 0.3\nspeed 60\nland\n")
        assert ok and errors == [], errors
        assert runner.running and "mission_start" in events
        await wait_done(runner)
        st = runner.status()
        assert st["state"] == "done", st
        assert [s["status"] for s in st["steps"]] == ["ok"] * 7
        assert [s["resp"] for s in st["steps"]][:3] == ["ok", "ok", "ok"]
        cmds = mock.commands()
        assert cmds.index("takeoff") < cmds.index("up 20") < cmds.index("forward 30") < cmds.index("cw 90") < cmds.index("speed 60") < cmds.index("land")
        for _ in range(100):                                  # 模擬器還要幾百毫秒才真的落地
            if not mock.w.flying:
                break
            await asyncio.sleep(0.03)
        assert mock.w.speed == 60.0 and not mock.w.flying
        assert abs(mock.w.yaw - 90) < 15, mock.w.yaw
        assert "mission_done" in events
        assert st["elapsed_s"] is not None and st["elapsed_s"] >= 0.3
        assert changes[-1]["state"] == "done" and len(changes) >= 8
        await teardown(mock, link)
    asyncio.run(go())


def test_mission_preconditions():
    async def go():
        mock, link, runner, events, changes = await setup()
        ok, errors = runner.start("forward 50")
        assert not ok and "takeoff" in errors[0]
        ok, errors = runner.start("forward 10")
        assert not ok and "第 1 行" in errors[0]
        assert await link.command("takeoff") == "ok"
        ok, errors = runner.start("takeoff\nforward 50")
        assert not ok and "已經在空中" in errors[0]
        mock.w.bat = 15
        await asyncio.sleep(0.25)
        ok, errors = runner.start("forward 50")
        assert not ok and "電量" in errors[0]
        link.immediate("land")
        await teardown(mock, link)
    asyncio.run(go())


def test_stick_abort_sends_stop_and_skips_rest():
    async def go():
        mock, link, runner, events, changes = await setup()
        mock.w.speed = 20.0                      # forward 100 要 5 秒
        assert await link.command("takeoff") == "ok"
        ok, _ = runner.start("forward 100\ncw 90\nland")
        assert ok
        for _ in range(100):
            if mock.w.moving == "forward 100":
                break
            await asyncio.sleep(0.02)
        assert mock.w.moving == "forward 100"
        await asyncio.sleep(0.3)
        assert runner.abort("搖桿介入")
        await wait_done(runner, 3.0)
        st = runner.status()
        assert st["state"] == "aborted" and st["reason"] == "搖桿介入"
        assert st["steps"][0]["status"] == "skipped" and st["steps"][0]["resp"] == "interrupted"
        assert st["steps"][1]["status"] == "skipped" and st["steps"][2]["status"] == "skipped"
        assert "stop" in mock.commands() and "cw 90" not in mock.commands() and "land" not in mock.commands()
        assert mock.w.flying and mock.w.moving is None       # 還在空中、停住
        assert "mission_aborted" in events
        assert not runner.abort("再一次")                    # 已經不在執行中
        link.immediate("land")
        await teardown(mock, link)
    asyncio.run(go())


def test_land_during_mission_aborts_it():
    async def go():
        mock, link, runner, events, changes = await setup()
        mock.w.speed = 20.0
        assert await link.command("takeoff") == "ok"
        ok, _ = runner.start("forward 100\ncw 90")
        assert ok
        await asyncio.sleep(0.4)
        assert await link.command("land") == "sent"
        await wait_done(runner, 3.0)
        st = runner.status()
        assert st["state"] == "aborted" and "降落" in st["reason"]
        assert mock.commands().count("stop") == 0            # 被降落取代時不送 stop
        await teardown(mock, link)
    asyncio.run(go())


def test_failed_step_stops_mission():
    async def go():
        mock, link, runner, events, changes = await setup()
        mock.w.speed = 100.0
        assert await link.command("takeoff") == "ok"
        mock.w.bat = 40                                      # flip 需要 50%
        await asyncio.sleep(0.25)
        ok, _ = runner.start("forward 20\nflip f\nforward 20")
        assert ok
        await wait_done(runner, 5.0)
        st = runner.status()
        assert st["state"] == "error" and "第 2 行" in st["reason"] and "flip f" in st["reason"]
        assert [s["status"] for s in st["steps"]] == ["ok", "error", "pending"]
        assert mock.commands().count("forward 20") == 1
        assert "mission_error" in events
        link.immediate("land")
        await teardown(mock, link)
    asyncio.run(go())
