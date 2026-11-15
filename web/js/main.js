// 主程式：輸入（手把／鍵盤）→ rc 30 Hz；遙測 → 狀態列、HUD、飛前檢查、警示。
import { SPEED, sticksToRc, shape } from './curve.js';
import { FollowMode } from './follow/follow.js';
import { BTN, GamepadInput, rumble } from './gamepad.js';
import { updateHud } from './hud.js';
import { KeyboardInput } from './keyboard.js';
import { evaluatePreflight, shortId } from './preflight.js';
import { Recorder, snapshot } from './recorder.js';
import { DEFAULTS, loadSettings, saveSettings, sanitize } from './settings.js';
import { toast } from './toast.js';
import { Track, drawTrack } from './track.js';
import { VideoPlayer } from './video.js';
import { createVoice } from './voice.js';
import { ControlSocket } from './ws.js';

const $ = (id) => document.getElementById(id);
const ICON = { ok: 'i-ok', warn: 'i-warn', danger: 'i-danger', none: 'i-info', info: 'i-info' };
const setIcon = (svgEl, level) => {
  const use = svgEl && svgEl.querySelector('use');
  if (use) use.setAttribute('href', `#${ICON[level] || ICON.none}`);
};

let settings = loadSettings();
// 語音提示：眼睛盯著無人機時也聽得到；同一句 10 秒內不重複，danger 會打斷 warn
const voice = createVoice();
voice.enabled = settings.voice;
const say = (level, text) => voice.speak(level, text);

const S = {
  role: 'observer', hasPilot: false, sim: false, tel: null, everTello: false,
  rc: [0, 0, 0, 0], speed: 'normal', src: '無', pad: { connected: false, id: '', mapping: '', held: () => false },
  centered: true, padId: '', videoOn: false, pf: null,
  batLevel: 'none', tempLevel: 'none', linkAlarm: false, lastDangerBuzz: 0, hiddenAt: 0,
  config: { flip_min_battery: 50 }, mission: null, missionExample: '', limitsSent: '',
};

// =============================================================== 連線
const sock = new ControlSocket('/ws/control', {
  onState: (st) => {
    if (st === 'open') { addLog('ok', '已連上本機地面站程式'); S.limitsSent = ''; }
    if (st === 'closed' && sock.everOpen) addLog('danger', '與本機地面站程式的連線中斷');
    render();
  },
  onMessage: (m) => {
    switch (m.t) {
      case 'hello':
        S.role = m.role; S.sim = !!m.sim; S.config = m.config || S.config;
        (m.events || []).forEach((e) => addLog(e.level, e.msg, e.ts, true));
        { const fd = (m.events || []).filter((e) => e.code === 'flight_done').pop(); if (fd) onFlightDone(fd, true); }
        S.missionExample = m.mission_example || S.missionExample;
        if (m.mission) { S.mission = m.mission; renderMission(); }
        if (m.role === 'observer') toast('warn', '觀看模式', '另一個分頁正在控制。需要的話按「接管控制」。');
        break;
      case 'tel':
        S.tel = m; S.role = m.role; S.hasPilot = m.has_pilot; S.sim = !!m.sim;
        if (m.connected) S.everTello = true;
        break;
      case 'event':
        addLog(m.level, m.msg, m.ts);
        if (m.code === 'auto_land' || m.code === 'silenced') { toast('danger', '自動降落', m.msg); buzz('danger'); say('danger', '控制中斷，自動降落'); }
        else if (m.code === 'link_lost') buzz('danger');
        else if (m.code === 'link_ok') { toast('ok', 'Tello 已連線', m.msg); say('ok', 'Tello 已連線'); }
        else if (m.code === 'pilot_lost' && S.role !== 'pilot') toast('warn', '機長離線', m.msg);
        else if (m.code === 'flight_done') onFlightDone(m);
        else if (m.code === 'low_bat_land') { toast('danger', '低電量自動降落', m.msg); buzz('danger'); say('danger', '電量過低，自動降落'); }
        else if (m.code === 'mission_done') { toast('ok', '任務完成', m.msg); buzz('tap'); say('ok', '任務完成'); }
        else if (m.code === 'mission_aborted') { toast('warn', '任務已中止', m.msg); buzz('warn'); say('warn', '任務已中止'); }
        else if (m.code === 'mission_error') { toast('danger', '任務失敗，已停下', m.msg); buzz('warn'); say('danger', '任務失敗，已停下'); }
        break;
      case 'mission':
        S.mission = m;
        renderMission();
        break;
      case 'role':
        S.role = m.role;
        if (m.role === 'pilot') { toast('ok', '你現在是機長', '手把與鍵盤已可控制無人機'); buzz('tap'); }
        else { toast('warn', '控制權已被接管', m.reason || '這個分頁變成觀看模式'); follow.disable(); }
        break;
      default:
    }
  },
});

// =============================================================== 指令
const LABEL = {
  takeoff: '起飛', land: '降落', emergency: '緊急停槳', streamon: '開啟影像', streamoff: '關閉影像',
  'flip f': '向前翻滾', 'flip b': '向後翻滾', 'flip l': '向左翻滾', 'flip r': '向右翻滾',
  'downvision 1': '切到下視鏡頭', 'downvision 0': '切回前鏡頭',
};
const KIND = {
  ok: ['ok', '成功'], sent: ['ok', '已送出'], error: ['danger', '失敗'], timeout: ['warn', '逾時（沒有回應）'],
  interrupted: ['warn', '已中斷（被降落／停槳取代）'], denied: ['warn', '已拒絕'],
};

