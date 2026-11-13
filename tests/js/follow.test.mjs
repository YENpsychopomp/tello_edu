// 跟隨模式的純邏輯單元測試（node --test tests/js）。pytest 會透過 tests/unit/test_js.py 一起跑。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LIMITS, applyGesture, clampSetpoint, followRc, slew } from '../../web/js/follow/control.js';
import { describePerson, iou } from '../../web/js/follow/geometry.js';
import { GestureLatch, classifyPose } from '../../web/js/follow/gestures.js';
import { Tracker, featSim } from '../../web/js/follow/tracker.js';
import { ASPECT, person } from './synthetic.mjs';

// ------------------------------------------------------------------ geometry
test('距離估計：軀幹越小越遠，2.5 m 左右約 0.19 個影像高', () => {
  const near = describePerson(person({ t: 0.3 }), ASPECT);
  const far = describePerson(person({ t: 0.12 }), ASPECT);
  assert.ok(near.dist < far.dist);
  const d = describePerson(person({ t: 0.19 }), ASPECT).dist;
  assert.ok(d > 2.2 && d < 2.8, `dist=${d}`);
});

test('看不到肩膀 → 不算人；看不到髖部 → 沒有距離，但仍有「至少多近」', () => {
  const p = person();
  p[11].visibility = 0.1;
  assert.equal(describePerson(p, ASPECT), null);
  const q = describePerson(person({ hips: false }), ASPECT);
  assert.equal(q.dist, null);
  assert.ok(Number.isFinite(q.distMin));
});

test('iou', () => {
  assert.equal(iou({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 0, y0: 0, x1: 1, y1: 1 }), 1);
  assert.equal(iou({ x0: 0, y0: 0, x1: 0.2, y1: 0.2 }, { x0: 0.5, y0: 0.5, x1: 1, y1: 1 }), 0);
});

// ------------------------------------------------------------------ gestures
test('手勢分類：五種手勢＋放下', () => {
  const c = (arms, extra = {}) => classifyPose(person({ arms, ...extra }), ASPECT);
  assert.equal(c({}), null);
  assert.equal(c({ r: 'up' }), 'up');
  assert.equal(c({ l: 'up' }), 'down');
  assert.equal(c({ l: 'up', r: 'up' }), 'farther');
  assert.equal(c({ l: 'cross', r: 'cross' }), 'closer');
  assert.equal(c({ l: 'out', r: 'out' }), 'pause');
  // 單手側舉不是任何手勢（避免指路、揮手時誤觸發）
  assert.equal(c({ l: 'out' }), null);
  // 遠一點、偏一邊也一樣
  assert.equal(c({ r: 'up' }, { cx: 0.2, t: 0.1 }), 'up');
});

test('手勢要維持 0.6 秒以上才觸發；維持不放會重複；暫停不重複', () => {
  const L = new GestureLatch({ holdMs: 600, repeatMs: 1000, minFrames: 4 });
  const fired = [];
  for (let t = 0; t <= 2500; t += 80) { const g = L.feed('up', t); if (g) fired.push([g, t]); }
  assert.equal(fired[0][0], 'up');
  assert.ok(fired[0][1] >= 600 && fired[0][1] < 700);
  assert.equal(fired.length, 2);                           // 640ms、1680ms 左右各一次
  L.reset();
  const p = [];
  for (let t = 0; t <= 3000; t += 80) { const g = L.feed('pause', t); if (g) p.push(t); }
  assert.equal(p.length, 1);
});

test('手勢：短暫揮過（< 0.6 秒）不觸發；偶爾一幀判斷失敗不會重來', () => {
  const L = new GestureLatch();
  let n = 0;
  for (let t = 0; t < 400; t += 80) if (L.feed('farther', t)) n++;
  for (let t = 400; t < 1200; t += 80) if (L.feed(null, t)) n++;
  assert.equal(n, 0);
  L.reset();
  const seq = ['up', 'up', 'up', null, 'up', 'up', 'up', 'up', 'up'];
  const hit = seq.map((g, i) => L.feed(g, i * 80)).filter(Boolean);
  assert.deepEqual(hit, ['up']);
});

// ------------------------------------------------------------------ tracker
const det = (cx, t = 0.2, feat = null) => ({ ...describePerson(person({ cx, t }), ASPECT), feat });

test('多人追蹤：編號穩定、依左右排序、可以切換目標', () => {
  const tr = new Tracker();
  let now = 0;
  for (let i = 0; i < 5; i++) { now += 80; tr.update([det(0.3 + i * 0.01), det(0.7 - i * 0.01)], now); }
  const vis = tr.visible(now);
  assert.equal(vis.length, 2);
  const [left, right] = vis.map((t) => t.id);
  assert.notEqual(left, right);
  assert.equal(tr.cycle(1, now), left);
  assert.equal(tr.cycle(1, now), right);
  assert.equal(tr.cycle(1, now), left);
  assert.equal(tr.cycle(-1, now), right);
  // 兩人位置互換順序輸入，編號不變
  now += 80;
  tr.update([det(0.66), det(0.35)], now);
  assert.deepEqual(tr.visible(now).map((t) => t.id), [left, right]);
});

