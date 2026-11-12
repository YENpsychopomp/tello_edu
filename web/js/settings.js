// 設定：存在 localStorage，所有讀寫都包 try/catch（隱私模式、封鎖儲存時照樣能用）。
const KEY = 'tello-gcs.settings.v1';

export const DEFAULTS = Object.freeze({
  deadzone: 0.12,
  expo: 0,
  tempWarn: 85,
  videoMode: 'auto',
  vibration: true,
  keyboard: true,
});

const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

export function sanitize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    deadzone: num(r.deadzone, 0.04, 0.3, DEFAULTS.deadzone),
    expo: num(r.expo, 0, 0.8, DEFAULTS.expo),
    tempWarn: num(r.tempWarn, 60, 95, DEFAULTS.tempWarn),
    videoMode: ['auto', 'webcodecs', 'mjpeg'].includes(r.videoMode) ? r.videoMode : DEFAULTS.videoMode,
    vibration: typeof r.vibration === 'boolean' ? r.vibration : DEFAULTS.vibration,
    keyboard: typeof r.keyboard === 'boolean' ? r.keyboard : DEFAULTS.keyboard,
  };
}

export function loadSettings() {
  try {
    const raw = window.localStorage.getItem(KEY);
    return sanitize(raw ? JSON.parse(raw) : {});
  } catch (e) {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(sanitize(s)));
    return true;
  } catch (e) {
    return false;
  }
}
