"""跟隨模式端對端測試。

1. 閉迴路（模擬器）：用合成的人取代偵測模型，人的位置跟著模擬器回報的航向變化
   → 驗證會轉向對準、手勢調高度／距離、搖桿介入與恢復、多人切換目標、遺失時懸停、降落。
2. 真模型：在無頭 Edge 載入專案內的 MediaPipe 模型，偵測一張真人照片（MediaPipe 官方範例圖，
   測試時下載到 .pytest_cache；離線就跳過）。
"""
import time
import urllib.request
from pathlib import Path

import pytest

# 用同目錄的模組名稱匯入（不用 tests.e2e.…：有些電腦的 PYTHONPATH 裡有別的專案也叫 tests）
from test_ui import A, B, OPEN, URL, open_page, press, wait_cmd  # noqa: F401  (fixtures 也要匯入)
from test_ui import browser, stack, _close_contexts  # noqa: F401

pytestmark = pytest.mark.e2e
ROOT = Path(__file__).resolve().parents[2]
SYN = (ROOT / "tests" / "js" / "synthetic.mjs").read_text(encoding="utf-8")
MENU, LEFT, RIGHT = 9, 14, 15
SHOTS = Path(__file__).resolve().parent / "screenshots"

# 假的世界：每個人有一個「方位角」；畫面位置＝方位角相對無人機航向（水平視角約 70°）
WORLD = """
async () => {
  const { person } = await import('/static/__test/synthetic.mjs');
  const { describePerson } = await import('/static/js/follow/geometry.js');
  const red = new Array(24).fill(0); red[2] = 1;
  const blue = new Array(24).fill(0); blue[14] = 1;
  window.__world = { people: [{ bearing: 25, t: 0.19, arms: {}, feat: red }], blue, red };
  window.__cx = (b) => 0.5 + (b - ((window.__gcs.S.tel && window.__gcs.S.tel.yaw) || 0)) / 70;
  window.__gcs.follow.fake = () => window.__world.people.map((p) => {
    const cx = window.__cx(p.bearing);
    if (cx < 0.08 || cx > 0.92) return null;
    const d = describePerson(person({ cx, t: p.t, arms: p.arms }), 4 / 3);
    if (d) d.feat = p.feat;
    return d;
  }).filter(Boolean);
}
"""


def follow_page(browser):
    page, errors = open_page(browser)
    page.route("**/static/__test/synthetic.mjs",
               lambda r: r.fulfill(status=200, content_type="text/javascript", body=SYN))
    page.evaluate(WORLD)
    return page, errors


def until(pred, timeout=2.0, msg=""):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return
        time.sleep(0.03)
    raise AssertionError(msg or "條件未達成")


def st(page):
    return page.evaluate("window.__gcs.follow.status()")


def wait_phase(page, phase, timeout=6000):
    page.wait_for_function(f"window.__gcs.follow.phase === '{phase}'", timeout=timeout)


