// 航跡推算：速度×航向積分、起飛歸零、遙測中斷不積分、離起點距離與方位、點數上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Track, drawTrack } from '../../web/js/track.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function fly(track, { vgx = 0, vgy = 0, yaw = 0, secs = 1, hz = 10, t0 = 0 }) {
  let t = t0;
  for (let i = 0; i < secs * hz; i++) {
    t += 1000 / hz;
    track.update({ vgx, vgy, yaw, flying: true }, t);
  }
  return t;
}

test('機頭朝北往前飛 1 m/s 兩秒 → 北 2 m；朝東往前 → 東；往右平移 → 東', () => {
  const tr = new Track();
  tr.update({ vgx: 0, vgy: 0, yaw: 0, flying: true }, 0);     // 起飛：第一筆只定時間
  fly(tr, { vgx: 10, yaw: 0, secs: 2 });                         // 10 dm/s = 1 m/s
  assert.ok(near(tr.x, 0, 1e-9) && near(tr.y, 2, 1e-9), `${tr.x},${tr.y}`);
  assert.ok(near(tr.dist, 2, 1e-9));
  const tr2 = new Track();
  tr2.update({ flying: true, yaw: 90 }, 0);
  fly(tr2, { vgx: 10, yaw: 90, secs: 1 });
  assert.ok(near(tr2.x, 1, 1e-9) && near(tr2.y, 0, 1e-9), `${tr2.x},${tr2.y}`);
  const tr3 = new Track();
  tr3.update({ flying: true, yaw: 0 }, 0);
  fly(tr3, { vgy: 5, yaw: 0, secs: 2 });                         // 右平移 0.5 m/s
  assert.ok(near(tr3.x, 1, 1e-9) && near(tr3.y, 0, 1e-9), `${tr3.x},${tr3.y}`);
});

test('繞方形回到起點附近；起點方位相對機頭', () => {
  const tr = new Track();
  let t = tr.update({ flying: true, yaw: 0 }, 0) ? 0 : 0;
  t = fly(tr, { vgx: 10, yaw: 0, secs: 2, t0: t });
  t = fly(tr, { vgx: 10, yaw: 90, secs: 2, t0: t });
  t = fly(tr, { vgx: 10, yaw: 180, secs: 2, t0: t });
  t = fly(tr, { vgx: 10, yaw: 270, secs: 2, t0: t });
  assert.ok(Math.hypot(tr.x, tr.y) < 1e-6, `${tr.x},${tr.y}`);
  assert.ok(near(tr.dist, 8, 1e-9));
  assert.ok(tr.points.length >= 4);
  // 在起點北方 2 m、機頭朝北 → 起點在正後方（±180）；機頭朝南 → 正前方 0；朝東 → 右手邊 +90
  const a = new Track(); a.update({ flying: true, yaw: 0 }, 0); fly(a, { vgx: 10, yaw: 0, secs: 2 });
  assert.ok(near(a.home().dist, 2, 1e-9));
  assert.ok(Math.abs(Math.abs(a.home().bearing) - 180) < 1e-9, String(a.home().bearing));
  a.update({ vgx: 0, vgy: 0, yaw: 180, flying: true }, 99999);
  assert.ok(near(a.home().bearing, 0, 1e-9));
  a.update({ vgx: 0, vgy: 0, yaw: 90, flying: true }, 99999);
  assert.ok(near(a.home().bearing, 90, 1e-9), String(a.home().bearing));
});

test('起飛時歸零；落地後不積分；遙測中斷超過 1 秒那一筆不積分', () => {
  const tr = new Track();
  tr.update({ flying: true, yaw: 0 }, 0);
  let t = fly(tr, { vgx: 10, secs: 1 });
  assert.ok(near(tr.y, 1, 1e-9));
  tr.update({ vgx: 10, flying: false }, t + 100);                // 落地：不動
  tr.update({ vgx: 10, flying: false }, t + 200);
  assert.ok(near(tr.y, 1, 1e-9));
  tr.update({ vgx: 10, flying: true }, t + 300);                 // 再起飛 → 歸零
  assert.ok(tr.x === 0 && tr.y === 0 && tr.points.length === 1);
  t = fly(tr, { vgx: 10, secs: 1, t0: t + 300 });
  assert.ok(near(tr.y, 1, 1e-9));
  assert.equal(tr.update({ vgx: 10, flying: true }, t + 1500), false);   // 中斷 1.5 秒
  assert.ok(near(tr.y, 1, 1e-9));
  assert.equal(tr.update({ vgx: 10, flying: true }, t + 1600), true);
  assert.equal(tr.update(null, t + 1700), false);
});

test('點數上限保留起點；drawTrack 可以畫在假的 canvas 上', () => {
  const tr = new Track({ maxPoints: 20, minStep: 0.01 });
  tr.update({ flying: true, yaw: 0 }, 0);
  fly(tr, { vgx: 10, secs: 10 });
  assert.ok(tr.points.length <= 20);
  assert.deepEqual(tr.points[0], [0, 0]);
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === 'canvas' ? null : (...a) => { calls.push(String(k)); }), set: () => true });
  drawTrack(ctx, tr, { w: 200, h: 150 });
  assert.ok(calls.includes('fillRect') && calls.includes('stroke') && calls.includes('fill'));
});
