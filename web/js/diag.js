// 診斷頁：即時數值＋任何異常都給出具體的排除建議。
import { ControlSocket } from './ws.js';

const $ = (id) => document.getElementById(id);
const MARK = { ok: '✓', warn: '▲', danger: '✕', none: '•' };
const H = { stateWas: false, videoWas: false, streamOnAt: 0, d: null, wsRtt: null, decodeOk: null };

function dl(id, rows) {
  $(id).replaceChildren(...rows.flatMap(([k, v, cls]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v ?? '--'; if (cls) dd.className = cls;
    return [dt, dd];
  }));
}
function card(id, level, status) {
  const c = $(id);
  c.dataset.level = level;
  c.querySelector('h2').dataset.status = `${MARK[level]} ${status}`;
}

// ---------- WebSocket（monitor 模式：只看，不會成為機長）
let lastPing = 0;
const sock = new ControlSocket('/ws/control?monitor=1', {
  onState: () => {},
  onMessage: (m) => {
    if (m.t === 'pong' && m.ts) H.wsRtt = performance.now() - m.ts;
    if (m.t === 'tel') H.tel = m;
  },
});
setInterval(() => { if (sock.open) { lastPing = performance.now(); sock.send({ t: 'ping', ts: lastPing }); } }, 1000);

// ---------- 瀏覽器能力
async function browserCaps() {
  const caps = {
    secure: window.isSecureContext,
    gamepad: typeof navigator.getGamepads === 'function',
    webcodecs: typeof window.VideoDecoder === 'function',
    recorder: typeof window.MediaRecorder === 'function',
    h264: null,
  };
  if (caps.webcodecs) {
    try {
      const r = await VideoDecoder.isConfigSupported({ codec: 'avc1.4d401f', optimizeForLatency: true });
      caps.h264 = r.supported;
    } catch (e) { caps.h264 = false; }
  }
  return caps;
}
let CAPS = null;
browserCaps().then((c) => { CAPS = c; });

// ---------- 輪詢後端
async function poll() {
  try {
    const r = await fetch('/api/diag', { cache: 'no-store' });
    H.d = await r.json();
    H.fetchOk = true;
  } catch (e) {
    H.fetchOk = false;
  }
  render();
}
setInterval(poll, 1000);
poll();

