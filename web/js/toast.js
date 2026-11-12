// Toast：一律「圖示＋粗體標題＋文字」，不只靠顏色。
const ICON = { ok: 'i-ok', warn: 'i-warn', danger: 'i-danger', info: 'i-info' };
const box = () => document.getElementById('toasts');

export function toast(level, title, text = '', ms) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.level = level === 'info' ? 'none' : level;
  el.setAttribute('role', level === 'danger' ? 'alert' : 'status');
  el.innerHTML = `<svg><use href="#${ICON[level] || ICON.info}"/></svg><div><b></b><span></span></div>`;
  el.querySelector('b').textContent = title;
  el.querySelector('span').textContent = text;
  const b = box();
  b.prepend(el);
  while (b.children.length > 3) b.lastChild.remove();
  const life = ms || (level === 'danger' ? 8000 : level === 'warn' ? 6000 : 3500);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, life);
  return el;
}
