// 跟隨模式新增功能的純邏輯測試：手臂可見高度限制、0.5 m 靠近、「停到手上」。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FRAME, LIMITS, applyGesture, armWindow, clampSetpoint, followRc, framedHeight } from '../../web/js/follow/control.js';
import { CAM_VSPAN, describePerson } from '../../web/js/follow/geometry.js';
import { GestureLatch, classifyPose } from '../../web/js/follow/gestures.js';
import { PALM, PalmLander, armForward, detectPalm, extendedFingers, handDistance, handInfo, isOpenHand } from '../../web/js/follow/palm.js';
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

// ------------------------------------------------------------------ 停到手上的狀態機
function runLander({ startDist = 1.6, handUnderAt = null, holdTimeout = false, loseHand = false } = {}) {
  const P = new PalmLander();
  let now = 0, dist = startDist, droneH = 150, tof = 160;
  const handH = 110;                                   // 手掌高度 cm
  const log = [];
  P.start(now);
  for (let i = 0; i < 2000; i++) {
    now += 33;
    // 世界：手在 dist 公尺外、高度 handH；無人機高度 droneH
    const k = 1 / (dist * CAM_VSPAN);
    const y = 0.5 + ((droneH - handH) / 100) * k;
    const handVisible = !loseHand && P.phase === 'approach';
    const h = handVisible ? handInfo(hand({ x: 0.5, y, dist }), ASPECT) : null;
    if (handUnderAt !== null && P.phase === 'hold' && now - P.holdAt > handUnderAt) tof = 30;
    const r = P.update({ now, hand: h, tof, flying: true, distMin: null });
    // 物理：rc → 移動（每 33 ms，rc 100 ≈ 1 m/s）
    dist = Math.max(0.2, dist - (r.rc[1] / 100) * 0.033);
    droneH += (r.rc[2] / 100) * 100 * 0.033;
    if (P.phase === 'hold') tof = tof === 30 ? 30 : droneH - 0 + 10;
    log.push({ now, phase: P.phase, rc: r.rc, land: r.land, dist, droneH });
    if (r.land || P.phase === 'abort') break;
  }
  return { P, log, dist, droneH };
}

test('停到手上：飛近到約 0.5–0.6 m、比手略高 → 懸停 → 手掌移到下方 → 送 land', () => {
  const { P, log, dist, droneH } = runLander({ handUnderAt: 1500 });
  const hold = log.find((x) => x.phase === 'hold');
  assert.ok(hold, '要進入懸停等待');
  assert.ok(hold.dist <= PALM.holdDist + 0.02 && hold.dist >= PALM.retreatDist, `dist=${hold.dist}`);
  assert.ok(hold.droneH > 110, '懸停時要比手高');
  const last = log[log.length - 1];
  assert.ok(last.land, '偵測到手在下方要送 land');
  assert.equal(P.phase, 'landing');
  assert.ok(log.every((x) => x.rc[1] <= PALM.fwdMax), '前進速度有上限');
  assert.ok(dist > 0.3 && droneH > 0);
});

test('停到手上：懸停 20 秒沒有手伸到下方 → 取消', () => {
  const { P } = runLander({ handUnderAt: null });
  assert.equal(P.phase, 'abort');
  assert.ok(P.reason.includes('正下方'));
});

test('停到手上：接近途中看不到手超過 1.5 秒 → 取消；ToF 只是一般高度變化不會誤降落', () => {
  const { P } = runLander({ loseHand: true });
  assert.equal(P.phase, 'abort');
  assert.ok(P.reason.includes('看不到'));
  // 懸停中 ToF 緩慢變化（高度保持誤差）不算手掌
  const L = new PalmLander();
  L.start(0); L.phase = 'hold'; L.holdAt = 0;
  let landed = false;
  for (let t = 0; t < 8000; t += 100) {
    const tof = 120 + 10 * Math.sin(t / 700);
    if (L.update({ now: t, hand: null, tof, flying: true }).land) landed = true;
  }
  assert.equal(landed, false);
});

test('停到手上：太近（肩寬顯示 < 0.35 m）一律後退', () => {
  const L = new PalmLander();
  L.start(0);
  const r = L.update({ now: 33, hand: { x: 0.5, y: 0.66, dist: 0.5 }, distMin: 0.3, tof: 100 });
  assert.ok(r.rc[1] < 0);
});