async function runCmd(cmd) {
  const r = await sock.cmd(cmd);
  const [level, word] = KIND[r.kind] || ['warn', r.kind];
  const extra = r.kind === 'ok' || r.kind === 'sent' ? '' : (r.resp || '').replace(/^denied\s*/, '');
  toast(level, `${LABEL[cmd] || cmd}：${word}`, extra);
  if (r.hint) showHint(r.hint);
  if (cmd === 'takeoff' && r.kind === 'ok') { buzz('takeoff'); voice.forget('起飛'); say('ok', '起飛'); }
  if (cmd === 'land' && r.kind === 'sent') { voice.forget('降落'); say('ok', '降落'); }
  if (cmd === 'emergency' && r.kind === 'sent') { voice.forget('緊急停槳'); say('danger', '緊急停槳'); }
  if (r.kind === 'error' || r.kind === 'timeout') buzz('warn');
  return r;
}

function showHint(h) {
  $('hintPrimary').textContent = h.primary;
  $('hintRaw').textContent = h.raw || 'error';
  $('hintOthers').replaceChildren(...h.others.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  openDialog($('dlgHint'));
}

const isPilot = () => S.role === 'pilot';

function requirePilot() {
  if (isPilot()) return true;
  toast('warn', '觀看模式', '這個分頁不是機長，請先按「接管控制」');
  buzz('warn');
  return false;
}

function act(name, arg) {
  switch (name) {
    case 'takeoff': {
      if (!requirePilot()) return;
      if (S.tel && S.tel.flying) { toast('info', '已經在空中'); return; }
      const pf = S.pf;
      if (!pf || !pf.pass) {
        toast('warn', '無法起飛：飛前檢查未通過', (pf ? pf.failed : []).map((i) => i.title).join('、'));
        buzz('warn');
        return;
      }
      runCmd('takeoff');
      return;
    }
    case 'land':
      runCmd('land').then((r) => { if (r.kind === 'sent') buzz('land'); });
      return;
    case 'emergency':
      if (!requirePilot()) return;
      runCmd('emergency');
      buzz('danger');
      return;
    case 'flip': {
      if (!requirePilot()) return;
      const f = flipState();
      if (!f.ok) { toast('warn', '翻滾停用', f.text); buzz('warn'); return; }
      runCmd(`flip ${arg}`);
      return;
    }
    case 'video': toggleVideo(); return;
    case 'photo': takePhoto(); return;
    case 'record': toggleRecord(); return;
    case 'help': toggleDialog($('dlgHelp')); return;
    case 'fullscreen': toggleFullscreen(); return;
    case 'follow':
      if (!follow.enabled && !requirePilot()) return;
      if (!follow.enabled && S.batLevel === 'danger') { toast('warn', '電量過低', '無法開啟跟隨模式'); buzz('warn'); return; }
      follow.toggle();
      return;
    case 'followNext': follow.cycle(1); return;
    case 'downcam':
      if (!requirePilot()) return;
      follow.toggleDownCam();
      return;
    case 'mission': openMission(); return;
    default:
  }
}

// =============================================================== 回饋（震動，不支援時改用畫面邊框閃一下）
function buzz(pattern) {
  if (settings.vibration && S.pad.gp && rumble(S.pad.gp, pattern)) return;
  if (pattern === 'tap') return;
  const el = $('hapticFlash');
  el.dataset.level = pattern === 'danger' ? 'danger' : pattern === 'warn' ? 'warn' : 'ok';
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), pattern === 'danger' ? 400 : 180);
}

// =============================================================== 影像／拍照／錄影
const canvas = $('videoCanvas');
const recorder = new Recorder(canvas);
const DEFAULT_TIP = '按 <kbd>Y</kbd> 或「影像」開啟鏡頭畫面';
const player = new VideoPlayer(canvas, $('mjpeg'), {
  onStatus: (state, text) => {
    if (state === 'playing') { $('videoPlaceholder').hidden = true; return; }
    $('videoPlaceholder').hidden = false;
    $('videoTip').textContent = text;
    if (state === 'error') toast('danger', '影像', text);
  },
  onFirstFrame: (mode) => {
    toast('ok', '影像已開啟', mode === 'webcodecs' ? 'WebCodecs 低延遲解碼' : 'MJPEG 備援（延遲較高）');
    addLog('ok', `影像開啟（${mode === 'webcodecs' ? 'WebCodecs' : 'MJPEG'}）`);
  },
});

// =============================================================== 跟隨模式
const follow = new FollowMode({
  canvas, overlay: $('followOverlay'),
  getTel: () => (S.tel && S.tel.connected ? S.tel : null),
  isPilot: () => isPilot(),
  hasVideo: () => S.videoOn && player.hasFrame,
  frameCount: () => player.frames,
  notify: (level, title, text) => {
    toast(level, title, text || '');
    if (level !== 'info') addLog(level, `跟隨：${title}${text ? `（${text}）` : ''}`);
    if (level === 'warn' || level === 'danger') say(level, title);
  },
  buzz: (p) => buzz(p),
  command: (c) => runCmd(c),
  downOrient: () => ({ edge: settings.downEdge, mirror: settings.downMirror }),
  onChange: () => renderFollow(),
});