def test_follow_closed_loop_gestures_override_and_targets(browser, stack):
    page, errors = follow_page(browser)

    # ---- 開啟（手把 Menu）→ 畫面只有一個人 → 自動鎖定；地面上不送跟隨指令
    press(page, MENU)
    wait_phase(page, "ready")
    s = st(page)
    assert s["enabled"] and s["target"] is not None and len(s["people"]) == 1
    assert page.locator("#flwText").inner_text() == "已鎖定，起飛後開始跟隨"

    # ---- 起飛 → 開始跟隨：人在右邊 25° → 向右轉，直到對準
    press(page, A)
    wait_cmd(stack, "takeoff")
    page.wait_for_function("window.__gcs.S.tel.flying === true", timeout=6000)
    wait_phase(page, "follow")
    page.wait_for_function("window.__gcs.follow.rc[3] > 0", timeout=3000)
    page.wait_for_function("Math.abs(window.__cx(25) - 0.5) < 0.04", timeout=8000)
    page.wait_for_timeout(600)
    assert abs(page.evaluate("window.__cx(25)") - 0.5) < 0.05
    s = st(page)
    assert s["spInit"] and 2.2 < s["sp"]["dist"] < 2.8           # 起飛後以當下距離當設定值
    h0 = s["sp"]["height"]

    # ---- 手勢：舉右手 1 秒 → 設定高度 +30 cm → 實際爬升
    page.evaluate("window.__world.people[0].arms = { r: 'up' }")
    page.wait_for_function(f"window.__gcs.follow.sp.height === {h0 + 30}", timeout=3000)
    page.evaluate("window.__world.people[0].arms = {}")
    assert "手勢：升高" in page.locator("#toasts").inner_text()
    page.wait_for_function(f"window.__gcs.S.tel.h >= {h0 + 20}", timeout=6000)

    # ---- 手勢：雙手胸前交叉 → 設定距離 -0.5 m → 往前飛（rc b > 0）
    d0 = st(page)["sp"]["dist"]
    page.evaluate("window.__world.people[0].arms = { l: 'cross', r: 'cross' }")
    page.wait_for_function(f"window.__gcs.follow.sp.dist < {d0 - 0.4}", timeout=3000)
    page.evaluate("window.__world.people[0].arms = {}")
    page.wait_for_function("window.__gcs.follow.rc[1] > 0", timeout=2000)
    until(lambda: stack.mock.w.rc[1] > 0, msg=f"模擬器 rc {stack.mock.w.rc}")

    # ---- 搖桿介入：左搖桿往左 → rc 完全交給手動；放開 1 秒後恢復，並用當下距離當新設定
    page.evaluate("window.__axes([-1, 0, 0, 0])")
    wait_phase(page, "manual", 2000)
    until(lambda: stack.mock.w.rc == (0, 0, 0, -60), msg=f"模擬器 rc {stack.mock.w.rc}")
    page.evaluate("window.__axes([0, 0, 0, 0])")
    wait_phase(page, "resume", 1000)
    t0 = time.time()
    wait_phase(page, "follow", 3000)
    assert time.time() - t0 >= 0.6
    # 介入後：當下距離＝新設定
    page.wait_for_function("window.__gcs.follow.sp.dist > 2.2 && window.__gcs.follow.sp.dist < 2.8", timeout=1000)
    page.wait_for_function("document.querySelector('#toasts').textContent.includes('恢復跟隨')", timeout=1000)

    # ---- 多人：第二個人（藍衣）出現在右邊 → 十字鍵 → 切換目標 → 轉過去對準他
    page.evaluate("window.__world.people.push({ bearing: 47, t: 0.19, arms: {}, feat: window.__world.blue })")
    page.wait_for_function("window.__gcs.follow.status().people.length === 2", timeout=3000)
    first = st(page)["target"]
    press(page, RIGHT)
    page.wait_for_function(f"window.__gcs.follow.status().target !== {first}", timeout=2000)
    second = st(page)["target"]
    assert page.locator("#flwPeople button[aria-pressed=true]").inner_text() == f"#{second}"
    b2 = page.evaluate("window.__world.people[1].bearing")
    page.wait_for_function(f"Math.abs(window.__cx({b2}) - 0.5) < 0.05", timeout=6000)
    # 點畫面上的人也能選：點回第一個人（它現在在畫面左邊，藍衣在中間）
    assert page.evaluate("window.__cx(window.__world.people[0].bearing)") < 0.3
    box = page.locator("#followOverlay").bounding_box()
    cx = page.evaluate(f"window.__cx(window.__world.people[0].bearing)")
    page.mouse.click(box["x"] + box["width"] * cx, box["y"] + box["height"] * 0.5)
    page.wait_for_function(f"window.__gcs.follow.status().target === {first}", timeout=2000)

    # ---- 目標離開畫面 → 懸停（rc 全 0）；3 秒內回來 → 自動找回
    saved = page.evaluate("JSON.stringify(window.__world.people)")
    page.evaluate("window.__world.people = []")
    wait_phase(page, "lost", 2000)
    until(lambda: stack.mock.w.rc == (0, 0, 0, 0), msg=f"模擬器 rc {stack.mock.w.rc}")
    page.evaluate(f"window.__world.people = JSON.parse({saved!r}); window.__world.people.forEach(p => p.feat = window.__world[p.feat[2] ? 'red' : 'blue'])")
    wait_phase(page, "follow", 3000)
    assert st(page)["target"] == first
    assert "重新找到目標" in page.locator("#toasts").inner_text()

    # ---- 手勢 T 字 → 暫停（懸停）；再一次 → 恢復
    page.evaluate("window.__world.people[0].arms = { l: 'out', r: 'out' }")
    wait_phase(page, "paused", 3000)
    page.evaluate("window.__world.people[0].arms = {}")
    until(lambda: stack.mock.w.rc == (0, 0, 0, 0), msg=f"模擬器 rc {stack.mock.w.rc}")
    page.wait_for_timeout(500)
    page.evaluate("window.__world.people[0].arms = { l: 'out', r: 'out' }")
    wait_phase(page, "follow", 3000)
    page.evaluate("window.__world.people[0].arms = {}")

    SHOTS.mkdir(exist_ok=True)
    page.screenshot(path=str(SHOTS / "follow-1280x720.png"))

    # ---- 降落：B 照樣有效；落地後不再送跟隨指令
    press(page, B)
    wait_cmd(stack, "land")
    page.wait_for_function("window.__gcs.S.tel.flying === false", timeout=8000)
    wait_phase(page, "ready", 3000)
    assert errors == []
    page.context.close()


