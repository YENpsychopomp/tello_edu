// 跟隨模式新增功能的純邏輯測試：手臂可見高度限制、0.5 m 靠近、「停到手上」。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FRAME, LIMITS, applyGesture, armWindow, clampSetpoint, followRc, framedHeight } from '../../web/js/follow/control.js';
import { CAM_VSPAN, describePerson } from '../../web/js/follow/geometry.js';
import { GestureLatch, classifyPose } from '../../web/js/follow/gestures.js';
import { PALM, PalmLander, armForward, detectPalm, downToBody, extendedFingers, handDistance, handInfo, isOpenHand, pickDownHand } from '../../web/js/follow/palm.js';
import { ASPECT, hand, person } from './synthetic.mjs';

// 一個簡單的針孔相機世界：人站在 dist 公尺外，肩膀 1.45 m、髖部 0.95 m；無人機高度 h（cm），鏡頭水平。
function viewPerson({ dist, h, arms = {} }) {
  const k = 1 / (dist * CAM_VSPAN);                 // 1 m → 影像高
  const t = 0.5 * k;
  const cy = 0.5 + (h / 100 - 1.2) * k;             // 軀幹中心 1.2 m
  return describePerson(person({ cx: 0.5, cy, t, arms }), ASPECT);
}

// ------------------------------------------------------------------ 靠近到 0.5 m
test('距離可以設定到 0.5 m；太近的強制後退門檻降到 0.4 m', () => {
  assert.equal(LIMITS.distRange[0], 0.5);
  let sp = clampSetpoint({ dist: 1.5, height: 120 });
  sp = applyGesture(sp, 'closer'); assert.equal(sp.dist, 1.0);
  sp = applyGesture(sp, 'closer'); assert.equal(sp.dist, 0.5);
  sp = applyGesture(sp, 'closer'); assert.equal(sp.dist, 0.5);
  // 0.6 m、設定 0.5 m：還可以慢慢前進，但速度受近距離上限限制
  const r = followRc({ cx: 0.5, dist: 1.4, distMin: 1.4 }, { dist: 0.5, height: 120 }, 120);
  assert.ok(r.raw[1] > 0 && r.raw[1] <= LIMITS.fwdNear);
  assert.ok(followRc({ cx: 0.5, dist: 0.35, distMin: 0.35 }, { dist: 0.5, height: 120 }, 120).raw[1] < 0);
});

// ------------------------------------------------------------------ 手臂可見的高度範圍
test('armWindow：太低 → 舉起的手出畫面上緣；太高 → 髖部出畫面下緣', () => {
  const tgt = viewPerson({ dist: 3, h: 120 });
  const w = armWindow(tgt, 120);
  assert.ok(w.fits && w.lo < 120 && w.hi > 120, JSON.stringify(w));
  // 驗證邊界：在 lo 高度時，舉手的手腕剛好在上緣 margin；在 hi 高度時，髖部剛好在下緣 margin
  const atLo = viewPerson({ dist: 3, h: w.lo, arms: { r: 'up' } });
  const shY = (atLo.lms[11].y + atLo.lms[12].y) / 2;
  assert.ok(Math.abs(shY - FRAME.reach * atLo.torso - FRAME.margin) < 0.01);
  const atHi = viewPerson({ dist: 3, h: w.hi });
  const hipY = (atHi.lms[23].y + atHi.lms[24].y) / 2;
  assert.ok(Math.abs(hipY - (1 - FRAME.margin)) < 0.01, `hipY=${hipY}`);
});

test('高度設定超出範圍時，控制器只會飛到手臂還看得見的高度', () => {
  const tgt = viewPerson({ dist: 3, h: 120 });
  const w = armWindow(tgt, 120);
  const rLow = followRc(tgt, { dist: 3, height: 60 }, 120);       // 想降到 60 cm
  assert.ok(rLow.why.includes('frame-low') && Math.abs(rLow.hTarget - w.lo) < 1);
  const rHigh = followRc(tgt, { dist: 3, height: 300 }, 120);     // 想升到 300 cm
  assert.ok(rHigh.why.includes('frame-high') && Math.abs(rHigh.hTarget - w.hi) < 1);
  const ok = followRc(tgt, { dist: 3, height: 130 }, 120);
  assert.equal(ok.hTarget, 130);
  assert.ok(!ok.why.some((x) => x.startsWith('frame')));
});