function renderFollow() {
  const f = follow.status();
  const line = $('flwLine');
  line.dataset.level = f.level;
  line.querySelector('use').setAttribute('href', `#${ICON[f.level] || ICON.none}`);
  $('flwText').textContent = f.text;
  $('btnFollow').setAttribute('aria-pressed', String(f.enabled));
  $('flwBtnText').textContent = f.enabled ? '關閉跟隨' : '開啟跟隨';
  $('flwPeople').hidden = !f.enabled;
  $('flwInfo').hidden = !f.enabled;
  $('app').classList.toggle('follow-on', f.enabled);
  if (!f.enabled) return;
  const key = `${f.people.join(',')}|${f.target}`;
  const box = $('flwPeople');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    if (!f.people.length) box.replaceChildren(Object.assign(document.createElement('span'), { className: 'none', textContent: '畫面中沒有偵測到人' }));
    else {
      box.replaceChildren(...f.people.map((id) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `#${id}`;
        b.title = id === f.target ? '跟隨中' : `改跟 #${id}`;
        b.setAttribute('aria-pressed', String(id === f.target));
        b.addEventListener('click', () => { if (requirePilot()) follow.select(id); });
        return b;
      }));
    }
  }
  $('flwDist').textContent = f.dist === null ? '--' : `約 ${f.dist.toFixed(1)} m`;
  const framed = Number.isFinite(f.hTarget) && Math.abs(f.hTarget - f.sp.height) > 5 ? ` → ${Math.round(f.hTarget)} cm（保持手臂在畫面內）` : '';
  $('flwSp').textContent = f.spInit ? `${f.sp.dist.toFixed(1)} m／${f.sp.height} cm${framed}` : '起飛後鎖定';
  $('flwFps').textContent = f.delegate || follow.fake ? `${f.fps} fps · ${f.delegate || '模擬'}` : '--';
}

function setVideoUi(on) {
  S.videoOn = on;
  $('btnVideo').setAttribute('aria-pressed', String(on));
  if (!on) { $('videoPlaceholder').hidden = false; $('videoTip').innerHTML = DEFAULT_TIP; }
}

async function toggleVideo() {
  if (!S.videoOn) {
    setVideoUi(true);
    $('videoTip').textContent = '開啟影像中…';
    if (isPilot()) {
      const r = await runCmd('streamon');
      if (r.kind !== 'ok') { setVideoUi(false); return; }
    }
    if (S.videoOn) player.start(settings.videoMode);
  } else {
    if (recorder.active) await toggleRecord();
    player.stop();
    setVideoUi(false);
    if (isPilot()) runCmd('streamoff');
  }
}

async function takePhoto() {
  if (!player.hasFrame) { toast('warn', '沒有影像可拍', '請先開啟影像'); return; }
  const name = await snapshot(canvas);
  if (name) { toast('ok', '已拍照', name); buzz('tap'); } else toast('danger', '拍照失敗');
}

async function toggleRecord() {
  if (recorder.active) {
    const name = await recorder.stop();
    $('btnRec').setAttribute('aria-pressed', 'false');
    $('recLabel').textContent = '錄影';
    $('hudRec').hidden = true;
    toast(name ? 'ok' : 'warn', name ? '錄影已儲存' : '錄影沒有內容', name || '');
    return;
  }
  if (!player.hasFrame) { toast('warn', '沒有影像可錄', '請先開啟影像'); return; }
  try {
    recorder.start();
    $('btnRec').setAttribute('aria-pressed', 'true');
    $('recLabel').textContent = '停止';
    $('hudRec').hidden = false;
    toast('ok', '開始錄影', 'WebM 格式，再按一次停止並下載');
  } catch (e) {
    toast('danger', '無法錄影', e.message || String(e));
  }
}

// =============================================================== 輸入迴圈（30 Hz）
const pad = new GamepadInput();
const kb = new KeyboardInput((a) => act(a), () => settings.keyboard);

function inputTick() {
  const p = pad.poll(settings.deadzone, settings.expo);
  const k = kb.sticks();
  let sticks = p.sticks;
  if (k.active) { sticks = k; S.src = '鍵盤'; } else S.src = p.connected ? '手把' : (settings.keyboard ? '鍵盤（待命）' : '無');
  S.speed = p.speed;
  S.rc = sticksToRc(sticks, SPEED[S.speed].k);
  S.pad = p;
  S.centered = !k.active && Object.values(p.sticks).every((v) => v === 0);
  S.rc = follow.mix(S.rc, !S.centered);      // 跟隨模式：搖桿一動就交給手動
  if (isPilot()) sock.send({ t: 'rc', v: S.rc });
  drawSticks(sticks, p.connected || k.active);

  if (p.connected && p.id !== S.padId) {
    S.padId = p.id;
    toast(p.mapping === 'standard' ? 'ok' : 'warn', '已偵測到手把',
      p.mapping === 'standard' ? shortId(p.id) : `${shortId(p.id)}：非標準按鍵對應，按鍵可能錯位`);
    addLog('ok', `手把：${shortId(p.id)}`);
    buzz('tap');
  } else if (!p.connected && S.padId) {
    S.padId = '';
    toast('danger', '手把已中斷', S.tel && S.tel.flying ? '改用鍵盤控制，或立即降落（L）' : '重新插上或按任一鍵');
    if (S.tel && S.tel.flying) say('danger', '手把中斷');
    addLog('danger', '手把中斷');
  }

  if (p.emergency) act('emergency');
  const xHeld = p.held(BTN.X);
  for (const i of p.edges) {
    if (i === BTN.A && !p.held(BTN.LB) && !p.held(BTN.RB)) act('takeoff');
    else if (i === BTN.B) act('land');
    else if (i === BTN.Y) act('video');
    else if (i === BTN.VIEW) act('help');
    else if (i === BTN.MENU) act('follow');
    else if (!xHeld && i === BTN.LEFT && follow.enabled) follow.cycle(-1);
    else if (!xHeld && i === BTN.RIGHT && follow.enabled) follow.cycle(1);
    else if (xHeld && i === BTN.UP) act('flip', 'f');
    else if (xHeld && i === BTN.DOWN) act('flip', 'b');
    else if (xHeld && i === BTN.LEFT) act('flip', 'l');
    else if (xHeld && i === BTN.RIGHT) act('flip', 'r');
  }
}
setInterval(inputTick, 33);

