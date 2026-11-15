// 語音提示（Web Speech API，zh-TW）：眼睛盯著無人機時也聽得到警示。
// 規則：同一句 10 秒內不重複；danger 會打斷正在唸的 warn／info，反過來不插話；沒有 speechSynthesis 就安靜地跳過。
const PRIORITY = { info: 0, ok: 0, warn: 1, danger: 2 };

export function createVoice(synth = (typeof window !== 'undefined' ? window.speechSynthesis : null), opts = {}) {
  const now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const dedupeMs = opts.dedupeMs ?? 10000;
  const lang = opts.lang || 'zh-TW';
  const Utter = opts.Utterance || (typeof globalThis !== 'undefined' ? globalThis.SpeechSynthesisUtterance : undefined);
  const last = new Map();      // text → 上次唸的時間
  let current = null;          // { text, level }
  let enabled = true;
  const supported = !!synth && typeof synth.speak === 'function' && typeof Utter === 'function';

  function pickVoice() {
    try {
      const voices = synth.getVoices ? synth.getVoices() : [];
      return voices.find((v) => /^zh[-_](TW|Hant)/i.test(v.lang)) || voices.find((v) => /^zh/i.test(v.lang)) || null;
    } catch (e) { return null; }
  }

  function speak(level, text) {
    if (!enabled || !supported || !text) return false;
    const t = now();
    const prev = last.get(text);
    if (prev != null && t - prev < dedupeMs) return false;
    const p = PRIORITY[level] ?? 0;
    if (current) {
      const cp = PRIORITY[current.level] ?? 0;
      if (p > cp) {
        try { synth.cancel(); } catch (e) { /* ignore */ }
      } else if (p < cp) {
        return false;           // 正在唸更重要的，不插話
      }
    }
    last.set(text, t);
    let u;
    try { u = new Utter(text); } catch (e) { return false; }
    u.lang = lang;
    u.rate = 1.05;
    const v = pickVoice();
    if (v) u.voice = v;
    current = { text, level };
    u.onend = u.onerror = () => { if (current && current.text === text) current = null; };
    try { synth.speak(u); } catch (e) { current = null; return false; }
    return true;
  }

  return {
    supported,
    get enabled() { return enabled; },
    set enabled(v) {
      enabled = !!v;
      if (!enabled && supported) { try { synth.cancel(); } catch (e) { /* ignore */ } current = null; }
    },
    speak,
    /** 讓同一句可以馬上再唸（例如狀態恢復後又再次發生）。 */
    forget(text) { last.delete(text); },
    get speaking() { return !!current; },
  };
}