test('距離太近、手臂和軀幹放不下時：保住軀幹（還能估距離），舉起的手可能被切掉', () => {
  const tgt = viewPerson({ dist: 0.8, h: 150 });
  const w = armWindow(tgt, 150);
  assert.equal(w.fits, false);
  const r = followRc(tgt, { dist: 0.8, height: 150 }, 150);
  assert.ok(r.why.includes('arms-cut'));
  assert.ok(Math.abs(r.hTarget - w.hi) < 1);
  assert.deepEqual(framedHeight(100, null), { h: 100, why: null });
});

test('看不到髖部時用肩寬換算軀幹長；資料不足就不限制', () => {
  const p = describePerson(person({ t: 0.2, hips: false }), ASPECT);
  assert.ok(armWindow(p, 120));
  assert.equal(armWindow(null, 120), null);
  assert.equal(armWindow(viewPerson({ dist: 3, h: 120 }), null), null);
});

// ------------------------------------------------------------------ 手掌張開／距離
test('手掌張開：四指伸直才算；握拳不算', () => {
  assert.equal(extendedFingers(hand({ open: true }).world), 4);
  assert.ok(isOpenHand(hand({ open: true })));
  assert.ok(extendedFingers(hand({ open: false }).world) <= 1);
  assert.ok(!isOpenHand(hand({ open: false })));
});

test('由手的實際大小估距離', () => {
  for (const d of [0.4, 0.8, 1.5]) {
    const est = handDistance(hand({ dist: d }), ASPECT);
    assert.ok(Math.abs(est - d) / d < 0.03, `d=${d} est=${est}`);
  }
});

// ------------------------------------------------------------------ 手勢「停到手上」
test('手臂向前伸＋手掌張開 → palm；其他姿勢不會誤判', () => {
  const p = person({ t: 0.25, arms: { r: 'forward' } });
  assert.ok(armForward(p, 'r', ASPECT));
  assert.ok(!armForward(p, 'l', ASPECT));
  assert.equal(classifyPose(p, ASPECT), null);                   // 不會被當成其他手勢
  const w = p[16];
  const open = hand({ x: w.x, y: w.y, dist: 1.0 });
  const fist = hand({ x: w.x, y: w.y, dist: 1.0, open: false });
  assert.deepEqual(detectPalm(p, [open], ASPECT)?.side, 'r');
  assert.equal(detectPalm(p, [fist], ASPECT), null);             // 握拳不算
  assert.equal(detectPalm(p, [hand({ x: 0.1, y: 0.1 })], ASPECT), null);   // 手不在那隻手腕旁邊
  for (const arms of [{}, { r: 'up' }, { l: 'cross', r: 'cross' }, { l: 'out', r: 'out' }]) {
    const q = person({ t: 0.25, arms });
    const hs = [15, 16].map((i) => hand({ x: q[i].x, y: q[i].y }));
    assert.equal(detectPalm(q, hs, ASPECT), null, JSON.stringify(arms));
  }
});

test('palm 手勢不會重複觸發（要放下再做一次）', () => {
  const L = new GestureLatch();
  const fired = [];
  for (let t = 0; t <= 4000; t += 80) { const g = L.feed('palm', t); if (g) fired.push(t); }
  assert.equal(fired.length, 1);
});

// ------------------------------------------------------------------ 下視鏡頭
test('下視鏡頭畫面 → 機身方向：四種機頭方向＋鏡像', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const chk = (r, fwd, right) => assert.ok(near(r.fwd, fwd) && near(r.right, right), JSON.stringify(r));
  // 手在畫面上方偏右（x 0.6、y 0.3）
  chk(downToBody(0.6, 0.3, { edge: 'up' }), 0.2, 0.1);
  chk(downToBody(0.6, 0.3, {}), 0.2, 0.1);                       // 預設：畫面上方是機頭
  chk(downToBody(0.6, 0.3, { edge: 'down' }), -0.2, -0.1);
  chk(downToBody(0.6, 0.3, { edge: 'right' }), 0.1, -0.2);
  chk(downToBody(0.6, 0.3, { edge: 'left' }), -0.1, 0.2);
  chk(downToBody(0.6, 0.3, { edge: 'up', mirror: true }), 0.2, -0.1);
});

test('下視鏡頭有兩隻手時取最大（最近）的那隻', () => {
  const small = hand({ x: 0.2, y: 0.2, dist: 1.0 });
  const big = hand({ x: 0.55, y: 0.45, dist: 0.35 });
  const p = pickDownHand([small, big], ASPECT);
  assert.ok(Math.abs(p.x - handCenter(big).x) < 1e-9);
  assert.equal(pickDownHand([], ASPECT), null);
});