def test_follow_target_lost_for_good_needs_manual_pick(browser, stack):
    page, errors = follow_page(browser)
    page.evaluate("window.__world.people[0].bearing = 0")
    page.keyboard.press("g")                      # 鍵盤 G 也能開
    wait_phase(page, "ready")
    press(page, A)
    page.wait_for_function("window.__gcs.S.tel.flying === true", timeout=6000)
    wait_phase(page, "follow")
    page.evaluate("window.__world.people = []")
    page.wait_for_function("window.__gcs.follow.status().target === null", timeout=6000)
    assert "目標遺失超過 3 秒" in page.locator("#toasts").inner_text()
    # 人回來了，但不會自動跟（避免跟錯人）→ 停在「請選擇」，懸停
    page.evaluate("window.__world.people = [{ bearing: window.__gcs.S.tel.yaw, t: 0.19, arms: {}, feat: window.__world.red }]")
    page.wait_for_timeout(1200)
    assert page.evaluate("window.__gcs.follow.phase") == "select"
    assert stack.mock.w.rc == (0, 0, 0, 0)
    page.keyboard.press("n")
    wait_phase(page, "follow", 3000)
    # 關閉跟隨 → 回到純手動
    press(page, MENU)
    wait_phase(page, "off", 2000)
    assert page.locator("#followOverlay").is_hidden()
    assert errors == []
    page.context.close()


# 有幾何關係的世界：人站在 dist 公尺外（肩 1.45 m、髖 0.95 m），無人機往前飛 dist 會變小；
# 人在畫面中的位置由無人機高度（模擬器回報的 h）決定。伸出的手在身體前方 0.55 m。
GEO_WORLD = """
async () => {
  const { person, hand } = await import('/static/__test/synthetic.mjs');
  const { describePerson } = await import('/static/js/follow/geometry.js');
  const W = window.__pw = { dist: 2.2, arms: {}, open: true, last: performance.now(), lms: null };
  const view = () => {
    const now = performance.now(), dt = Math.min(0.2, (now - W.last) / 1000); W.last = now;
    const rc = window.__gcs.S.rc || [0, 0, 0, 0];
    W.dist = Math.max(0.3, W.dist - (rc[1] / 100) * dt);
    const h = (window.__gcs.S.tel && window.__gcs.S.tel.h) || 0;
    const k = 1 / (W.dist * 1.055);
    return { t: 0.5 * k, cy: 0.5 + (h / 100 - 1.2) * k, h };
  };
  window.__gcs.follow.fake = () => {
    const v = view();
    W.lms = person({ cx: 0.5, cy: v.cy, t: v.t, arms: W.arms });
    const d = describePerson(W.lms, 4 / 3);
    return d ? [d] : [];
  };
  window.__gcs.follow.fakeHands = () => {
    if (!W.lms || W.arms.r !== 'forward') return [];
    const w = W.lms[16];
    return [hand({ x: w.x, y: w.y, dist: Math.max(0.15, W.dist - 0.55), open: W.open })];
  };
}
"""