function drawSticks(s, live) {
  const R = 41;
  $('dotL').setAttribute('cx', (s.lx * R).toFixed(1)); $('dotL').setAttribute('cy', (s.ly * R).toFixed(1));
  $('dotR').setAttribute('cx', (s.rx * R).toFixed(1)); $('dotR').setAttribute('cy', (s.ry * R).toFixed(1));
  document.querySelectorAll('.stick').forEach((el) => el.classList.toggle('off', !live));
  const [a, b, c, d] = S.rc;
  const sgn = (v) => (v > 0 ? `+${v}` : String(v));
  $('rcA').textContent = sgn(a); $('rcB').textContent = sgn(b); $('rcC').textContent = sgn(c); $('rcD').textContent = sgn(d);
}

// =============================================================== 畫面更新（10 Hz）
function flipState() {
  const t = S.tel;
  const min = (S.config && S.config.flip_min_battery) || 50;
  if (!t || !t.connected) return { ok: false, level: 'none', text: '停用：未連線' };
  if (Number.isFinite(t.bat) && t.bat < min) return { ok: false, level: 'warn', text: `停用：電量低於 ${min}%` };
  if (!t.flying) return { ok: false, level: 'none', text: '停用：不在空中' };
  return { ok: true, level: 'ok', text: '按住 X＋十字鍵' };
}

const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};

function setStat(id, level) {
  const el = $(id);
  el.dataset.level = level;
  const icon = el.querySelector('.stat-icon');
  if (id === 'stConn') setIcon(icon, level === 'ok' ? 'ok' : level);
  return el;
}

function render() {
  const t = S.tel;
  const wsOpen = sock.state === 'open';
  const connected = wsOpen && t && t.connected;

  // ---- 連線
  let cl = 'danger', ct = '本機程式未連線', cs = '確認 docker / 終端機視窗還在';
  if (wsOpen && connected) { cl = 'ok'; ct = '已連線'; cs = `RTT ${t.rtt_ms ?? '--'} ms · 狀態 ${t.state_pps}/s`; }
  else if (wsOpen && t && t.sdk) { cl = 'warn'; ct = '等待狀態封包'; cs = '有回應但沒有狀態 → 開診斷頁'; }
  else if (wsOpen) { cl = S.everTello ? 'danger' : 'warn'; ct = S.everTello ? 'Tello 中斷' : '等待 Tello…'; cs = '確認 Wi-Fi 連到 TELLO-XXXXXX'; }
  else if (sock.state === 'connecting' && !sock.everOpen) { cl = 'warn'; ct = '連線中…'; cs = ''; }
  setStat('stConn', cl);
  $('connText').textContent = ct;
  $('connSub').textContent = cs;

  // ---- 電量
  const bat = connected && Number.isFinite(t.bat) ? t.bat : null;
  const bl = bat === null ? 'none' : bat <= 15 ? 'danger' : bat <= 30 ? 'warn' : 'ok';
  const be = setStat('stBat', bl);
  be.classList.toggle('blink', bl === 'danger');
  setIcon(be.querySelector('.stat-icon'), bl === 'none' || bl === 'ok' ? 'none' : bl);
  if (bl === 'none' || bl === 'ok') be.querySelector('.stat-icon use').setAttribute('href', '#i-battery');
  $('batVal').textContent = bat === null ? '--' : String(bat);
  $('batBar').style.width = `${bat === null ? 0 : bat}%`;
  $('batRemain').textContent = bat === null ? '剩餘 --:--'
    : `${t.remaining_measured ? '剩餘' : '預估'} ${fmtTime(t.remaining_s)}`;
  if (bl !== S.batLevel) {
    if (bl === 'warn' && S.batLevel !== 'danger') { toast('warn', `電量 ${bat}%`, '請準備降落'); buzz('warn'); addLog('warn', `電量 ${bat}%`); say('warn', `電量 ${bat}%，請準備降落`); }
    if (bl === 'danger') {
      toast('danger', `電量 ${bat}%：立即降落`, ''); buzz('danger'); S.lastDangerBuzz = performance.now(); addLog('danger', `電量 ${bat}%`);
      say('danger', `電量 ${bat}%，立即降落`);
      if (follow.enabled) follow.disable('電量過低，已自動關閉跟隨模式');
    }
    S.batLevel = bl;
  } else if (bl === 'danger' && t.flying && performance.now() - S.lastDangerBuzz > 20000) {
    buzz('danger'); S.lastDangerBuzz = performance.now(); say('danger', `電量 ${bat}%，立即降落`);
  }

  // ---- 飛行時間、Wi-Fi、溫度、速度
  $('timeVal').textContent = connected ? fmtTime(t.time) : '00:00';
  const w = connected && Number.isFinite(t.wifi) ? t.wifi : null;
  const wl = w === null ? 'none' : w >= 50 ? 'ok' : w >= 30 ? 'warn' : 'danger';
  setStat('stWifi', wl);
  $('wifiVal').textContent = w === null ? '--' : String(w);
  $('wifiText').textContent = w === null ? '' : { ok: '良好', warn: '普通', danger: '微弱' }[wl];
  const temp = connected && Number.isFinite(t.temph) ? t.temph : null;
  const tl = temp === null ? 'none' : temp >= settings.tempWarn ? 'warn' : 'ok';
  setStat('stTemp', tl === 'ok' ? 'none' : tl);
  setIcon($('stTemp').querySelector('.stat-icon'), tl === 'warn' ? 'warn' : 'none');
  if (tl !== 'warn') $('stTemp').querySelector('.stat-icon use').setAttribute('href', '#i-temp');
  $('tempVal').textContent = temp === null ? '--' : String(temp);
  if (tl !== S.tempLevel) {
    if (tl === 'warn') { toast('warn', `溫度 ${temp}°C 過高`, '盡快降落、關機散熱'); buzz('warn'); addLog('warn', `溫度 ${temp}°C`); say('warn', '機身溫度過高'); }
    S.tempLevel = tl;
  }
  $('modeVal').textContent = SPEED[S.speed].label;
  $('modePct').textContent = `${Math.round(SPEED[S.speed].k * 100)}%`;
  $('stMode').dataset.level = S.speed === 'full' ? 'warn' : 'none';

  // ---- 角色
  $('simBadge').hidden = !S.sim;
  const pilot = isPilot();
  $('obsBadge').hidden = pilot || !wsOpen;
  const rl = $('roleLine');
  rl.dataset.level = pilot ? 'ok' : 'warn';
  rl.innerHTML = `<svg><use href="#${pilot ? 'i-ok' : 'i-warn'}"/></svg><span></span>`;
  rl.querySelector('span').textContent = pilot ? '你是機長（這個分頁在控制）'
    : S.hasPilot ? '觀看模式：機長在另一個分頁' : '觀看模式：目前沒有機長';
  $('btnTakeover').hidden = pilot || !wsOpen;
  $('inputSrc').textContent = S.src;
  const fs = flipState();
  $('flipLine').dataset.level = fs.level;
  $('flipState').textContent = fs.text;

  // ---- 飛前檢查
  const pf = evaluatePreflight({ wsOpen, tel: t, pad: S.pad, sticksCentered: S.centered, isPilot: pilot });
  S.pf = pf;
  renderPreflight(pf, t && t.flying);
  const tk = $('btnTakeoff');
  tk.setAttribute('aria-disabled', String(!pf.pass || !!(t && t.flying)));
  tk.title = pf.pass ? '起飛（A）' : `飛前檢查未通過：${pf.failed.map((i) => i.title).join('、') || '需要接管控制'}`;
  for (const id of ['btnEmg']) $(id).setAttribute('aria-disabled', String(!pilot));

  // ---- 姿態與鏈路
  const n = (v, u = '') => (connected && Number.isFinite(v) ? `${v}${u}` : '--');
  $('attPitch').textContent = n(t && t.pitch, '°');
  $('attRoll').textContent = n(t && t.roll, '°');
  $('attYaw').textContent = n(t && t.yaw, '°');
  $('attBaro').textContent = connected && Number.isFinite(t.baro) ? `${t.baro.toFixed(2)} m` : '--';
  $('linkRtt').textContent = t && t.rtt_ms != null ? `${t.rtt_ms} ms` : '--';
  $('linkState').textContent = t ? `${t.state_pps} 個/秒` : '--';
  $('linkVideo').textContent = t && t.video ? `${t.video.fps} fps · ${Math.round(t.video.kbps)} kbps` : '--';

  updateHud(connected ? t : null);
  sendLimits();
  renderTrack(connected ? t : null);
  renderFollow();
  renderAlerts(t, connected, bl, bat, tl, temp);
  renderLinkAlarm(t, wsOpen);
  if (recorder.active) $('recTime').textContent = fmtTime(recorder.elapsed());
}
setInterval(render, 100);

