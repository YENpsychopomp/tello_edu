// 跟隨的強健性：目標估計（離群值、預測、延遲補償）、自動搜尋狀態機。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EST, TargetEstimator } from '../../web/js/follow/estimator.js';
import { SEARCH, Searcher } from '../../web/js/follow/search.js';

const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------ estimator
test('估計：等速移動的目標 → 速度收斂、缺幀時預測位置接近真實', () => {
  const e = new TargetEstimator();
  let t = 0;
  for (let i = 0; i < 20; i++) { t = i * 80; e.feed({ cx: 0.3 + 0.2 * (t / 1000), cy: 0.5, dist: 2.5 }, t); }
  assert.ok(near(e.vx, 0.2, 0.04), `vx=${e.vx}`);
  // 接下來 400 ms 沒有量測：預測要跟著走（含延遲補償 120 ms）
  const p = e.predict(t + 400);
  const truth = 0.3 + 0.2 * ((t + 400 + EST.latencyMs) / 1000);
  assert.ok(p && p.predicted && near(p.cx, truth, 0.05), `pred=${p && p.cx} truth=${truth}`);
  assert.equal(e.predict(t + EST.predictMs + 1), null);         // 太久就放棄預測
  assert.ok(near(p.dist, 2.5, 0.05));
});

test('估計：單一幀跳很遠（花掉的畫面）先不採信；連續兩幀才相信', () => {
  const e = new TargetEstimator();
  for (let i = 0; i < 8; i++) e.feed({ cx: 0.5, cy: 0.5, dist: 2 }, i * 80);
  assert.equal(e.feed({ cx: 0.95, cy: 0.1, dist: 0.6 }, 8 * 80), false);
  assert.equal(e.rejected, 1);
  assert.ok(near(e.cx, 0.5, 0.02));
  const p = e.predict(8 * 80 + 10);
  assert.ok(p && near(p.cx, 0.5, 0.03));
  assert.equal(e.feed({ cx: 0.95, cy: 0.1, dist: 0.6 }, 9 * 80), true);  // 第二次：真的跳了
  assert.ok(near(e.cx, 0.95, 1e-9) && e.vx === 0);
  // 小抖動照常採信
  assert.equal(e.feed({ cx: 0.93, cy: 0.12, dist: 0.65 }, 10 * 80), true);
});

test('估計：間隔很久（影像凍結後恢復）→ 重新對齊、不會用舊速度亂推；shift 讓暫停不算遺失', () => {
  const e = new TargetEstimator();
  let t = 0;
  for (let i = 0; i < 10; i++) { t = i * 80; e.feed({ cx: 0.3 + 0.3 * (t / 1000), cy: 0.5, dist: 2 }, t); }
  assert.ok(e.vx > 0.2);
  e.feed({ cx: 0.4, cy: 0.5, dist: 2 }, t + 2000);
  assert.equal(e.vx, 0);
  assert.ok(near(e.cx, 0.4, 1e-9));
  const before = e.t;
  e.shift(1500);
  assert.equal(e.t, before + 1500);
  assert.ok(e.predict(before + 1500 + 100));
});

test('估計：離開畫面的方向（速度優先，否則看最後位置）', () => {
  const e = new TargetEstimator();
  for (let i = 0; i < 10; i++) e.feed({ cx: 0.6 - 0.3 * (i * 0.08), cy: 0.5, dist: 2 }, i * 80);
  assert.equal(e.exitSide(), -1);                               // 往左跑
  const f = new TargetEstimator();
  for (let i = 0; i < 5; i++) f.feed({ cx: 0.8, cy: 0.5, dist: 2 }, i * 80);
  assert.equal(f.exitSide(), 1);                                // 停在右邊
});

// ------------------------------------------------------------------ searcher
function runSearch(s, { yawRate = 36, side = 1, yaw0 = 10, until = (st) => st.stage === 'giveup', dt = 33, maxMs = 60000 } = {}) {
  let yaw = yaw0, now = 0;
  s.start(now, side, yaw);
  const log = [];
  while (now < maxMs) {
    now += dt;
    const r = s.update(now, yaw);
    log.push({ now, ...r, yaw });
    yaw = ((yaw + Math.sign(r.rc[3]) * (yawRate * (Math.abs(r.rc[3]) / SEARCH.yawRc)) * (dt / 1000) + 540) % 360) - 180;
    if (until(r)) break;
  }
  return { log, yaw, now };
}

test('搜尋：先懸停 → 往離開的那邊掃 75° → 回掃到另一邊 −75° → 轉一圈 → 放棄；只轉向不平移', () => {
  const s = new Searcher();
  const { log, now } = runSearch(s, { side: 1, yaw0: 170 });     // 從 170° 開始：跨越 ±180 的展開也要對
  const stages = [...new Set(log.map((x) => x.stage))];
  assert.deepEqual(stages, ['hold', 'sweep1', 'sweep2', 'spin', 'giveup']);
  const hold = log.filter((x) => x.stage === 'hold');
  assert.ok(hold.every((x) => x.rc.every((v) => v === 0)) && hold.length * 33 >= SEARCH.holdMs - 40);
  assert.ok(log.filter((x) => x.stage === 'sweep1').every((x) => x.rc[3] > 0 && x.rc[0] === 0 && x.rc[1] === 0 && x.rc[2] === 0));
  assert.ok(log.filter((x) => x.stage === 'sweep2').every((x) => x.rc[3] < 0));
  const endSweep1 = log.findLast((x) => x.stage === 'sweep1');
  assert.ok(endSweep1.rel >= SEARCH.sectorDeg - 3 && endSweep1.rel < SEARCH.sectorDeg + 8, `rel=${endSweep1.rel}`);
  const endSweep2 = log.findLast((x) => x.stage === 'sweep2');
  assert.ok(endSweep2.rel <= -SEARCH.sectorDeg + 3, `rel=${endSweep2.rel}`);
  assert.ok(now <= SEARCH.maxMs + 100);
  assert.ok(log.every((x) => Math.abs(x.rc[3]) <= SEARCH.yawRc));
  assert.equal(s.active, false);
});

