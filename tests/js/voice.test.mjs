// 語音提示的規則：去重、優先權打斷、關閉、沒有 speechSynthesis 時安靜跳過。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoice } from '../../web/js/voice.js';

class FakeUtterance { constructor(text) { this.text = text; } }

function fakeSynth() {
  const s = { spoken: [], cancels: 0, voices: [{ lang: 'en-US' }, { lang: 'zh-TW', name: 'Hanhan' }] };
  s.speak = (u) => { s.spoken.push(u); };
  s.cancel = () => { s.cancels += 1; };
  s.getVoices = () => s.voices;
  return s;
}

test('同一句 10 秒內不重複；不同句照唸；10 秒後可以再唸', () => {
  let t = 0;
  const s = fakeSynth();
  const v = createVoice(s, { now: () => t, Utterance: FakeUtterance });
  assert.ok(v.supported);
  assert.equal(v.speak('warn', '電量 30%'), true);
  s.spoken[0].onend();
  assert.equal(v.speak('warn', '電量 30%'), false);
  assert.equal(v.speak('warn', '溫度過高'), true);
  s.spoken[1].onend();
  t = 10001;
  assert.equal(v.speak('warn', '電量 30%'), true);
  assert.equal(s.spoken.length, 3);
  assert.equal(s.spoken[0].lang, 'zh-TW');
  assert.equal(s.spoken[0].voice.name, 'Hanhan');          // 優先挑 zh-TW 的語音
});

test('danger 打斷正在唸的 warn；warn 不會插在 danger 前面', () => {
  const s = fakeSynth();
  const v = createVoice(s, { now: () => 0, Utterance: FakeUtterance });
  assert.ok(v.speak('warn', '電量 30%'));
  assert.ok(v.speaking);
  assert.ok(v.speak('danger', '連線中斷'));
  assert.equal(s.cancels, 1);
  assert.equal(v.speak('warn', '手把中斷'), false);        // danger 還在唸
  s.spoken[1].onend();
  assert.equal(v.speaking, false);
  assert.ok(v.speak('warn', '手把中斷'));
});

test('關閉後不唸、會取消正在唸的；forget 讓同一句可以馬上再唸', () => {
  const s = fakeSynth();
  const v = createVoice(s, { now: () => 0, Utterance: FakeUtterance });
  assert.ok(v.speak('danger', '自動降落'));
  v.enabled = false;
  assert.equal(s.cancels, 1);
  assert.equal(v.speak('danger', '別的'), false);
  v.enabled = true;
  assert.equal(v.speak('danger', '自動降落'), false);
  v.forget('自動降落');
  assert.equal(v.speak('danger', '自動降落'), true);
});

test('瀏覽器不支援時 supported=false、speak 回 false、不會丟例外', () => {
  const v = createVoice(null, { Utterance: FakeUtterance });
  assert.equal(v.supported, false);
  assert.equal(v.speak('danger', 'x'), false);
  const w = createVoice({ speak() {} }, { Utterance: undefined });
  assert.equal(w.supported, false);
});
