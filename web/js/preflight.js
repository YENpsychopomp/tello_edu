// 飛前檢查：全部通過才允許起飛。純函式，回傳每一項的狀態與原因。
export const MIN_TAKEOFF_BATTERY = 20;

export function evaluatePreflight({ wsOpen, tel, pad, sticksCentered, isPilot }) {
  const items = [];
  const connected = !!(wsOpen && tel && tel.connected);
  items.push({
    id: 'tello', ok: connected, title: 'Tello 已連線',
    detail: !wsOpen ? '本機程式未連線'
      : connected ? (tel.sim ? '模擬器' : `狀態封包 ${tel.state_pps ?? '--'}/秒`)
        : (tel && tel.sdk ? '有回應但沒有狀態封包 → 診斷頁' : '確認 Wi-Fi 連到 TELLO-XXXXXX'),
  });
  const bat = tel && Number.isFinite(tel.bat) ? tel.bat : null;
  items.push({
    id: 'battery', ok: connected && bat !== null && bat > MIN_TAKEOFF_BATTERY,
    title: `電量 > ${MIN_TAKEOFF_BATTERY}%`,
    detail: bat === null ? '尚未取得電量' : `目前 ${bat}%${bat <= MIN_TAKEOFF_BATTERY ? '，請換電池' : ''}`,
  });
  items.push({
    id: 'gamepad', ok: !!pad.connected, title: '手把已偵測',
    detail: pad.connected ? (pad.mapping === 'standard' ? shortId(pad.id) : `${shortId(pad.id)}（非標準按鍵對應）`)
      : '按一下手把任一鍵讓瀏覽器偵測（Chrome / Edge）',
  });
  items.push({
    id: 'sticks', ok: !!pad.connected && sticksCentered, title: '兩支搖桿都置中',
    detail: !pad.connected ? '等待手把' : sticksCentered ? '置中' : '放開搖桿，讓它們回到中心',
  });
  const pass = items.every((i) => i.ok);
  const failed = items.filter((i) => !i.ok);
  let summary;
  if (!isPilot) summary = { level: 'warn', text: '觀看模式：需要先接管控制' };
  else if (pass) summary = { level: 'ok', text: '全部通過，可以起飛' };
  else summary = { level: 'warn', text: `尚有 ${failed.length} 項未通過` };
  return { items, pass: pass && isPilot, failed, summary };
}

export function shortId(id) {
  if (!id) return '';
  const s = id.replace(/\s*\(.*?Vendor.*?\)\s*/i, ' ').replace(/\s+/g, ' ').trim();
  return s.length > 34 ? `${s.slice(0, 33)}…` : s;
}
