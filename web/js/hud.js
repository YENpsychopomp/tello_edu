// HUD：高度、ToF、水平/垂直速度、航向、人工地平線（疊在影像上，不會錄進影片）。
const $ = (id) => document.getElementById(id);
const PX_PER_DEG = 3;   // 地平線每度俯仰移動幾個 viewBox 單位

export function fmtNum(v, digits = 0) {
  return Number.isFinite(v) ? v.toFixed(digits) : (digits ? '-.-' : '--');
}

export function updateHud(tel) {
  const ok = tel && tel.connected;
  $('hudH').textContent = ok ? fmtNum(tel.h) : '--';
  $('hudTof').textContent = ok ? fmtNum(tel.tof) : '--';
  // Tello 的 vgx/vgy/vgz 單位是 dm/s（社群實測；官方文件未明載）→ 換算成 m/s
  if (ok && Number.isFinite(tel.vgx) && Number.isFinite(tel.vgy)) {
    $('hudVh').textContent = (Math.hypot(tel.vgx, tel.vgy) / 10).toFixed(1);
  } else $('hudVh').textContent = '-.-';
  $('hudVz').textContent = ok && Number.isFinite(tel.vgz) ? (-tel.vgz / 10).toFixed(1) : '-.-';
  $('hudYaw').textContent = ok && Number.isFinite(tel.yaw) ? String(((tel.yaw % 360) + 360) % 360).padStart(3, '0') : '---';
  const roll = ok && Number.isFinite(tel.roll) ? tel.roll : 0;
  const pitch = ok && Number.isFinite(tel.pitch) ? tel.pitch : 0;
  $('hzRot').setAttribute('transform', `rotate(${-roll})`);
  $('hzPitch').setAttribute('transform', `translate(0 ${Math.max(-80, Math.min(80, pitch * PX_PER_DEG))})`);
}
