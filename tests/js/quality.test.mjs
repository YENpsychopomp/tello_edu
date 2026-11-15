// 跟隨品質的蒙地卡羅壓力測試：用真正的控制程式碼（估計器、PD 控制器、變化量限制、影像凍結處理）
// 在「影像不完整」的條件下跑很多個隨機種子，量「目標在容許誤差內的時間比例」。
//
// 干擾（模擬 Wi-Fi UDP 影像）：偵測 fps 在 6–12 之間浮動、每幀 15% 機率缺漏、3% 機率位置亂跳、
// 影像延遲 150 ms、每 20 秒左右凍結 1 秒、量測有雜訊；人會走動（橫向最快 1 m/s、前後最快 0.6 m/s）、偶爾停下、轉彎。
// 無人機：轉向 100 rc ≈ 90°/s、前後 100 rc ≈ 2 m/s（慢速模式），一階延遲 0.35 s。
//
// 門檻（扣掉前 3 秒的收斂）：
//   * 置中：目標水平位置在畫面中央 ±15% 的時間，每個種子 ≥ 92%、平均 ≥ 95%（人眼最在意的是有沒有一直對著人）
//   * 置中＋距離（±0.7 m）同時滿足：平均 ≥ 90%、每個種子 ≥ 82%（人以接近無人機上限的速度走動時距離會暫時拉開）
//   * 整段時間沒有把目標跟丟（跟丟＝估計器推不下去 → 真機上會進自動搜尋）
// 這些數字是模擬，真機的速度／延遲／光流品質不同，但同一套程式碼跑的就是這個控制邏輯。
import test from 'node:test';
import assert from 'node:assert/strict';
import { OscillationGuard, followRc, slew } from '../../web/js/follow/control.js';
import { EST, TargetEstimator } from '../../web/js/follow/estimator.js';

const HFOV = 70;                     // 水平視角（度）
const STALE_MS = 450;

