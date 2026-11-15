// 航跡推算（dead reckoning）：用遙測的機身速度 vgx/vgy（dm/s）與航向 yaw 積分出相對起飛點的位置，畫成北朝上的小地圖。
// 沒有 GPS，光流速度會漂，只當「大概在哪、起點在哪個方向」的參考；起飛時歸零。
export const SPEED_UNIT = 0.1;   // dm/s → m/s（與後端 flightlog 一致）

export class Track {
  constructor({ maxPoints = 4000, minStep = 0.05 } = {}) {
    this.maxPoints = maxPoints;
    this.minStep = minStep;        // 走了這麼多公尺才多記一個點（m）
    this.reset();
  }

  reset() {
    this.x = 0; this.y = 0;        // m；x 東（畫面右）、y 北（畫面上）
    this.yaw = 0;
    this.points = [[0, 0]];
    this.last = null;              // 上一筆的時間（ms）
    this.wasFlying = false;
    this.dist = 0;                 // 累計里程（m）
  }

  /** tel：{ vgx, vgy, yaw, flying }；now：ms。回傳 true 代表這一筆有積分。 */
  update(tel, now) {
    if (!tel) { this.last = null; return false; }
    const flying = !!tel.flying;
    if (flying && !this.wasFlying) this.reset();      // 起飛 → 以這裡為起點
    this.wasFlying = flying;
    if (Number.isFinite(tel.yaw)) this.yaw = tel.yaw;
    if (!flying) { this.last = now; return false; }
    const dt = this.last == null ? 0 : (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0) || dt > 1) return false;            // 第一筆或遙測中斷太久：不積分
    const vx = Number.isFinite(tel.vgx) ? tel.vgx * SPEED_UNIT : 0;   // 機身前方
    const vy = Number.isFinite(tel.vgy) ? tel.vgy * SPEED_UNIT : 0;   // 機身右方
    if (!vx && !vy) return false;
    const th = (this.yaw * Math.PI) / 180;            // yaw 順時針為正、0 = 北
    const fx = Math.sin(th), fy = Math.cos(th);       // 機頭方向（東、北分量）
    const rx = Math.cos(th), ry = -Math.sin(th);      // 機身右方
    const dx = (vx * fx + vy * rx) * dt, dy = (vx * fy + vy * ry) * dt;
    this.x += dx; this.y += dy;
    this.dist += Math.hypot(dx, dy);
    const [px, py] = this.points[this.points.length - 1];
    if (Math.hypot(this.x - px, this.y - py) >= this.minStep) {
      this.points.push([this.x, this.y]);
      if (this.points.length > this.maxPoints) this.points.splice(1, 1);   // 保留起點
    }
    return true;
  }

  /** 離起點的距離（m）與起點相對機頭的方位（度，順時針，0 = 正前方）。 */
  home() {
    const d = Math.hypot(this.x, this.y);
    if (d < 0.05) return { dist: d, bearing: 0 };
    const toHome = (Math.atan2(-this.x, -this.y) * 180) / Math.PI;     // 從目前位置指向起點的方位（0 = 北）
    let rel = toHome - this.yaw;
    rel = ((rel % 360) + 540) % 360 - 180;
    return { dist: d, bearing: rel };
  }
}

/** 把航跡畫到 canvas：北朝上、自動縮放（至少 ±2 m）、格線每 1 m、起點、路徑、機身三角形。 */
export function drawTrack(ctx, track, { w, h, colors = {} } = {}) {
  const c = {
    bg: colors.bg || '#0E1419', grid: colors.grid || '#1F2A33', path: colors.path || '#5CB3FF',
    home: colors.home || '#3DDC84', drone: colors.drone || '#FFFFFF', text: colors.text || '#8A98A6',
  };
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = c.bg; ctx.fillRect(0, 0, w, h);
  let span = 2;
  for (const [x, y] of track.points) span = Math.max(span, Math.abs(x), Math.abs(y));
  span = Math.max(span, Math.abs(track.x), Math.abs(track.y)) * 1.15;
  const scale = Math.min(w, h) / 2 / span;      // px per m
  const cx = w / 2, cy = h / 2;
  const X = (x) => cx + x * scale, Y = (y) => cy - y * scale;
  // 格線：每 1 m（太密就每 5 m）
  const step = span > 12 ? 5 : 1;
  ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = -Math.ceil(span); g <= Math.ceil(span); g += step) {
    ctx.moveTo(X(g), 0); ctx.lineTo(X(g), h);
    ctx.moveTo(0, Y(g)); ctx.lineTo(w, Y(g));
  }
  ctx.stroke();
  ctx.fillStyle = c.text; ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'top';
  ctx.fillText(`${step} m 格`, 4, 4);
  ctx.textAlign = 'right'; ctx.fillText('北 ↑', w - 4, 4); ctx.textAlign = 'left';
  // 路徑
  if (track.points.length > 1) {
    ctx.strokeStyle = c.path; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    track.points.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.lineTo(X(track.x), Y(track.y));
    ctx.stroke();
  }
  // 起點
  ctx.strokeStyle = c.home; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(X(0), Y(0), 5, 0, Math.PI * 2); ctx.stroke();
  // 機身：三角形指向航向
  const th = (track.yaw * Math.PI) / 180;
  const dx = X(track.x), dy = Y(track.y);
  ctx.save();
  ctx.translate(dx, dy); ctx.rotate(th);
  ctx.fillStyle = c.drone;
  ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5.5, 6); ctx.closePath(); ctx.fill();
  ctx.restore();
}
