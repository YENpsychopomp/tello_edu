// 觸控虛擬搖桿：像素位移 → 搖桿值（死區、半徑夾限、方向）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOUCH, stickValue } from '../../web/js/touch.js';

test('死區內為 0；半徑處為 1；超過半徑夾到 1；方向正確', () => {
  assert.deepEqual(stickValue(0, 0), { x: 0, y: 0 });
  assert.deepEqual(stickValue(3, -2), { x: 0, y: 0 });                      // 死區（8% × 70 px ≈ 5.6 px）
  const full = stickValue(TOUCH.radius, 0);
  assert.ok(Math.abs(full.x - 1) < 1e-9 && full.y === 0);
  const over = stickValue(0, 300);
  assert.ok(Math.abs(over.y - 1) < 1e-9 && over.x === 0);                   // 往下 = +y（和手把 axes 一樣）
  const diag = stickValue(-200, -200);
  assert.ok(Math.abs(Math.hypot(diag.x, diag.y) - 1) < 1e-9 && diag.x < 0 && diag.y < 0);
  const half = stickValue(TOUCH.radius * 0.54, 0);                          // 死區外重新縮放：(0.54-0.08)/(0.92) = 0.5
  assert.ok(Math.abs(half.x - 0.5) < 1e-9);
});
