"""Playwright 端對端：注入假的 navigator.getGamepads，驗證按鍵、搖桿數值、防誤觸，並截圖檢查版面。

使用本機已安裝的 Edge（或 Chrome）：Playwright 內建的 Chromium 沒有 H.264 解碼器。
    python -m pytest tests/e2e            # 預設 msedge
    E2E_CHANNEL=chrome python -m pytest tests/e2e
"""
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

pw = pytest.importorskip("playwright.sync_api")

from sim.mock_tello import MockThread, Options  # noqa: E402

pytestmark = pytest.mark.e2e
ROOT = Path(__file__).resolve().parents[2]
SHOTS = Path(__file__).resolve().parent / "screenshots"
PORTS = dict(cmd=38889, state=38890, video=41111, http=38080)
URL = f"http://localhost:{PORTS['http']}"
CHANNEL = os.environ.get("E2E_CHANNEL", "msedge")

FAKE_PAD = """
(() => {
  const blank = () => ({ pressed: false, touched: false, value: 0 });
  window.__rumbles = [];
  window.__pad = {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)',
    index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, blank),
    vibrationActuator: { type: 'dual-rumble', playEffect(t, p) { window.__rumbles.push([t, p]); return Promise.resolve('complete'); } },
  };
  window.__padOn = true;
  Object.defineProperty(Navigator.prototype, 'getGamepads', {
    configurable: true, value: () => [window.__padOn ? window.__pad : null, null, null, null] });
  window.__btn = (i, v) => { window.__pad.buttons[i] = { pressed: !!v, touched: !!v, value: v ? 1 : 0 }; };
  window.__axes = (a) => { window.__pad.axes = a; };
})();
"""

A, B, X, Y, LB, RB, LT, RT, VIEW = 0, 1, 2, 3, 4, 5, 6, 7, 8
UP = 12


@pytest.fixture(scope="module")
def browser():
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch(channel=CHANNEL, headless=True)
        except Exception as e:  # pragma: no cover
            pytest.skip(f"找不到瀏覽器 {CHANNEL}：{e}")
        yield b
        b.close()