function handCenter(h) {
  const pts = [0, 5, 9, 13, 17].map((i) => h.lms[i]);
  return { x: pts.reduce((s, q) => s + q.x, 0) / 5, y: pts.reduce((s, q) => s + q.y, 0) / 5 };
}

// ------------------------------------------------------------------ 停到手上的狀態機（模擬世界）
// 無人機在 (x 前, y 右, z 高)（m）；手掌在 (hx, hy, hz)。前鏡頭水平；下視鏡頭視角約 ±31°（高度 h 時看得到 ±0.6h）。
// ToF：手掌（約 16 cm 寬）在機身正下方時量到手，否則量到地面。rc 100 ≈ 1 m/s。
function runLander({ cam = true, hy = 0.07, hz = 1.1, z = 1.5, startDist = 1.6, onSwitch = null, onAlign = null, maxMs = 60000 } = {}) {
  const P = new PalmLander();
  const W = { x: 0, y: 0, z, hx: startDist, hy, hz };
  let now = 0;
  const log = [];
  let switchAt = null;
  P.start(now);
  for (; now < maxMs;) {
    now += 33;
    const fwd = W.hx - W.x, side = W.hy - W.y, above = W.z - W.hz;
    // 前鏡頭（只在 approach 用）
    let front = null;
    if (P.phase === 'approach' && fwd > 0.1) {
      const k = 1 / (fwd * CAM_VSPAN);
      front = handInfo(hand({ x: 0.5 + (side * k) / ASPECT, y: 0.5 + above * k, dist: fwd }), ASPECT);
    }
    // 下視鏡頭
    let down = null;
    if (P.wantsDown && P.mode === 'cam' && above > 0.05) {
      const span = above * 0.6;
      const ix = 0.5 + side / (2 * span * ASPECT), iy = 0.5 - fwd / (2 * span);
      if (ix > 0 && ix < 1 && iy > 0 && iy < 1) down = downToBody(ix, iy, {});
    }
    const overHand = Math.abs(fwd) < 0.08 && Math.abs(side) < 0.08;
    const tof = Math.round((overHand ? above : W.z) * 100);
    if (P.phase === 'switch' && switchAt === null) {
      switchAt = now;
      if (onSwitch) onSwitch(W);
    }
    if (switchAt !== null && P.phase === 'switch' && now - switchAt >= 300) P.camResult(cam, now);
    if (P.phase === 'align' && onAlign) { onAlign(W); onAlign = null; }
    const r = P.update({ now, hand: front, down, tof, h: Math.round(W.z * 100), speed: null, flying: true });
    const dt = 0.033;
    const sp = Math.hypot(r.rc[0], r.rc[1]) / 100;
    W.x += (r.rc[1] / 100) * dt; W.y += (r.rc[0] / 100) * dt; W.z += (r.rc[2] / 100) * dt;
    log.push({ now, phase: P.phase, rc: r.rc, land: r.land, fwd, side, above, tof, sp });
    if (r.land || P.phase === 'abort') break;
  }
  return { P, W, log };
}

test('停到手上（下視鏡頭）：飛近 → 切鏡頭 → 爬升 → 往前 → 下視細微校準 → 對準在手上方約 35 cm 才降落', () => {
  const { P, W, log } = runLander();
  const phases = [...new Set(log.map((x) => x.phase))];
  assert.deepEqual(phases, ['approach', 'switch', 'climb', 'seek', 'align', 'landing'], phases.join(','));
  const sw = log.find((x) => x.phase === 'switch');
  assert.ok(sw.fwd <= PALM.holdDist + 0.02 && sw.fwd >= PALM.retreatDist, `切鏡頭時離手 ${sw.fwd}`);
  const last = log[log.length - 1];
  assert.ok(last.land, '要送 land');
  assert.equal(P.phase, 'landing');
  assert.equal(P.mode, 'cam');
  // 降落時：在手的正上方（前後左右誤差 < 5 cm）、高度在手上方 clearance ± 15 cm
  assert.ok(Math.abs(W.hx - W.x) < 0.05 && Math.abs(W.hy - W.y) < 0.05, `誤差 前 ${W.hx - W.x} 右 ${W.hy - W.y}`);
  assert.ok(Math.abs((W.z - W.hz) * 100 - PALM.clearance) <= 15, `高度差 ${(W.z - W.hz) * 100}`);
  // 下視校準有用到左右（roll），而且是細微的
  const align = log.filter((x) => x.phase === 'align');
  assert.ok(align.some((x) => x.rc[0] !== 0), '要有左右修正');
  assert.ok(align.every((x) => Math.abs(x.rc[0]) <= PALM.downMax && Math.abs(x.rc[1]) <= PALM.downMax));
  // 往前找手時，機身比手高（不會撞到手）
  const seek = log.filter((x) => x.phase === 'seek');
  assert.ok(seek.length && seek.every((x) => x.above > 0.2), '往前時要在手上方');
  assert.ok(log.every((x) => x.rc[1] <= PALM.fwdMax));
});