function rng(seed) {                 // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

export function simulate(seed, { secs = 60, dropout = 0.15, outlier = 0.03, latencyMs = 150, stallEvery = 20, stallMs = 1000, fpsLo = 6, fpsHi = 12, walk = true, log = null } = {}) {
  const r = rng(seed);
  const dt = 1 / 30;
  // 世界：無人機在原點、朝 +y；人在 (px, py)（m）
  const D = { yaw: 0, yawRate: 0, x: 0, y: 0, v: 0 };
  const P = { x: (r() - 0.5) * 1.5, y: 3 + r(), vx: 0, vy: 0, mode: 'stand', until: 2 };
  const sp = { dist: 3, height: 120 };
  const est = new TargetEstimator();
  let rc = [0, 0, 0, 0], integ = 0, integD = 0;
  const osc = new OscillationGuard();
  let t = 0, lastDet = -1, nextDet = 0.3, detPeriod = 100, prevDet = 0;
  let stallVx0 = 0;
  let stallUntil = -1, nextStall = stallEvery * (0.7 + 0.6 * r()), stalled = false, stallSince = 0;
  const queue = [];                  // 延遲中的量測 [{at, m}]
  let inTol = 0, counted = 0, lost = 0, maxErr = 0, inX = 0, inD = 0;
  const T = () => Math.round(t * 1000);

  for (let step = 0; step < secs / dt; step++) {
    t += dt;
    // ---- 人走動
    if (walk && t >= P.until) {
      const m = r();
      P.mode = m < 0.35 ? 'stand' : m < 0.75 ? 'side' : 'fwdback';
      P.until = t + 1.5 + r() * 4;
      const s = r() < 0.5 ? -1 : 1;
      P.vx = P.mode === 'side' ? s * (0.3 + 0.7 * r()) : 0;
      P.vy = P.mode === 'fwdback' ? s * (0.2 + 0.4 * r()) : 0;
    }
    P.x += P.vx * dt; P.y += P.vy * dt;
    // ---- 無人機動力：rc → 速度（一階延遲）
    const tau = 0.35;
    D.yawRate += ((rc[3] / 100) * 90 - D.yawRate) * (dt / tau);
    D.v += ((rc[1] / 100) * 2.0 - D.v) * (dt / tau);
    D.yaw += D.yawRate * dt;
    const th = (D.yaw * Math.PI) / 180;
    D.x += Math.sin(th) * D.v * dt; D.y += Math.cos(th) * D.v * dt;
    // ---- 真實的相對幾何
    const dx = P.x - D.x, dy = P.y - D.y;
    const dist = Math.hypot(dx, dy);
    const bearing = (Math.atan2(dx, dy) * 180) / Math.PI - D.yaw;          // 相對機頭（度，右正）
    const rel = ((bearing + 540) % 360) - 180;
    const cxTrue = 0.5 + rel / HFOV;
    const inFrame = cxTrue > 0.04 && cxTrue < 0.96;
    // ---- 影像凍結
    let stallVx = 0;
    if (!stalled && t >= nextStall) { stalled = true; stallSince = t; stallUntil = t + stallMs / 1000 * (0.6 + 0.8 * r()); nextStall = t + stallEvery * (0.7 + 0.6 * r()); stallVx0 = rc[3]; }
    stallVx = stallVx0;
    if (stalled && t >= stallUntil) { stalled = false; est.shift(T() - Math.round(stallSince * 1000)); }
    // ---- 偵測（fps 浮動、延遲、缺漏、亂跳、雜訊）
    if (!stalled && t >= nextDet) {
      const fps = fpsLo + (fpsHi - fpsLo) * r();
      nextDet = t + 1 / fps;
      if (inFrame && r() >= dropout) {
        let m;
        if (r() < outlier) m = { cx: r(), cy: r(), dist: 0.5 + 5 * r() };
        else m = { cx: cxTrue + gauss(r) * 0.012, cy: 0.5 + gauss(r) * 0.01, dist: dist * (1 + gauss(r) * 0.06) };
        queue.push({ at: t + latencyMs / 1000, m });
      }
    }
    while (queue.length && queue[0].at <= t) {
      const { m } = queue.shift();
      const now = T();
      if (est.feed(m, now)) { if (prevDet) detPeriod = detPeriod * 0.8 + Math.min(1000, now - prevDet) * 0.2; prevDet = now; lastDet = now; }
    }
    // ---- 控制（和 follow.js 的 mix 相同邏輯）
    let next = [0, 0, 0, 0], dbg = null, gainNow = 1;
    if (!stalled) {
      const p = est.predict(T());
      if (p) {
        dbg = p;
        const gain = Math.max(0.5, Math.min(1, (1000 / Math.max(50, detPeriod)) / 8)) * osc.factor;
        gainNow = gain;
        const out = followRc({ cx: p.cx, dist: p.dist, distMin: p.dist }, sp, 120, { vx: p.vx, vd: p.vd, gain, integ, integD, dt });
        integ = out.integ; integD = out.integD;
        osc.feed(out.raw[3], T());
        next = out.raw;
      } else { integ = 0; integD = 0; if (t > 3 && lastDet >= 0) lost++; }
    } else {
      // 和 follow.js 一樣：凍結的第一秒維持凍結前的轉向指令並逐漸減到 0
      const k = Math.max(0, 1 - (t - stallSince) / 1.0);
      next = [0, 0, 0, Math.round(Math.max(-30, Math.min(30, stallVx * k)))];
    }
    rc = slew(rc, next);
    // ---- 統計（前 3 秒收斂不算）
    if (t > 3) {
      counted++;
      const errX = Math.abs(cxTrue - 0.5), errD = Math.abs(dist - sp.dist);
      maxErr = Math.max(maxErr, errX);
      if (errX < 0.15 && errD < 0.7) inTol++;
      if (errX < 0.15) inX++;
      if (errD < 0.7) inD++;
      if (log) log.push({ t: +t.toFixed(2), cx: +cxTrue.toFixed(3), dist: +dist.toFixed(2), rc: rc.slice(), raw: next.slice(), est: dbg ? { cx: +dbg.cx.toFixed(3), dist: dbg.dist == null ? null : +dbg.dist.toFixed(2), vd: +dbg.vd.toFixed(2), age: dbg.age } : null, stalled, mode: P.mode, pv: [+P.vx.toFixed(2), +P.vy.toFixed(2)], iD: +integD.toFixed(1), g: +gainNow.toFixed(2) });
    }
  }
  return { ratio: inTol / counted, ratioX: inX / counted, ratioD: inD / counted, lost, maxErr, oscFactor: osc.factor, oscTrips: osc.trips, finalDist: Math.hypot(P.x - D.x, P.y - D.y) };
}

test('壓力測試：掉幀 15%、亂跳 3%、延遲 150 ms、6–12 fps、每 20 秒凍結 1 秒、人會走動 → 置中 ≥ 95%、置中＋距離 ≥ 90%、不跟丟', () => {
  const results = [];
  for (let seed = 1; seed <= 20; seed++) results.push({ seed, ...simulate(seed) });
  const mean = (k) => results.reduce((s, x) => s + x[k], 0) / results.length;
  const worst = (k) => results.reduce((a, b) => (a[k] < b[k] ? a : b));
  const summary = results.map((x) => `${x.seed}:${(x.ratio * 100).toFixed(0)}%/X${(x.ratioX * 100).toFixed(0)}%${x.lost ? ` lost=${x.lost}` : ''}`).join(' ');
  assert.ok(mean('ratioX') >= 0.95 && worst('ratioX').ratioX >= 0.92, `置中：平均 ${(mean('ratioX') * 100).toFixed(1)}%、最差 ${(worst('ratioX').ratioX * 100).toFixed(1)}%
${summary}`);
  assert.ok(mean('ratio') >= 0.9 && worst('ratio').ratio >= 0.82, `置中＋距離：平均 ${(mean('ratio') * 100).toFixed(1)}%、最差 ${(worst('ratio').ratio * 100).toFixed(1)}%
${summary}`);
  assert.ok(results.every((x) => x.lost === 0), `有種子跟丟：${summary}`);
  console.log(`  跟隨品質（20 個種子）：置中 平均 ${(mean('ratioX') * 100).toFixed(1)}%／最差 ${(worst('ratioX').ratioX * 100).toFixed(1)}%；置中＋距離 平均 ${(mean('ratio') * 100).toFixed(1)}%／最差 ${(worst('ratio').ratio * 100).toFixed(1)}%`);
});

test('惡劣鏈路（掉幀 35%、亂跳 8%、延遲 250 ms、4–8 fps、每 12 秒凍結 1 秒）：擺盪偵測會自動降增益；置中平均 ≥ 60%（參考值，真機這種鏈路應該先修網路）', () => {
  const results = [];
  for (let seed = 1; seed <= 12; seed++) results.push(simulate(seed, { dropout: 0.35, outlier: 0.08, latencyMs: 250, fpsLo: 4, fpsHi: 8, stallEvery: 12 }));
  const meanX = results.reduce((s, x) => s + x.ratioX, 0) / results.length;
  const mean = results.reduce((s, x) => s + x.ratio, 0) / results.length;
  assert.ok(results.some((x) => x.oscTrips > 0), '延遲 250 ms 時擺盪偵測應該有觸發過');
  assert.ok(meanX >= 0.6, `置中平均 ${(meanX * 100).toFixed(1)}%：${results.map((x) => (x.ratioX * 100).toFixed(0)).join(' ')}`);
  console.log(`  惡劣鏈路：置中平均 ${(meanX * 100).toFixed(1)}%、置中＋距離平均 ${(mean * 100).toFixed(1)}%、擺盪降增益觸發 ${results.filter((x) => x.oscTrips).length}/12 個種子`);
});

test('沒有干擾、人站著不動：幾乎 100%（控制器本身不會擺盪）', () => {
  const r = simulate(7, { dropout: 0, outlier: 0, latencyMs: 100, stallEvery: 1e9, fpsLo: 12, fpsHi: 12, walk: false });
  assert.ok(r.ratio > 0.99, `${(r.ratio * 100).toFixed(1)}%`);
  assert.ok(r.maxErr < 0.1, `最大偏差 ${r.maxErr}`);
});