@pytest.fixture()
def stack():
    mock = MockThread(Options(host="127.0.0.1", cmd_port=PORTS["cmd"], state_port=PORTS["state"],
                              video_port=PORTS["video"], takeoff_delay=0.6, quiet=True)).start()
    env = dict(os.environ, TELLO_IP="127.0.0.1", TELLO_CMD_PORT=str(PORTS["cmd"]), STATE_PORT=str(PORTS["state"]),
               VIDEO_PORT=str(PORTS["video"]), HTTP_PORT=str(PORTS["http"]), TELLO_SIM="1")
    gcs = subprocess.Popen([sys.executable, "-m", "gcs"], cwd=ROOT, env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            urllib.request.urlopen(f"{URL}/api/health", timeout=0.5)
            break
        except OSError:
            time.sleep(0.1)
    yield mock
    gcs.kill()
    gcs.wait()
    mock.stop()


OPEN = []


@pytest.fixture(autouse=True)
def _close_contexts(stack):
    # 測試失敗時也要關掉分頁，否則它的 WebSocket 會重連到下一個測試的地面站、搶走機長
    yield
    while OPEN:
        try:
            OPEN.pop().close()
        except Exception:
            pass


def new_ctx(browser, **kw):
    ctx = browser.new_context(**kw)
    OPEN.append(ctx)
    return ctx


def open_page(browser, w=1280, h=720):
    ctx = new_ctx(browser, viewport={"width": w, "height": h}, color_scheme="dark", accept_downloads=True)
    ctx.add_init_script(FAKE_PAD)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("window.__gcs && window.__gcs.S.tel && window.__gcs.S.tel.connected", timeout=8000)
    page.wait_for_function("window.__gcs.S.role === 'pilot'")
    page.wait_for_function("window.__gcs.S.pf && window.__gcs.S.pf.pass")
    return page, errors


def press(page, *buttons, hold=0.12):
    for b in buttons:
        page.evaluate(f"window.__btn({b}, 1)")
    page.wait_for_timeout(int(hold * 1000))
    for b in buttons:
        page.evaluate(f"window.__btn({b}, 0)")
    page.wait_for_timeout(80)


def wait_cmd(mock, cmd, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cmd in mock.mock.commands():
            return True
        time.sleep(0.05)
    raise AssertionError(f"模擬器沒收到 {cmd}；收到 {mock.mock.commands()}")


def wait_rc(mock, expected, timeout=2.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if mock.mock.w.rc == expected:
            return
        time.sleep(0.03)
    raise AssertionError(f"rc 應為 {expected}，實際 {mock.mock.w.rc}")


def toast_text(page):
    return page.locator("#toasts").inner_text()


# ---------------------------------------------------------------- 起飛 / 降落 / 緊急停槳
def test_a_takeoff_b_land(browser, stack):
    page, errors = open_page(browser)
    page.wait_for_function("document.querySelector('#pfSummary').textContent.includes('全部通過')")
    press(page, A)
    wait_cmd(stack, "takeoff")
    page.wait_for_function("window.__gcs.S.tel.flying === true", timeout=5000)
    page.wait_for_function("document.querySelector('#toasts').textContent.includes('起飛：成功')")
    assert page.evaluate("window.__rumbles.length") > 0          # 起飛有震動
    press(page, B)
    wait_cmd(stack, "land")
    page.wait_for_function("document.querySelector('#toasts').textContent.includes('降落：已送出')")
    assert errors == []
    page.context.close()


def test_lb_rb_emergency(browser, stack):
    page, _ = open_page(browser)
    press(page, A)
    wait_cmd(stack, "takeoff")
    page.wait_for_function("window.__gcs.S.tel.flying === true", timeout=5000)
    press(page, LB)                     # 只按 LB：不會停槳
    press(page, RB)                     # 只按 RB：不會停槳
    page.wait_for_timeout(300)
    assert "emergency" not in stack.mock.commands()
    press(page, LB, RB)
    wait_cmd(stack, "emergency")
    assert not stack.mock.w.motors
    page.context.close()


def test_mouse_emergency_needs_1s_hold_and_keyboard_shift_esc(browser, stack):
    page, _ = open_page(browser)
    btn = page.locator("#btnEmg")
    box = btn.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down(); page.wait_for_timeout(400); page.mouse.up()       # 短按：不觸發
    page.wait_for_timeout(800)
    assert "emergency" not in stack.mock.commands()
    page.mouse.down(); page.wait_for_timeout(1250); page.mouse.up()      # 長按 1 秒：觸發
    wait_cmd(stack, "emergency")
    n = stack.mock.commands().count("emergency")
    page.keyboard.press("Shift+Escape")
    t0 = time.time()
    while stack.mock.commands().count("emergency") == n and time.time() - t0 < 3:
        time.sleep(0.05)
    assert stack.mock.commands().count("emergency") == n + 1
    page.context.close()


# ---------------------------------------------------------------- 搖桿數值
def test_stick_values_mode2_deadzone_and_speed(browser, stack):
    page, _ = open_page(browser)
    # 右搖桿全推前 → b = +60（一般 60%）
    page.evaluate("window.__axes([0, 0, 0, -1])")
    wait_rc(stack, (0, 60, 0, 0))
    assert page.locator("#rcB").inner_text() == "+60"
    # LT 精細 30%、RT 全速 100%
    page.evaluate(f"window.__btn({LT}, 1)"); wait_rc(stack, (0, 30, 0, 0)); page.evaluate(f"window.__btn({LT}, 0)")
    page.evaluate(f"window.__btn({RT}, 1)"); wait_rc(stack, (0, 100, 0, 0))
    page.wait_for_function("document.querySelector('#modeVal').textContent === '全速'")   # 畫面 10 Hz 更新
    page.evaluate(f"window.__btn({RT}, 0)")
    # 左搖桿：上推 0.56 → 升降 c = round((0.56-0.12)/0.88*60) = 30；右推 1 → 轉向 d = 60
    page.evaluate("window.__axes([1, -0.56, 0, 0])")
    wait_rc(stack, (0, 0, 30, 60))
    # 右搖桿：左推 → a = -60；後拉 → b = -60
    page.evaluate("window.__axes([0, 0, -1, 1])")
    wait_rc(stack, (-60, -60, 0, 0))
    # 死區內 0.1 → 全部 0
    page.evaluate("window.__axes([0.1, -0.1, 0.11, -0.09])")
    wait_rc(stack, (0, 0, 0, 0))
    page.context.close()


def test_preflight_blocks_takeoff_when_stick_not_centered(browser, stack):
    page, _ = open_page(browser)
    page.evaluate("window.__axes([0, 0, 0, -0.5])")
    page.wait_for_function("document.querySelector('#pfSummary').textContent.includes('未通過')")
    page.screenshot(path=str(SHOTS / "preflight-blocked-1280x720.png"))
    press(page, A)
    page.wait_for_function("document.querySelector('#toasts').textContent.includes('飛前檢查未通過')")
    assert "takeoff" not in stack.mock.commands()
    assert "兩支搖桿都置中" in toast_text(page)
    page.context.close()


def test_preflight_blocks_without_gamepad_and_low_battery(browser, stack):
    page, _ = open_page(browser)
    page.evaluate("window.__padOn = false")
    page.wait_for_function("document.querySelector('[data-id=gamepad]').dataset.level === 'danger'")
    page.locator("#btnTakeoff").click(force=True)            # aria-disabled：點了只會顯示原因
    page.wait_for_timeout(300)
    assert "takeoff" not in stack.mock.commands()
    page.evaluate("window.__padOn = true")
    stack.call(lambda: setattr(stack.mock.w, "bat", 18.0))
    page.wait_for_function("document.querySelector('[data-id=battery]').dataset.level === 'danger'")
    press(page, A)
    page.wait_for_timeout(300)
    assert "takeoff" not in stack.mock.commands()
    page.context.close()


def test_flip_needs_x_and_battery_50(browser, stack):
    page, _ = open_page(browser)
    press(page, A)
    page.wait_for_function("window.__gcs.S.tel.flying === true", timeout=5000)
    press(page, UP)                                         # 只按十字鍵：不翻滾
    page.wait_for_timeout(300)
    assert not any(c.startswith("flip") for c in stack.mock.commands())
    page.evaluate(f"window.__btn({X}, 1)"); press(page, UP); page.evaluate(f"window.__btn({X}, 0)")
    wait_cmd(stack, "flip f")
    stack.call(lambda: setattr(stack.mock.w, "bat", 45.0))
    page.wait_for_function("document.querySelector('#flipState').textContent.includes('電量低於 50%')")
    n = stack.mock.commands().count("flip f")
    page.evaluate(f"window.__btn({X}, 1)"); press(page, UP); page.evaluate(f"window.__btn({X}, 0)")
    page.wait_for_function("document.querySelector('#toasts').textContent.includes('翻滾停用')")
    assert stack.mock.commands().count("flip f") == n
    page.context.close()


def test_keyboard_backup(browser, stack):
    page, _ = open_page(browser)
    page.keyboard.down("KeyW")
    wait_rc(stack, (0, 60, 0, 0))
    page.keyboard.up("KeyW")
    page.keyboard.down("ArrowUp")
    wait_rc(stack, (0, 0, 60, 0))
    page.keyboard.up("ArrowUp")
    wait_rc(stack, (0, 0, 0, 0))
    page.keyboard.press("KeyL")
    wait_cmd(stack, "land")
    page.context.close()


def test_observer_tab_cannot_fly_until_takeover(browser, stack):
    page, _ = open_page(browser)
    ctx2 = new_ctx(browser, viewport={"width": 1280, "height": 720})
    ctx2.add_init_script(FAKE_PAD)
    p2 = ctx2.new_page()
    p2.goto(URL)
    p2.wait_for_function("window.__gcs && window.__gcs.S.role === 'observer' && window.__gcs.S.tel")
    p2.evaluate("window.__axes([0, 0, 0, -1])")
    p2.wait_for_timeout(400)
    assert stack.mock.w.rc == (0, 0, 0, 0)                  # 觀看分頁的搖桿不會影響無人機
    p2.evaluate("window.__axes([0, 0, 0, 0])")
    page.context.close()                                     # 機長離開
    p2.wait_for_function("document.querySelector('#roleLine').textContent.includes('沒有機長')")
    assert p2.evaluate("window.__gcs.S.role") == "observer"  # 不會自動升格
    p2.locator("#btnTakeover").click()
    p2.locator("#btnTakeoverOk").click()
    p2.wait_for_function("window.__gcs.S.role === 'pilot'")
    p2.evaluate("window.__axes([0, 0, 0, -1])")
    wait_rc(stack, (0, 60, 0, 0))
    ctx2.close()


# ---------------------------------------------------------------- 影像＋截圖
@pytest.mark.parametrize("w,h", [(1280, 720), (1920, 1080)])
def test_layout_screenshots_with_video(browser, stack, w, h):
    SHOTS.mkdir(exist_ok=True)
    page, errors = open_page(browser, w, h)
    press(page, A)
    page.wait_for_function("window.__gcs.S.tel.flying === true", timeout=5000)
    page.evaluate("window.__axes([0.3, -0.6, 0.2, -0.45])")
    press(page, Y)
    page.wait_for_function("window.__gcs.player.hasFrame === true", timeout=15000)
    assert page.evaluate("window.__gcs.player.mode") == "webcodecs"
    page.wait_for_timeout(1500)
    # 版面：沒有水平捲軸、影像區維持 4:3、主要元件都在畫面內
    assert page.evaluate("document.documentElement.scrollWidth") <= w
    assert page.evaluate("document.documentElement.scrollHeight") <= h
    vb = page.locator("#videoFrame").bounding_box()
    assert abs(vb["width"] / vb["height"] - 4 / 3) < 0.02
    for sel in ("#stConn", "#stBat", "#stTime", "#stWifi", "#stTemp", "#stMode", "#btnTakeoff", "#btnEmg",
                "#stickL", "#stickR", "#preflight", "#eventLog"):
        b = page.locator(sel).bounding_box()
        assert b and b["x"] >= 0 and b["y"] >= 0 and b["x"] + b["width"] <= w + 1 and b["y"] + b["height"] <= h + 1, sel
    # 關鍵數值字級 ≥ 28px
    for sel in ("#batVal", "#timeVal", "#hudH", "#hudVh"):
        fs = page.evaluate(f"parseFloat(getComputedStyle(document.querySelector('{sel}')).fontSize)")
        assert fs >= 28, (sel, fs)
    page.screenshot(path=str(SHOTS / f"main-{w}x{h}.png"))
    # 拍照
    with page.expect_download() as dl:
        page.locator("#btnPhoto").click()
    assert dl.value.suggested_filename.endswith(".png")
    if w == 1280:
        page.keyboard.press("Shift+Slash")
        page.wait_for_selector("#dlgHelp[open]")
        page.wait_for_timeout(200)
        page.screenshot(path=str(SHOTS / "help-1280x720.png"))
        page.keyboard.press("Escape")
        # 電量危急（紅色＋震動）
        stack.call(lambda: setattr(stack.mock.w, "bat", 14.0))
        page.wait_for_function("document.querySelector('#stBat').dataset.level === 'danger'")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / "battery-critical-1280x720.png"))
        assert any(r[1]["strongMagnitude"] == 1.0 for r in page.evaluate("window.__rumbles"))
    assert errors == []
    page.context.close()


def test_recording_webm(browser, stack):
    page, _ = open_page(browser)
    press(page, Y)
    page.wait_for_function("window.__gcs.player.hasFrame === true", timeout=15000)
    page.locator("#btnRec").click()
    page.wait_for_timeout(1500)
    with page.expect_download() as dl:
        page.locator("#btnRec").click()
    assert dl.value.suggested_filename.endswith(".webm")
    assert Path(dl.value.path()).stat().st_size > 1000
    page.context.close()


def test_link_lost_red_frame(browser, stack):
    page, _ = open_page(browser)
    stack.mock.o.send_state = False
    page.wait_for_selector("#linkAlarm:not([hidden])", timeout=8000)
    assert "與 Tello 的連線中斷" in page.locator("#linkAlarm").inner_text()
    page.screenshot(path=str(SHOTS / "link-lost-1280x720.png"))
    stack.mock.o.send_state = True
    page.wait_for_selector("#linkAlarm", state="hidden", timeout=8000)
    page.context.close()


def test_flight_log_summary_and_csv(browser, stack):
    """起飛 → 往前飛 → 降落：落地後面板出現本趟摘要、CSV 可下載、診斷頁列出這趟。"""
    import csv as _csv
    import io as _io
    page, errors = open_page(browser)
    page.wait_for_function("document.querySelector('#pfSummary').textContent.includes('全部通過')")
    assert page.locator("#flightRow").is_hidden()
    press(page, A)
    wait_cmd(stack, "takeoff")
    page.wait_for_function("window.__gcs.S.tel.flying === true", timeout=5000)
    page.evaluate("window.__axes([0, 0, 0, -0.8])")        # 右搖桿往前
    wait_rc(stack, (0, 46, 0, 0), timeout=3.0)
    page.wait_for_timeout(800)
    page.evaluate("window.__axes([0, 0, 0, 0])")
    page.wait_for_function("window.__gcs.S.tel.flight_n === 1")
    press(page, B)
    wait_cmd(stack, "land")
    page.wait_for_selector("#flightRow:not([hidden])", timeout=10000)
    summary = page.locator("#flightSummary").inner_text()
    assert "第 1 趟飛行" in summary and "最高" in summary and "最快" in summary, summary
    page.wait_for_function("document.querySelector('#toasts').textContent.includes('飛行結束')")
    assert page.locator("#flightCsv").get_attribute("href").endswith("flight=1")
    # 下載這趟的 CSV：有 takeoff / land 指令、有送出的 rc
    with page.expect_download() as dl:
        page.evaluate("document.getElementById('flightCsv').click()")
    path = dl.value.path()
    rows = list(_csv.reader(_io.StringIO(open(path, encoding="utf-8").read())))
    hdr = rows[0]
    assert hdr[:4] == ["t", "wall", "flight", "flying"] and "cmd" in hdr and "rc_b" in hdr
    cmds = [r[hdr.index("cmd")] for r in rows[1:]]
    assert "takeoff" in cmds and "land" in cmds
    assert any(r[hdr.index("rc_b")] == "46" for r in rows[1:])
    assert all(r[hdr.index("flight")] in ("", "1") for r in rows[1:])
    assert dl.value.suggested_filename.endswith("-flight1.csv")
    # /api/flights 與診斷頁
    import json as _json
    j = _json.loads(urllib.request.urlopen(f"{URL}/api/flights", timeout=2).read())
    assert len(j["flights"]) == 1 and j["flights"][0]["n"] == 1 and j["flights"][0]["bat_used"] is not None
    page.goto(f"{URL}/diag")
    page.wait_for_function("!document.querySelector('#tblFlights').hidden", timeout=8000)
    assert "CSV" in page.locator("#tblFlights tbody").inner_text()
    assert "1 趟" in page.locator("#cardFlights h2").get_attribute("data-status")
    assert errors == []
    page.context.close()


# ---------------------------------------------------------------- 任務腳本
def test_mission_script_runs_and_stick_aborts(browser, stack):
    page, errors = open_page(browser)
    page.wait_for_function("document.querySelector('#pfSummary').textContent.includes('全部通過')")
    stack.mock.w.speed = 100.0
    # M 開對話框：預載範例、格式檢查通過
    page.keyboard.press("m")
    page.wait_for_selector("#dlgMission[open]")
    page.wait_for_function("document.querySelector('#msnErrors').textContent.includes('格式正確')")
    assert "takeoff" in page.locator("#msnScript").input_value()
    # 錯誤有行號、執行鈕停用
    page.fill("#msnScript", "takeoff\nforward 10\nland")
    page.wait_for_function("document.querySelector('#msnErrors').textContent.includes('第 2 行')")
    assert page.locator("#btnMissionRun").is_disabled()
    # 正確腳本 → 執行到完成（起飛、升 20、前進 30、轉 90、落地）
    page.fill("#msnScript", "takeoff\nup 20\nforward 30\ncw 90\nwait 0.3\nland")
    page.wait_for_function("!document.querySelector('#btnMissionRun').disabled")
    page.click("#btnMissionRun")
    page.wait_for_selector("#dlgMission", state="hidden")
    page.wait_for_function("document.querySelector('#msnText').textContent.includes('執行中')")
    page.wait_for_selector("#hudMission:not([hidden])")
    wait_cmd(stack, "takeoff")
    page.wait_for_function("document.querySelector('#msnText').textContent.includes('完成')", timeout=20000)
    cmds = stack.mock.commands()
    assert cmds.index("takeoff") < cmds.index("up 20") < cmds.index("forward 30") < cmds.index("cw 90") < cmds.index("land")
    assert page.locator("#msnSteps li[data-status='ok']").count() == 6
    page.wait_for_function("document.querySelector('#toasts').textContent.includes('任務完成')")
    assert page.locator("#hudMission").is_hidden()
    page.wait_for_function("window.__gcs.S.tel.flying === false", timeout=8000)
    for _ in range(100):                                      # 模擬器要真的落地（馬達停）才能再起飛
        if not stack.mock.w.flying:
            break
        time.sleep(0.05)
    assert not stack.mock.w.flying
    # 第二趟：長距離前進時推搖桿 → 中止、送 stop、剩下的步驟略過
    stack.mock.w.speed = 20.0
    before = len(stack.mock.commands())
    page.evaluate("window.__gcs.openMission()")
    page.fill("#msnScript", "takeoff\nforward 100\ncw 90\nland")
    page.wait_for_function("!document.querySelector('#btnMissionRun').disabled")
    page.click("#btnMissionRun")
    try:
        page.wait_for_function("document.querySelector('#msnText').textContent.includes('forward 100')", timeout=15000)
    except Exception:
        raise AssertionError(f"任務沒有走到 forward 100：面板={page.locator('#msnText').inner_text()!r} 錯誤={page.locator('#msnErrors').inner_text()!r} 指令={stack.mock.commands()[before:]}")
    page.wait_for_timeout(500)
    page.evaluate("window.__axes([0, 0, 0, -0.8])")          # 右搖桿往前 → 介入
    page.wait_for_function("document.querySelector('#msnText').textContent.includes('已中止')", timeout=5000)
    assert "搖桿介入" in page.locator("#msnText").inner_text()
    page.evaluate("window.__axes([0, 0, 0, 0])")
    tail = stack.mock.commands()[before:]
    assert "stop" in tail and "cw 90" not in tail and "land" not in tail
    assert page.locator("#msnSteps li[data-status='skipped']").count() == 3
    assert page.evaluate("window.__gcs.S.tel.flying") is True       # 還在空中、由人接手
    press(page, B)
    wait_cmd(stack, "land")
    assert errors == []
    page.context.close()


def test_diag_page(browser, stack):
    ctx = new_ctx(browser, viewport={"width": 1280, "height": 720}, color_scheme="dark")
    ctx.add_init_script(FAKE_PAD)
    page = ctx.new_page()
    page.goto(f"{URL}/diag")
    page.wait_for_function("document.querySelector('#dlState') && document.querySelector('#dlState').textContent.includes('127.0.0.1')", timeout=8000)
    page.wait_for_function("document.querySelector('#cardPad').dataset.level === 'ok'")
    assert "Xbox" in page.locator("#dlPad").inner_text()
    page.screenshot(path=str(SHOTS / "diag-1280x720.png"), full_page=True)
    # 有指令回應、沒有狀態封包 → 建議檢查防火牆 8890
    stack.mock.o.send_state = False
    page.wait_for_timeout(1500)
    ctx.close()