function render() {
  const d = H.d;
  const advice = [];
  const add = (level, title, text) => advice.push({ level, title, text });

  // ---------- 後端是否活著
  if (!H.fetchOk || !d) {
    add('danger', '地面站程式沒有回應', 'Docker：執行 docker compose ps 確認容器在跑；原生模式：確認終端機視窗沒有關掉。');
  }

  if (d) {
    $('dgEnv').textContent = `v${d.env.version} · ${d.env.sim ? '模擬器模式' : d.env.in_docker ? 'Docker 模式' : '原生模式'} · Tello ${d.link.target}${d.link.target_ip ? `（${d.link.target_ip}）` : ''}`;
    const c = d.cmd, st = d.state, v = d.video;

    // ---------- 指令
    const cmdOk = c.ever_resp && (c.rtt_ms != null);
    const lastTimeout = c.last_resp === 'timeout';
    const cmdLevel = !c.sent ? 'warn' : (cmdOk && !lastTimeout) ? (c.rtt_ms > 200 ? 'warn' : 'ok') : 'danger';
    card('cardCmd', cmdLevel, cmdLevel === 'ok' ? '正常' : !c.sent ? '尚未送出' : lastTimeout ? '沒有回應' : 'RTT 偏高');
    dl('dlCmd', [
      ['最近 RTT', c.rtt_ms != null ? `${c.rtt_ms} ms` : '--', 'big'],
      ['平均 / 最大', c.rtt_avg_ms != null ? `${c.rtt_avg_ms} / ${c.rtt_max_ms} ms` : '--'],
      ['送出 / 成功 / 逾時 / 錯誤', `${c.sent} / ${c.ok} / ${c.timeouts} / ${c.errors}`],
      ['最後指令', c.last_cmd ? `${c.last_cmd} → ${c.last_resp}` : '--'],
      ['SDK 模式', d.link.sdk ? '是' : '否'],
      ['網路錯誤', c.net_error || '無'],
    ]);

    // ---------- 狀態
    if (st.pps > 0) H.stateWas = true;
    const stLevel = st.pps >= 7 ? 'ok' : st.pps > 0 ? 'warn' : 'danger';
    card('cardState', stLevel, st.pps >= 7 ? '正常' : st.pps > 0 ? '掉封包' : '沒有收到');
    dl('dlState', [
      ['每秒封包數', `${st.pps}`, 'big'],
      ['最後一個距今', st.age != null ? `${st.age} 秒` : '從未收到'],
      ['累計', String(st.total)],
      ['來源', st.source || '--'],
      ['本機監聽', `UDP ${d.link.state_port}`],
    ]);

    // ---------- 影像
    if (v.pps > 0) H.videoWas = true;
    const vidLevel = v.pps > 0 ? (v.keyframes > 0 ? 'ok' : 'warn') : (H.videoWas ? 'danger' : 'none');
    card('cardVideo', vidLevel, v.pps > 0 ? (v.keyframes > 0 ? '正常' : '等待關鍵幀') : H.videoWas ? '中斷' : '未開啟');
    dl('dlVideo', [
      ['每秒封包數', `${v.pps}`, 'big'],
      ['位元率', `${v.kbps} kbps`],
      ['重組後 fps', `${v.fps}`],
      ['關鍵幀 (IDR) 累計', String(v.keyframes)],
      ['codec', v.codec || '--'],
      ['丟幀（塞車）', String(v.drops)],
      ['WebSocket 觀看數', String(d.ws.video)],
      ['MJPEG 備援', d.env.ffmpeg ? (v.ffmpeg_running ? '執行中' : '待命') : '無 ffmpeg'],
      ['來源', v.source || '--'],
    ]);

    // ---------- 啟動檢查
    $('ulChecks').replaceChildren(...d.checks.map((ck) => {
      const li = document.createElement('li');
      li.dataset.level = ck.level;
      li.textContent = `${MARK[ck.level]} ${ck.title}`;
      if (ck.detail) { const s = document.createElement('small'); s.textContent = ck.detail; li.append(s); }
      return li;
    }));
    const worst = d.checks.some((x) => x.level === 'danger') ? 'danger' : d.checks.some((x) => x.level === 'warn') ? 'warn' : 'ok';
    card('cardChecks', worst, worst === 'ok' ? '全部通過' : '有警告');
    d.checks.filter((x) => x.level !== 'ok').forEach((x) => add(x.level, x.title, x.detail));

    // ---------- 規則式排除建議
    const docker = d.env.in_docker;
    if (c.sent && !c.ever_resp) {
      add('danger', '送出指令但 Tello 完全沒有回應',
        `確認：① 電腦 Wi-Fi 連到 TELLO-XXXXXX ② Tello 已開機（燈號閃黃） ③ 沒有其他程式（TelloFPV、官方 App、另一個地面站）同時連線。${docker ? 'Docker 模式下若一直不通，改用原生模式（start-windows.bat / start-mac.command）。' : ''}`);
    }
    const fwBlock = d.checks.find((x) => x.id === 'firewall' && !x.ok);
    if (c.ever_resp && st.total === 0 && fwBlock) {
      add('danger', '有指令回應，但收不到狀態封包 → 已確認是 Windows 防火牆的封鎖規則',
        '這台電腦的防火牆有「封鎖」這個 Python 入站連線的規則（多半是第一次執行時跳出的安全性警訊被取消）。封鎖規則優先於允許規則：以系統管理員開 PowerShell，在專案資料夾執行 powershell -ExecutionPolicy Bypass -File scripts\\allow-firewall.ps1，然後重新啟動地面站。');
    } else if (c.ever_resp && st.total === 0) {
      add('danger', '有指令回應，但收不到狀態封包',
        `多半是防火牆擋了入站 UDP 8890。Windows：TELLO 的 Wi-Fi 被歸類成「公用網路」→ 改成「私人」，或允許 ${docker ? 'com.docker.backend.exe' : 'python.exe'} 在公用網路通訊（見 README）。macOS：系統設定 → 網路 → 防火牆，允許 Python 接受連入。${docker ? 'Docker Desktop 的 UDP 轉發也可能收不到 Tello 主動送來的封包 → 改用原生模式。' : ''}`);
    }
    if (H.stateWas && st.pps === 0 && c.ever_resp && !lastTimeout) {
      add('danger', '狀態封包原本有、後來中斷，但指令還有回應',
        docker ? 'Docker Desktop 的 UDP NAT 逾時（使用者空間轉發會丟掉閒置的對應）。重啟容器（docker compose restart）可暫時恢復；長期請改用原生模式或 compose.host.yml。'
          : '可能是 Wi-Fi 干擾或 Tello 過熱重開。靠近一點、檢查溫度。');
    }
    if (H.stateWas && st.pps === 0 && lastTimeout) {
      add('danger', 'Tello 整個斷線', '電池沒電／換電池中，或 Wi-Fi 斷了。重新開機後程式會自動重連（約 1–3 秒）。');
    }
    if (st.pps > 0 && st.pps < 7) add('warn', '狀態封包掉包（正常約 10 個/秒）', 'Wi-Fi 干擾或距離太遠：靠近 Tello、避開 2.4 GHz 擁擠的環境（微波爐、其他 AP）。');
    if (c.rtt_ms != null && c.rtt_ms > 200) add('warn', `指令 RTT ${c.rtt_ms} ms 偏高`, '一般在 10–60 ms。偏高代表 Wi-Fi 品質差；Docker Desktop 也會多一點延遲。');
    if (H.tel && H.tel.wifi != null && H.tel.wifi < 30) add('warn', `Wi-Fi 訊號弱（${H.tel.wifi}）`, '靠近 Tello，避免金屬或人體擋在中間。');
    if (c.last_cmd === 'streamon' && c.last_resp === 'ok' && v.total === 0) {
      add('danger', 'streamon 成功，但收不到影像封包',
        `防火牆擋了入站 UDP 11111（同狀態封包的解法）。${docker ? 'Docker Desktop 對 11111/udp 的轉發不通時，改用原生模式。' : ''}`);
    }
    if (v.pps > 0 && v.keyframes === 0) add('warn', '有影像封包但還沒收到關鍵幀', '正常情況下 1–2 秒內會出現；一直沒有的話關掉再開影像（Y）。');
    if (v.drops > 0) add('warn', `影像塞車丟幀 ${v.drops} 次`, '瀏覽器解碼跟不上；關掉其他分頁或改用有硬體解碼的 Chrome / Edge。');
    if (d.link.silenced) add('danger', '自動降落已放棄，停止送出指令', 'Tello 會在 15 秒內自行降落。重新連上控制頁後會恢復。');
  }

  // ---------- WebSocket
  const wsLevel = sock.state === 'open' ? 'ok' : sock.everOpen ? 'danger' : 'warn';
  card('cardWs', wsLevel, sock.state === 'open' ? '已連線' : sock.state === 'connecting' ? '連線中' : '中斷');
  dl('dlWs', [
    ['控制 WebSocket', sock.state === 'open' ? '已連線' : sock.state],
    ['往返延遲', H.wsRtt != null ? `${H.wsRtt.toFixed(1)} ms` : '--'],
    ['控制頁數（含本頁）', d ? String(d.ws.control) : '--'],
    ['機長', d ? (d.pilot ? `分頁 #${d.pilot}` : '無') : '--'],
    ['影像 WebSocket', d ? String(d.ws.video) : '--'],
    ['MJPEG 連線', d ? String(d.ws.mjpeg) : '--'],
    ['頁面網址', location.origin],
  ]);
  if (sock.state !== 'open' && sock.everOpen) add('danger', 'WebSocket 中斷', '地面站程式可能已結束或重啟中。');
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    add('danger', '請用 http://localhost:8080 開啟', '用 IP 或其他主機名稱開啟會被 Origin 檢查拒絕，而且不是 secure context。');
  }

  // ---------- 瀏覽器
  if (CAPS) {
    const lvl = !CAPS.secure || !CAPS.gamepad ? 'danger' : !CAPS.webcodecs || CAPS.h264 === false ? 'warn' : 'ok';
    card('cardBrowser', lvl, lvl === 'ok' ? '全部支援' : '有缺項');
    dl('dlBrowser', [
      ['Secure context', CAPS.secure ? '是' : '否（請用 localhost）'],
      ['Gamepad API', CAPS.gamepad ? '支援' : '不支援'],
      ['WebCodecs', CAPS.webcodecs ? '支援' : '不支援'],
      ['H.264 硬體/軟體解碼', CAPS.h264 == null ? '--' : CAPS.h264 ? '支援' : '不支援'],
      ['MediaRecorder（錄影）', CAPS.recorder ? '支援' : '不支援'],
      ['User agent', navigator.userAgent.replace(/^Mozilla\/5\.0 /, '')],
    ]);
    if (!CAPS.secure) add('danger', '不是 secure context', '請用 http://localhost:8080 開啟（不要用 IP）。');
    if (!CAPS.webcodecs || CAPS.h264 === false) add('warn', '瀏覽器無法用 WebCodecs 解 H.264', '影像會自動改用 MJPEG 備援（延遲較高，需要 ffmpeg）。建議使用最新版 Chrome 或 Edge。');
  }

  renderPad(add);

  // ---------- 建議清單
  if (!advice.length) advice.push({ level: 'ok', title: '一切正常', text: '沒有偵測到問題。' });
  const order = { danger: 0, warn: 1, ok: 2, none: 3 };
  advice.sort((a, b) => order[a.level] - order[b.level]);
  $('adviceList').replaceChildren(...advice.map((a) => {
    const li = document.createElement('li');
    li.dataset.level = a.level;
    const b = document.createElement('b'); b.dataset.mark = MARK[a.level]; b.textContent = a.title;
    const s = document.createElement('span'); s.textContent = a.text || '';
    li.append(b, s);
    return li;
  }));
}