def geo_page(browser):
    page, errors = open_page(browser)
    page.route("**/static/__test/synthetic.mjs",
               lambda r: r.fulfill(status=200, content_type="text/javascript", body=SYN))
    page.evaluate(GEO_WORLD)
    press(page, MENU)
    wait_phase(page, "ready")
    press(page, A)
    page.wait_for_function("window.__gcs.S.tel.flying === true", timeout=6000)
    wait_phase(page, "follow")
    return page, errors


def frame_edges(page):
    """目前畫面中：舉手時手腕的位置（上緣）、髖部（下緣）"""
    return page.evaluate("""() => {
      const L = window.__pw.lms, sh = (L[11].y + L[12].y) / 2, hip = (L[23].y + L[24].y) / 2;
      return { top: sh - 1.45 * (hip - sh), hip };
    }""")


def test_follow_height_keeps_arms_in_frame(browser, stack):
    page, errors = geo_page(browser)
    # 想升到 300 cm：只會升到髖部還在畫面內的高度
    page.evaluate("window.__gcs.follow.sp = { dist: window.__gcs.follow.sp.dist, height: 300 }")
    page.wait_for_function("window.__gcs.follow.why.includes('frame-high')", timeout=3000)
    page.wait_for_timeout(5000)
    e = frame_edges(page)
    assert e["hip"] <= 0.97, e
    assert stack.mock.w.h < 280
    # 想降到 60 cm：只會降到舉起的手還在畫面內的高度
    page.evaluate("window.__gcs.follow.sp = { dist: window.__gcs.follow.sp.dist, height: 60 }")
    page.wait_for_function("window.__gcs.follow.why.includes('frame-low')", timeout=3000)
    page.wait_for_timeout(6000)
    e = frame_edges(page)
    assert e["top"] >= 0.03, e
    assert stack.mock.w.h > 80
    assert errors == []


def test_palm_landing(browser, stack):
    page, errors = geo_page(browser)
    # 手臂向前伸、手掌張開 → 停到手上
    page.evaluate("window.__pw.arms = { r: 'forward' }")
    wait_phase(page, "palm-approach", 4000)
    assert "停到手上" in page.locator("#toasts").inner_text()
    wait_phase(page, "palm-hold", 20000)
    hand_d = page.evaluate("window.__pw.dist - 0.55")
    assert 0.35 <= hand_d <= 0.65, hand_d
    assert stack.mock.w.h > 125, f"懸停高度 {stack.mock.w.h} 應該比手（125 cm）高"
    assert "land" not in stack.mock.commands()
    SHOTS.mkdir(exist_ok=True)
    page.screenshot(path=str(SHOTS / "palm-hold-1280x720.png"))
    # 手掌移到機身正下方 → ToF 變短 → 送 land → 落在手上、螺旋槳停止
    page.wait_for_timeout(1000)
    h = stack.mock.w.h
    stack.call(lambda: setattr(stack.mock.w, "below", h - 15))
    wait_cmd(stack, "land", timeout=3)
    page.wait_for_function("window.__gcs.S.tel.flying === false", timeout=10000)
    page.wait_for_function("document.querySelector('#toasts').textContent.includes('已停在手上')", timeout=3000)
    until(lambda: not stack.mock.w.motors, 6.0, "模擬器的馬達應該停止")
    assert errors == []


