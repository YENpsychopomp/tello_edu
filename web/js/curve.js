// 搖桿曲線：死區（並重新縮放）→ expo。純函式，E2E 測試也直接驗證輸出。

export const SPEED = {
  fine: { k: 0.3, label: '精細' },
  normal: { k: 0.6, label: '一般' },
  full: { k: 1.0, label: '全速' },
};

export function deadzone(v, dz) {
  const a = Math.abs(v);
  if (!Number.isFinite(v) || a < dz) return 0;
  return Math.sign(v) * Math.min(1, (a - dz) / (1 - dz));
}

export function expo(v, e) {
  // (1-e)·x + e·x³：中間更細膩，推到底仍是 ±1
  return (1 - e) * v + e * v * v * v;
}

export function shape(v, dz, e) {
  return expo(deadzone(v, dz), e);
}

const clamp = (v) => Math.max(-100, Math.min(100, v));

// Tello rc a b c d = 左右 前後 升降 轉向（Mode 2：左搖桿升降/轉向，右搖桿前後/左右）
export function sticksToRc({ lx, ly, rx, ry }, k) {
  return [rx, -ry, -ly, lx].map((v) => clamp(Math.round(v * 100 * k)) || 0);
}