function renderPreflight(pf, flying) {
  const ul = $('pfList');
  ul.replaceChildren(...pf.items.map((i) => {
    const li = document.createElement('li');
    li.dataset.level = i.ok ? 'ok' : 'danger';
    li.dataset.id = i.id;
    li.innerHTML = `<svg><use href="#${i.ok ? 'i-ok' : 'i-danger'}"/></svg><b></b><small></small>`;
    li.querySelector('b').textContent = `${i.title}${i.ok ? '' : '（未通過）'}`;
    li.querySelector('small').textContent = i.detail;
    return li;
  }));
  $('preflight').classList.toggle('flying', !!flying);
  const sm = $('pfSummary');
  const level = flying ? 'ok' : pf.summary.level;
  sm.dataset.level = level;
  sm.innerHTML = `<svg><use href="#${level === 'ok' ? 'i-ok' : 'i-warn'}"/></svg><span></span>`;
  sm.querySelector('span').textContent = flying ? '飛行中' : pf.summary.text;
}

function renderAlerts(t, connected, bl, bat, tl, temp) {
  const list = [];
  if (bl === 'danger') list.push(['danger', `電量 ${bat}%：立即降落`]);
  else if (bl === 'warn') list.push(['warn', `電量 ${bat}%：準備降落`]);
  if (tl === 'warn') list.push(['warn', `機身溫度 ${temp}°C 過高`]);
  if (connected && t.ceiling_hit && t.limits) { list.push(['warn', `已到高度上限 ${(t.limits.ceiling / 100).toFixed(1)} m，不再上升`]); say('warn', '已到高度上限'); }
  if (S.pad && !S.pad.connected && t && t.flying && isPilot()) list.push(['warn', '手把中斷：鍵盤 WASD／方向鍵控制，L 降落']);
  const key = JSON.stringify(list);
  if ($('hudAlerts').dataset.key !== key) {
    $('hudAlerts').dataset.key = key;
    $('hudAlerts').replaceChildren(...list.map(([lv, txt]) => {
      const d = document.createElement('div');
      d.className = 'hud-alert'; d.dataset.level = lv;
      d.innerHTML = `<svg><use href="#${ICON[lv]}"/></svg><span></span>`;
      d.querySelector('span').textContent = txt;
      return d;
    }));
  }
  // 斷訊保護狀態
  const sf = t && t.safety;
  const hs = $('hudSafety');
  if (connected && sf && sf.phase !== 'normal' && (t.flying || sf.phase !== 'hover')) {
    hs.hidden = false;
    const lv = sf.phase === 'hover' ? 'warn' : 'danger';
    hs.dataset.level = lv;
    hs.textContent = sf.phase === 'hover' ? `控制中斷 → 懸停中，${sf.land_in ?? '--'} 秒後自動降落`
      : sf.phase === 'landing' ? `控制中斷 → 自動降落中（第 ${sf.land_tries} 次）`
        : '已停止送出指令，等待 Tello 內建 15 秒逾時降落';
  } else hs.hidden = true;
}