def test_palm_landing_cancel_by_stick(browser, stack):
    page, errors = geo_page(browser)
    page.evaluate("window.__pw.arms = { r: 'forward' }")
    wait_phase(page, "palm-approach", 4000)
    page.evaluate("window.__pw.arms = {}")
    page.evaluate("window.__axes([0, 0, 0, 0.6])")              # 拉右搖桿（後退）
    page.wait_for_function("document.querySelector('#toasts').textContent.includes('已取消停到手上')", timeout=3000)
    page.evaluate("window.__axes([0, 0, 0, 0])")
    wait_phase(page, "follow", 4000)
    assert page.evaluate("window.__gcs.follow.palm.phase") == "idle"
    assert "land" not in stack.mock.commands()
    # 握拳向前伸不會觸發
    page.evaluate("window.__pw.open = false; window.__pw.arms = { r: 'forward' }")
    page.wait_for_timeout(2000)
    assert page.evaluate("window.__gcs.follow.phase") == "follow"
    assert errors == []


def test_real_hand_model_loads(browser, stack):
    """手部模型（hand_landmarker.task）能在瀏覽器裡用專案內的檔案載入並執行。"""
    page, errors = open_page(browser)
    r = page.evaluate("""async () => {
      const { HandDetector } = await import('/static/js/follow/hand.js');
      const d = new HandDetector();
      const delegate = await d.load();
      const c = document.createElement('canvas'); c.width = 960; c.height = 720;
      const g = c.getContext('2d'); g.fillStyle = '#556'; g.fillRect(0, 0, 960, 720);
      const hands = d.detect(c);
      return { delegate, n: hands.length, ms: d.ms };
    }""")
    assert r["delegate"] in ("GPU", "CPU")
    assert r["n"] == 0                       # 空白畫面不會偵測到手
    assert errors == []


def _pose_jpg():
    cache = ROOT / ".pytest_cache" / "pose.jpg"
    if not cache.exists():
        try:
            cache.parent.mkdir(exist_ok=True)
            data = urllib.request.urlopen("https://storage.googleapis.com/mediapipe-assets/pose.jpg", timeout=10).read()
            cache.write_bytes(data)
        except OSError as e:
            pytest.skip(f"無法下載測試照片（離線？）：{e}")
    return cache.read_bytes()


def test_real_model_detects_two_people(browser, stack):
    img = _pose_jpg()
    page, errors = open_page(browser)
    page.route("**/__test/pose.jpg", lambda r: r.fulfill(status=200, content_type="image/jpeg", body=img))
    r = page.evaluate("""async () => {
      const { PoseDetector } = await import('/static/js/follow/pose.js');
      const { classifyPose } = await import('/static/js/follow/gestures.js');
      const d = new PoseDetector();
      const delegate = await d.load();
      const img = new Image(); img.src = '/__test/pose.jpg'; await img.decode();
      const res = {};
      for (const n of [1, 2]) {
        const c = document.createElement('canvas'); c.width = 960; c.height = 720;
        const g = c.getContext('2d'); g.fillStyle = '#333'; g.fillRect(0, 0, 960, 720);
        const w = 960 / n, s = Math.min(w / img.width, 720 / img.height);
        for (let i = 0; i < n; i++) g.drawImage(img, i * w + (w - img.width * s) / 2, (720 - img.height * s) / 2, img.width * s, img.height * s);
        let ppl = [];
        for (let k = 0; k < 3; k++) ppl = d.detect(c);
        res[n] = ppl.map((p) => ({ cx: p.cx, dist: p.dist, g: classifyPose(p.lms, 4 / 3), feat: !!p.feat,
                                  leftOnRight: p.lms[11].x > p.lms[12].x })).sort((a, b) => a.cx - b.cx);
      }
      return { delegate, res };
    }""")
    one, two = r["res"]["1"], r["res"]["2"]
    assert len(one) == 1 and abs(one[0]["cx"] - 0.5) < 0.05
    assert one[0]["leftOnRight"]                 # 面向鏡頭：人的左肩在畫面右邊（手勢左右的依據）
    assert one[0]["g"] == "pause"                # 範例圖是雙手側平舉
    assert one[0]["feat"] and 1.5 < one[0]["dist"] < 4
    assert len(two) == 2 and two[0]["cx"] < 0.4 < 0.6 < two[1]["cx"]
    assert errors == []
    page.context.close()