test('目標短暫消失（< 3 秒）回到附近會自動找回；超過 3 秒就放掉', () => {
  const tr = new Tracker();
  let now = 0;
  for (let i = 0; i < 4; i++) { now += 80; tr.update([det(0.5)], now); }
  const id = tr.cycle(1, now);
  now += 1500; tr.update([], now);
  assert.equal(tr.targetId, id);
  now += 80; tr.update([det(0.55)], now);
  assert.equal(tr.targetId, id);
  assert.equal(tr.target.reacquired, now);
  for (let i = 0; i < 50; i++) { now += 80; tr.update([], now); }
  assert.equal(tr.targetId, null);
});

test('衣服顏色明顯不同的人不會被當成遺失的目標', () => {
  const red = new Array(24).fill(0); red[2] = 1;
  const blue = new Array(24).fill(0); blue[14] = 1;
  assert.equal(featSim(red, red), 1);
  assert.equal(featSim(red, blue), 0);
  const tr = new Tracker();
  let now = 0;
  for (let i = 0; i < 4; i++) { now += 80; tr.update([det(0.5, 0.2, red)], now); }
  const id = tr.cycle(1, now);
  now += 500; tr.update([], now);
  now += 80; tr.update([det(0.52, 0.2, blue)], now);
  assert.equal(tr.targetId, id);
  assert.notEqual(tr.target.seen, now);                    // 目標仍是遺失狀態
  assert.equal(tr.visible(now).filter((t) => t.id === id).length, 0);
});

// ------------------------------------------------------------------ control
test('控制器：目標在右邊 → 向右轉；太遠 → 前進；太近 → 後退；高度差 → 升降', () => {
  const sp = { dist: 3, height: 150 };
  const r1 = followRc({ cx: 0.8, dist: 3, distMin: 3 }, sp, 150).raw;
  assert.ok(r1[3] > 0 && r1[3] <= LIMITS.yaw);
  assert.equal(r1[1], 0);
  assert.equal(r1[0], 0);
  assert.ok(followRc({ cx: 0.5, dist: 5, distMin: 5 }, sp, 150).raw[1] > 0);
  assert.ok(followRc({ cx: 0.5, dist: 2, distMin: 2 }, sp, 150).raw[1] < 0);
  assert.ok(followRc({ cx: 0.5, dist: 3, distMin: 3 }, sp, 100).raw[2] > 0);
  assert.ok(followRc({ cx: 0.5, dist: 3, distMin: 3 }, sp, 200).raw[2] < 0);
  // 死區內不動
  assert.deepEqual(followRc({ cx: 0.51, dist: 3.1, distMin: 3 }, sp, 153).raw, [0, 0, 0, 0]);
});

test('控制器安全：太近一律後退；看不到髖部不前進；輸出不超過上限', () => {
  const sp = { dist: 3, height: 150 };
  assert.ok(followRc({ cx: 0.5, dist: null, distMin: 0.3 }, sp, 150).raw[1] < 0);
  assert.ok(followRc({ cx: 0.5, dist: 4, distMin: 0.35 }, sp, 150).raw[1] < 0);  // 肩寬說太近就是太近
  // 0.8 m 已經不算太近（可設定到 0.5 m）
  const r = followRc({ cx: 0.5, dist: null, distMin: 5 }, sp, 150);
  assert.equal(r.raw[1], 0);
  assert.ok(r.why.includes('no-torso'));
  const big = followRc({ cx: 1, dist: 50, distMin: 50 }, sp, -500).raw;
  assert.ok(Math.abs(big[1]) <= LIMITS.fwd && Math.abs(big[2]) <= LIMITS.up && Math.abs(big[3]) <= LIMITS.yaw);
  assert.deepEqual(followRc(null, sp, 150).raw, [0, 0, 0, 0]);
});

test('變化量限制：加速受限、停下來不受限', () => {
  assert.deepEqual(slew([0, 0, 0, 0], [0, 35, -40, 50]), [0, 9, -9, 9]);
  assert.deepEqual(slew([0, 30, 0, 40], [0, 0, 0, 10]), [0, 0, 0, 10]);
  assert.deepEqual(slew([0, 30, 0, 0], [0, -30, 0, 0]), [0, 21, 0, 0]);   // 反向仍要限制
});

test('手勢調整設定值並夾在範圍內', () => {
  let sp = clampSetpoint({ dist: 3, height: 150 });
  sp = applyGesture(sp, 'up'); assert.equal(sp.height, 180);
  sp = applyGesture(sp, 'farther'); assert.equal(sp.dist, 3.5);
  for (let i = 0; i < 20; i++) sp = applyGesture(sp, 'closer');
  assert.equal(sp.dist, LIMITS.distRange[0]);
  for (let i = 0; i < 20; i++) sp = applyGesture(sp, 'down');
  assert.equal(sp.height, LIMITS.heightRange[0]);
  assert.deepEqual(applyGesture(sp, 'pause'), sp);
});

test('誤偵測過濾：鼻子在肩膀下面、框太小都不算人', () => {
  const p = person();
  p[0] = { ...p[0], y: p[11].y + 0.05 };
  assert.equal(describePerson(p, ASPECT), null);
  assert.equal(describePerson(person({ t: 0.02 }), ASPECT), null);
});