function renderLinkAlarm(t, wsOpen) {
  const wsLost = sock.everOpen && !wsOpen;
  const telloLost = wsOpen && S.everTello && t && !t.connected;
  const on = wsLost || telloLost;
  const el = $('linkAlarm');
  if (on !== S.linkAlarm) {
    S.linkAlarm = on;
    el.hidden = !on;
    if (on) { buzz('danger'); voice.forget('連線中斷'); say('danger', '連線中斷'); }
    if (!on && S.everTello) { toast('ok', '連線已恢復'); voice.forget('連線已恢復'); say('ok', '連線已恢復'); }
  }
  if (!on) return;
  if (wsLost) {
    $('alarmTitle').textContent = '與地面站程式的連線中斷';
    $('alarmText').textContent = '控制頁連不到本機程式（docker 容器或終端機視窗還在嗎？）。無人機 0.5 秒後懸停、8 秒後自動降落。正在重新連線…';
  } else {
    $('alarmTitle').textContent = '與 Tello 的連線中斷';
    $('alarmText').textContent = `已 ${Math.min(999, Math.round(t.state_age))} 秒沒收到狀態封包，正在自動重連。確認電腦 Wi-Fi 仍連在 TELLO-XXXXXX；換電池時這是正常的。`;
  }
}

// =============================================================== 航跡（速度×航向推算，起飛歸零）
const track = new Track();
const trackCanvas = $('trackCanvas');
let trackColors = null;
function dirWord(b) {
  const a = Math.abs(b), side = b > 0 ? '右' : '左';
  if (a < 20) return '前方';
  if (a < 70) return `${side}前方`;
  if (a < 110) return `${side}方`;
  if (a < 160) return `${side}後方`;
  return '後方';
}
function renderTrack(t) {
  track.update(t, performance.now());
  if (!trackColors) {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || d).trim();
    trackColors = { bg: v('--surface-3', '#0E1419'), grid: v('--border', '#1F2A33'), path: v('--accent', '#5CB3FF'),
      home: v('--ok', '#3DDC84'), drone: v('--text', '#FFFFFF'), text: v('--text-3', '#8A98A6') };
  }
  const ctx = trackCanvas.getContext('2d');
  if (ctx) drawTrack(ctx, track, { w: trackCanvas.width, h: trackCanvas.height, colors: trackColors });
  const flown = track.points.length > 1 || track.dist > 0;
  const hm = track.home();
  $('trackHome').textContent = flown ? `${hm.dist.toFixed(1)} m · 起點在${dirWord(hm.bearing)}` : '--';
  $('trackDist').textContent = flown ? `${track.dist.toFixed(1)} m` : '--';
}

// =============================================================== 任務腳本
const MISSION_KEY = 'tello.mission';
let msnCheckTimer = 0;
function loadMissionScript() { try { return localStorage.getItem(MISSION_KEY) || ''; } catch (e) { return ''; } }
function saveMissionScript(s) { try { localStorage.setItem(MISSION_KEY, s); } catch (e) { /* 無法儲存就算了 */ } }

function openMission() {
  const ta = $('msnScript');
  if (!ta.value) ta.value = loadMissionScript() || S.missionExample;
  checkMission();
  openDialog($('dlgMission'));
  ta.focus();
}

function showMissionErrors(errors, okText) {
  const ul = $('msnErrors');
  ul.classList.toggle('ok', !errors.length && !!okText);
  ul.replaceChildren(...(errors.length ? errors : okText ? [okText] : []).map((t) => Object.assign(document.createElement('li'), { textContent: t })));
}

async function checkMission() {
  const script = $('msnScript').value;
  saveMissionScript(script);
  const r = await sock.request({ t: 'mission', op: 'check', script });
  if (r.t === 'mission_check') {
    showMissionErrors(r.errors || [], r.ok ? `${r.steps.length} 步，格式正確` : '');
    $('btnMissionRun').disabled = !r.ok;
  }
}

async function runMission() {
  if (!requirePilot()) return;
  const script = $('msnScript').value;
  saveMissionScript(script);
  if (follow.enabled) follow.disable('任務腳本開始，已關閉跟隨模式');
  const r = await sock.request({ t: 'mission', op: 'start', script });
  if (!r.ok) { showMissionErrors(r.errors || ['無法開始'], ''); buzz('warn'); return; }
  $('dlgMission').close();
  toast('ok', '任務開始', '推任何搖桿即可中止');
  buzz('tap');
}

async function abortMission(reason) {
  const r = await sock.request({ t: 'mission', op: 'abort', reason: reason || '按下中止' });
  if (!r.ok) toast('warn', '沒有正在執行的任務', (r.errors || []).join('；'));
}