test('停到手上（韌體不支援下視鏡頭）：只用 ToF，往前直到手在正下方 → 停一下 → 降落', () => {
  const { P, W, log } = runLander({ cam: false, hy: 0 });
  const phases = [...new Set(log.map((x) => x.phase))];
  assert.deepEqual(phases, ['approach', 'switch', 'climb', 'seek', 'settle', 'landing'], phases.join(','));
  assert.equal(P.mode, 'tof');
  assert.ok(log[log.length - 1].land);
  assert.ok(Math.abs(W.hx - W.x) < 0.12, `前後誤差 ${W.hx - W.x}`);
});

test('停到手上：切鏡頭後手收回 → 往前有距離上限（依速度遙測）→ 取消，不會一直往前飛', () => {
  // 有速度遙測：最多走到「手的估計距離＋35 cm」
  const P = new PalmLander();
  P.start(0);
  P.phase = 'seek'; P.phaseAt = 0; P.mode = 'cam'; P.est = { d: 0.5, dz: 0.1 };
  let travel = 0, now = 0, r;
  for (; now < 20000 && P.phase === 'seek'; now += 33) {
    r = P.update({ now, down: null, tof: 150, speed: 0.3 });
    travel += 0.3 * 0.033;
  }
  assert.equal(P.phase, 'abort');
  assert.ok(P.reason.includes('沒有找到手掌'), P.reason);
  assert.ok(travel <= 0.5 + PALM.travelExtra + 0.05, `走了 ${travel}`);
  // 沒有速度遙測：時間上限
  const { P: Q, log } = runLander({ onSwitch: (W) => { W.hx += 3; } });
  assert.equal(Q.phase, 'abort');
  const seek = log.filter((x) => x.phase === 'seek');
  assert.ok(seek.length * 33 <= PALM.creepMaxMs + 100);
});

test('停到手上：對準途中下視鏡頭看不到手 → 取消', () => {
  const { P } = runLander({ onAlign: (W) => { W.hy += 5; } });
  assert.equal(P.phase, 'abort');
  assert.ok(P.reason.includes('下視鏡頭看不到'), P.reason);
});

test('停到手上：接近途中看不到手超過 1.5 秒 → 取消', () => {
  const L = new PalmLander();
  L.start(0);
  for (let t = 0; t < 3000 && L.phase === 'approach'; t += 33) L.update({ now: t, hand: null, tof: 150 });
  assert.equal(L.phase, 'abort');
  assert.ok(L.reason.includes('看不到'));
});

test('ToF：緩慢的高度變化不算手；突然變短 25 cm 以上（連續 3 筆）才算手在正下方', () => {
  const L = new PalmLander();
  L.start(0);
  for (let t = 0; t < 8000; t += 100) {
    L._tofUpdate(t, 120 + 30 * Math.sin(t / 1500));
    assert.equal(L.under, false, `t=${t}`);
  }
  L._tofUpdate(8100, 60); L._tofUpdate(8200, 58);
  assert.equal(L.under, false);
  L._tofUpdate(8300, 59);
  assert.equal(L.under, true);
  // 手拿開 → 恢復
  for (let t = 8400; t < 8800; t += 100) L._tofUpdate(t, 125);
  assert.equal(L.under, false);
});

test('停到手上：太近（肩寬顯示 < 0.35 m）一律後退', () => {
  const L = new PalmLander();
  L.start(0);
  const r = L.update({ now: 33, hand: { x: 0.5, y: 0.66, dist: 0.5 }, distMin: 0.3, tof: 100 });
  assert.ok(r.rc[1] < 0);
});

test('停到手上：切鏡頭逾時 → 改用 ToF', () => {
  const L = new PalmLander();
  L.start(0);
  L.phase = 'switch'; L.phaseAt = 0;
  L.update({ now: PALM.switchTimeoutMs + 50, tof: 150 });
  assert.equal(L.mode, 'tof');
  assert.equal(L.phase, 'climb');
  assert.equal(L.wantsDown, false);
});