test('搜尋：往左離開就先往左掃；沒有航向資料時用時間估；超過 20 秒一定放棄', () => {
  const s = new Searcher();
  const { log } = runSearch(s, { side: -1, until: (r) => r.stage === 'sweep2' });
  assert.ok(log.filter((x) => x.stage === 'sweep1').every((x) => x.rc[3] < 0));
  const n = new Searcher();
  n.start(0, 1, null);
  let last = null;
  for (let t = 33; t < 30000; t += 33) { last = n.update(t, null); if (last.stage === 'giveup') break; }
  assert.equal(last.stage, 'giveup');
  const slow = new Searcher();
  const r = runSearch(slow, { yawRate: 5 });                     // 轉得很慢：靠時間上限放棄
  assert.ok(r.now <= SEARCH.maxMs + 100 && r.log[r.log.length - 1].stage === 'giveup');
});

test('搜尋：reset 後不輸出；start 可重新開始', () => {
  const s = new Searcher();
  s.start(0, 1, 0);
  assert.equal(s.active, true);
  s.reset();
  assert.deepEqual(s.update(100, 0).rc, [0, 0, 0, 0]);
  s.start(200, -1, 30);
  assert.equal(s.stage, 'hold');
});

// ------------------------------------------------------------------ tracker：搜尋中的找回條件、holdTarget
import { Tracker } from '../../web/js/follow/tracker.js';
import { describePerson } from '../../web/js/follow/geometry.js';
import { followRc, LIMITS } from '../../web/js/follow/control.js';
import { ASPECT, person } from './synthetic.mjs';

const det = (cx, t = 0.2, feat = null) => ({ ...describePerson(person({ cx, t }), ASPECT), feat });
const red = new Array(24).fill(0); red[2] = 1;
const blue = new Array(24).fill(0); blue[14] = 1;

test('搜尋中：目標不會因為 3 秒沒看到而被移除；在任何位置只要顏色、大小對得上就找回；顏色不對不認', () => {
  const tr = new Tracker();
  let now = 0;
  for (let i = 0; i < 4; i++) { now += 80; tr.update([det(0.8, 0.2, red)], now); }
  const id = tr.cycle(1, now);
  tr.holdTarget = true; tr.searching = true;
  for (let i = 0; i < 80; i++) { now += 80; tr.update([], now); }       // 6.4 秒沒看到
  assert.equal(tr.targetId, id);
  now += 80; tr.update([det(0.15, 0.22, blue)], now);                   // 藍衣的人：不是他
  assert.notEqual(tr.target.seen, now);
  now += 80; tr.update([det(0.15, 0.22, red)], now);                    // 紅衣：位置差很多也認
  assert.equal(tr.target.seen, now);
  assert.equal(tr.target.hitsSince, 1);
  now += 80; tr.update([det(0.16, 0.22, red)], now);
  assert.equal(tr.target.hitsSince, 2);
  tr.dropTarget();
  assert.equal(tr.targetId, null);
  assert.ok(!tr.holdTarget && !tr.searching);
});

test('搜尋中沒有顏色特徵：畫面只有一個人才認；兩個人都不認', () => {
  const tr = new Tracker();
  let now = 0;
  for (let i = 0; i < 4; i++) { now += 80; tr.update([det(0.5)], now); }
  const id = tr.cycle(1, now);
  tr.holdTarget = true; tr.searching = true;
  now += 2000; tr.update([], now);
  now += 80; tr.update([det(0.2), det(0.7)], now);
  assert.notEqual(tr.target.seen, now);
  assert.equal(tr.targetId, id);
  now += 2000; tr.update([], now);
  now += 80; tr.update([det(0.3)], now);
  assert.equal(tr.target.seen, now);
});

test('控制器 PD：目標往右移動時提早轉（前饋）、機身轉向中目標往左滑時減速（阻尼）；低 fps 時增益縮小', () => {
  const sp = { dist: 3, height: 150 };
  const base = followRc({ cx: 0.6, dist: 3, distMin: 3 }, sp, 150).raw[3];
  const ff = followRc({ cx: 0.6, dist: 3, distMin: 3 }, sp, 150, { vx: 0.4 }).raw[3];
  const damp = followRc({ cx: 0.6, dist: 3, distMin: 3 }, sp, 150, { vx: -0.4 }).raw[3];
  assert.ok(ff > base && damp < base && damp > 0, `${damp} < ${base} < ${ff}`);
  assert.ok(Math.abs(followRc({ cx: 0.9, dist: 3, distMin: 3 }, sp, 150, { vx: 5 }).raw[3]) <= LIMITS.yaw);
  const slow = followRc({ cx: 0.7, dist: 5, distMin: 5 }, sp, 150, { gain: 0.5 }).raw;
  const fast = followRc({ cx: 0.7, dist: 5, distMin: 5 }, sp, 150).raw;
  assert.ok(slow[3] < fast[3] && slow[1] < fast[1] && slow[1] > 0);
  // 死區內、沒有速度 → 不動；死區內但目標正在橫移 → 先微轉
  assert.equal(followRc({ cx: 0.51, dist: 3, distMin: 3 }, sp, 150).raw[3], 0);
  assert.ok(followRc({ cx: 0.51, dist: 3, distMin: 3 }, sp, 150, { vx: 0.3 }).raw[3] > 0);
});