function renderPad(add) {
  let pads = [];
  try { pads = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean); } catch (e) {}
  const gp = pads.find((p) => p.connected);
  if (!gp) {
    card('cardPad', 'warn', '未偵測到');
    dl('dlPad', [['狀態', '未偵測到手把']]);
    $('axes').replaceChildren(); $('buttons').replaceChildren();
    add('warn', '沒有偵測到手把', '瀏覽器規定要先在頁面上按一下手把任一鍵才會出現。Windows 10/11 原生支援；macOS 需要 15 Sequoia 以上才支援有線 Xbox 手把。');
    return;
  }
  const std = gp.mapping === 'standard';
  card('cardPad', std ? 'ok' : 'warn', std ? '標準對應' : '非標準對應');
  dl('dlPad', [['id', gp.id], ['mapping', gp.mapping || '（空白）'], ['index', String(gp.index)],
    ['震動', gp.vibrationActuator ? '支援' : '不支援（會改用畫面提示）'], ['手把數量', String(pads.length)]]);
  if (!std) add('warn', '手把不是標準 mapping', '按鍵位置可能錯亂。建議用有線 Xbox 手把＋Chrome / Edge。');
  const names = ['左 X', '左 Y', '右 X', '右 Y'];
  $('axes').replaceChildren(...gp.axes.map((v, i) => {
    const d = document.createElement('div'); d.className = 'axis';
    const pct = Math.abs(v) * 50;
    d.innerHTML = `<div>axes[${i}] ${names[i] || ''}：<b>${v.toFixed(3)}</b></div><div class="bar"><i style="left:${v < 0 ? 50 - pct : 50}%;width:${pct}%"></i></div>`;
    return d;
  }));
  const bn = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', '↑', '↓', '←', '→', 'Xbox'];
  $('buttons').replaceChildren(...gp.buttons.map((b, i) => {
    const d = document.createElement('div');
    d.className = `btnc${b.pressed ? ' on' : ''}`;
    d.textContent = `${i} ${bn[i] || ''} ${b.value.toFixed(2)}`;
    return d;
  }));
  const drift = gp.axes.slice(0, 4).some((v) => Math.abs(v) > 0.12);
  if (drift) add('warn', '搖桿沒有回到中心（> 死區 0.12）', '放開搖桿後若仍有數值，代表搖桿飄移；到設定裡把死區調大。');
}

// 手把數值要即時更新
(function loop() { if (H.d || !H.fetchOk) renderPadOnly(); requestAnimationFrame(loop); })();
function renderPadOnly() { renderPad(() => {}); }