function renderMission() {
  const ms = S.mission;
  const line = $('msnLine'), text = $('msnText');
  const hud = $('hudMission');
  const running = !!ms && ms.state === 'running';
  $('btnMissionAbort').hidden = !running;
  $('btnMission').disabled = running;
  $('msnSteps').hidden = !ms || !ms.steps || !ms.steps.length;
  if (!ms || ms.state === 'idle') {
    line.dataset.level = 'none'; text.textContent = '沒有任務'; hud.hidden = true;
    line.querySelector('use').setAttribute('href', '#i-info');
    return;
  }
  const cur = running && ms.steps[ms.idx] ? ms.steps[ms.idx] : null;
  const lv = { running: 'ok', done: 'ok', aborted: 'warn', error: 'danger' }[ms.state] || 'none';
  line.dataset.level = lv;
  line.querySelector('use').setAttribute('href', `#${ICON[lv] || ICON.none}`);
  text.textContent = running ? `執行中 ${ms.idx + 1}/${ms.total}：${cur ? cur.cmd : ''}`
    : ms.state === 'done' ? `完成（${ms.total} 步，${ms.elapsed_s ?? '--'} 秒）`
      : ms.state === 'aborted' ? `已中止：${ms.reason}` : `失敗：${ms.reason}`;
  const ol = $('msnSteps');
  const key = ms.steps.map((s) => `${s.status}:${s.cmd}`).join('|');
  if (ol.dataset.key !== key) {
    ol.dataset.key = key;
    ol.replaceChildren(...ms.steps.map((s) => {
      const li = document.createElement('li');
      li.dataset.status = s.status;
      const b = document.createElement('span'); b.textContent = s.cmd;
      const sm = document.createElement('small'); sm.textContent = s.status === 'error' ? (s.resp || '失敗') : s.ms != null && s.status === 'ok' ? `${(s.ms / 1000).toFixed(1)}s` : '';
      li.append(b, sm);
      return li;
    }));
    const r = ol.querySelector('[data-status="running"]');
    if (r) r.scrollIntoView({ block: 'nearest' });
  }
  hud.hidden = !running;
  if (running) { hud.dataset.level = 'ok'; hud.textContent = `任務 ${ms.idx + 1}/${ms.total}：${cur ? cur.cmd : ''}　推搖桿即中止`; }
}

$('btnMission').addEventListener('click', () => act('mission'));
$('btnMissionAbort').addEventListener('click', () => abortMission('按下中止'));
$('btnMissionRun').addEventListener('click', runMission);
$('btnMissionExample').addEventListener('click', () => { $('msnScript').value = S.missionExample; checkMission(); });
$('msnScript').addEventListener('input', () => { clearTimeout(msnCheckTimer); msnCheckTimer = setTimeout(checkMission, 250); });

// =============================================================== 飛行紀錄（黑盒子）
function onFlightDone(m, quiet) {
  const f = m.flight;
  if (!f) return;
  $('flightRow').hidden = false;
  $('flightSummary').textContent = m.msg;
  $('flightCsv').href = `/api/flightlog.csv?flight=${f.n}`;
  if (!quiet) { toast('ok', '飛行結束', `${m.msg}。右側可下載這趟的紀錄（CSV）`, 9000); say('ok', '飛行結束'); voice.forget('飛行結束'); }
}

// =============================================================== 事件紀錄
function addLog(level, msg, ts, quiet) {
  const ol = $('eventLog');
  const li = document.createElement('li');
  li.dataset.level = level === 'info' ? 'none' : level;
  const d = ts ? new Date(ts * 1000) : new Date();
  li.innerHTML = `<svg><use href="#${ICON[level] || ICON.none}"/></svg><span></span><time></time>`;
  li.querySelector('span').textContent = msg;
  li.querySelector('time').textContent = d.toLocaleTimeString('zh-TW', { hour12: false });
  ol.prepend(li);
  while (ol.children.length > 60) ol.lastChild.remove();
  return quiet;
}

// =============================================================== 對話框、設定
function openDialog(d) { if (!d.open) d.showModal(); }
function toggleDialog(d) { if (d.open) d.close(); else d.showModal(); }
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

$('btnHelp').addEventListener('click', () => toggleDialog($('dlgHelp')));
$('btnFull').addEventListener('click', toggleFullscreen);
$('btnSettings').addEventListener('click', () => { fillSettings(); openDialog($('dlgSettings')); });
$('btnTakeover').addEventListener('click', () => {
  $('toText').textContent = S.hasPilot
    ? '接管後，這個分頁的手把與鍵盤會立刻控制無人機。原本的機長分頁會變成只能觀看。'
    : '目前沒有機長（原本的分頁已斷線）。接管後，這個分頁的手把與鍵盤會立刻控制無人機。';
  openDialog($('dlgTakeover'));
});
$('btnTakeoverOk').addEventListener('click', () => { sock.send({ t: 'takeover' }); $('dlgTakeover').close(); });

const form = $('settingsForm');
function fillSettings() {
  form.deadzone.value = settings.deadzone; form.expo.value = settings.expo; form.tempWarn.value = settings.tempWarn;
  form.videoMode.value = settings.videoMode; form.vibration.checked = settings.vibration; form.keyboard.checked = settings.keyboard;
  form.voice.checked = settings.voice;
  form.downEdge.value = settings.downEdge; form.downMirror.checked = settings.downMirror;
  form.ceiling.value = settings.ceiling; form.lowBatLand.value = settings.lowBatLand;
  form.ceilingOn.checked = settings.ceilingOn; form.lowBatLandOn.checked = settings.lowBatLandOn;
  form.ceiling.disabled = !settings.ceilingOn; form.lowBatLand.disabled = !settings.lowBatLandOn;
  settingsLabels();
}

const effectiveLimits = () => ({ ceiling: settings.ceilingOn ? settings.ceiling : 0, low_bat: settings.lowBatLandOn ? settings.lowBatLand : 0 });

// 飛行限制由後端執行（高度上限擋上升、低電量自動降落）；機長分頁把設定送過去，變了才送
function sendLimits() {
  if (!isPilot() || sock.state !== 'open') return;
  const lim = effectiveLimits();
  const key = `${lim.ceiling}:${lim.low_bat}`;
  if (S.limitsSent === key) return;
  if (sock.send({ t: 'limits', ...lim })) S.limitsSent = key;
}
function settingsLabels() {
  $('setDzVal').textContent = Number(settings.deadzone).toFixed(2);
  $('setExpoVal').textContent = Number(settings.expo).toFixed(2);
  $('setTempVal').textContent = `${settings.tempWarn}°C`;
  $('setCeilVal').textContent = settings.ceilingOn ? `${(settings.ceiling / 100).toFixed(1)} m` : '關閉';
  $('setLowBatVal').textContent = settings.lowBatLandOn ? `${settings.lowBatLand}%` : '關閉';
  let d = '';
  for (let i = 0; i <= 50; i++) {
    const x = i / 50;
    d += `${i ? 'L' : 'M'}${(x * 100).toFixed(1)} ${(100 - shape(x, settings.deadzone, settings.expo) * 100).toFixed(1)}`;
  }
  $('curvePath').setAttribute('d', d);
  $('dzL').setAttribute('r', settings.deadzone * 50);
  $('dzR').setAttribute('r', settings.deadzone * 50);
}
form.addEventListener('input', () => {
  settings = sanitize({
    deadzone: form.deadzone.value, expo: form.expo.value, tempWarn: form.tempWarn.value,
    videoMode: form.videoMode.value, vibration: form.vibration.checked, keyboard: form.keyboard.checked, voice: form.voice.checked,
    downEdge: form.downEdge.value, downMirror: form.downMirror.checked,
    ceiling: form.ceiling.value, lowBatLand: form.lowBatLand.value,
    ceilingOn: form.ceilingOn.checked, lowBatLandOn: form.lowBatLandOn.checked,
  });
  form.ceiling.disabled = !settings.ceilingOn; form.lowBatLand.disabled = !settings.lowBatLandOn;
  voice.enabled = settings.voice;
  if (!saveSettings(settings)) toast('warn', '設定無法儲存', '瀏覽器封鎖了 localStorage；重新整理後會恢復預設');
  settingsLabels();
});
$('btnResetSettings').addEventListener('click', () => { settings = { ...DEFAULTS }; saveSettings(settings); fillSettings(); voice.enabled = settings.voice; });
settingsLabels();

// =============================================================== 按鈕
$('btnTakeoff').addEventListener('click', () => act('takeoff'));
$('btnLand').addEventListener('click', () => act('land'));
$('btnVideo').addEventListener('click', () => act('video'));
$('btnPhoto').addEventListener('click', () => act('photo'));
$('btnRec').addEventListener('click', () => act('record'));
$('btnFollow').addEventListener('click', () => act('follow'));

// 緊急停槳：滑鼠長按 1 秒，顯示進度環
(() => {
  const btn = $('btnEmg'), ring = $('emgRing');
  const C = 119.4, HOLD = 1000;
  let t0 = 0, raf = 0, armed = false;
  const reset = () => { armed = false; cancelAnimationFrame(raf); ring.style.strokeDashoffset = C; btn.classList.remove('holding'); };
  const step = () => {
    if (!armed) return;
    const p = Math.min(1, (performance.now() - t0) / HOLD);
    ring.style.strokeDashoffset = String(C * (1 - p));
    if (p >= 1) { reset(); act('emergency'); return; }
    raf = requestAnimationFrame(step);
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (!isPilot()) { requirePilot(); return; }
    btn.setPointerCapture(e.pointerId);
    armed = true; t0 = performance.now(); btn.classList.add('holding'); raf = requestAnimationFrame(step);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, reset));
  btn.addEventListener('click', (e) => e.preventDefault());
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toast('info', '緊急停槳', '請用滑鼠長按 1 秒，或按 Shift+Esc'); } });
})();

// =============================================================== 其他
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await document.documentElement.requestFullscreen();
    // 全螢幕時鎖住 Esc，讓 Shift+Esc（緊急停槳）不會只是離開全螢幕
    if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(['Escape']).catch(() => {});
  } catch (e) {
    toast('warn', '無法切換全螢幕', e.message || '');
  }
}

async function keepAwake() { try { await navigator.wakeLock.request('screen'); } catch (e) { /* 不支援就算了 */ } }
addEventListener('pointerdown', keepAwake, { once: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { S.hiddenAt = performance.now(); return; }
  keepAwake();
  if (S.hiddenAt && S.tel && S.tel.flying && isPilot()) {
    toast('warn', '分頁曾在背景', '背景期間無法送出控制，無人機已自動懸停');
  }
  S.hiddenAt = 0;
});
// 防止返回手勢／Backspace 把頁面帶走
history.pushState(null, '', location.href);
addEventListener('popstate', () => history.pushState(null, '', location.href));
addEventListener('beforeunload', (e) => { if (S.tel && S.tel.flying && isPilot()) { e.preventDefault(); e.returnValue = ''; } });

if (!window.isSecureContext) {
  toast('danger', '請改用 http://localhost:8080 開啟', '目前網址不是 secure context，手把與 WebCodecs 可能無法使用', 15000);
}

// 給 E2E 測試讀取狀態（不影響功能）
window.__gcs = { S, get settings() { return settings; }, sock, player, follow, openMission, runMission, voice, track };
render();
