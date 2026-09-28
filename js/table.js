import { applyH } from './homography.js';

// 寸法はすべて mm。台の座標系は左上原点、x = 長辺方向、y = 短辺方向 (クッションのノーズ間)。
export const BALL_DIAMETER = 57.15;
export const BALL_R = BALL_DIAMETER / 2;

export const TABLE_PRESETS = {
  '9ft': { label: '9ft (2540×1270)', length: 2540, width: 1270 },
  '8ft': { label: '8ft (2240×1120)', length: 2240, width: 1120 },
  '7ft': { label: '7ft (1980×990)', length: 1980, width: 990 },
  custom: { label: 'カスタム', length: 2540, width: 1270 },
};

const COLORS = ['#f5f3ea', '#f2c318', '#1d4fbf', '#d42a2a', '#5b2a86', '#f07c1e', '#1d8a4a', '#7a2a1f', '#111111'];
export const BALL_DEFS = {};
for (let n = 0; n <= 15; n++) {
  BALL_DEFS[n] = { n, color: n <= 8 ? COLORS[n] : COLORS[n - 8], stripe: n > 8 };
}
export const ballDef = (n) => BALL_DEFS[n] ?? { n: -1, color: '#9aa0a6', stripe: false };
export const ballName = (n) => (n === 0 ? '手球' : n > 0 ? String(n) : '?');

export function tableCorners(L, W) {
  return [[0, 0], [L, 0], [L, W], [0, W]];
}

export function drawBall(ctx, cx, cy, r, n, { selected = false, alpha = 1 } = {}) {
  const d = ballDef(n);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = d.stripe ? COLORS[0] : d.color;
  ctx.fill();
  if (d.stripe) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = d.color;
    ctx.fillRect(cx - r, cy - r * 0.55, 2 * r, r * 1.1);
    ctx.restore();
  }
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
  g.addColorStop(0, 'rgba(255,255,255,.45)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,.35)');
  ctx.fillStyle = g;
  ctx.fill();
  if (n !== 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = `bold ${r * 0.62}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n > 0 ? String(n) : '?', cx, cy + r * 0.04);
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.stroke();
  if (selected) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.15);
    ctx.strokeStyle = '#00e5ff';
    ctx.stroke();
  }
  ctx.restore();
}

// 真上から見た仮想台
export class TopView {
  constructor(canvas, pxWidth = 1400) {
    this.canvas = canvas;
    this.pxWidth = pxWidth;
  }

  setTable(L, W) {
    this.L = L;
    this.W = W;
    this.rail = L * 0.055;
    this.s = this.pxWidth / (L + 2 * this.rail);
    this.canvas.width = this.pxWidth;
    this.canvas.height = Math.round((W + 2 * this.rail) * this.s);
  }

  // 背景用に補正画像を作る範囲 (mm)
  get extent() {
    return { x0: -this.rail, y0: -this.rail, x1: this.L + this.rail, y1: this.W + this.rail };
  }

  toCanvas(x, y) {
    return [(x + this.rail) * this.s, (y + this.rail) * this.s];
  }

  toTable(px, py) {
    return [px / this.s - this.rail, py / this.s - this.rail];
  }

  // クライアント座標 -> 台座標
  eventToTable(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const py = ((e.clientY - r.top) * this.canvas.height) / r.height;
    return this.toTable(px, py);
  }

  render({ balls, selected = -1, bg = null, ballAlpha = 1 }) {
    const { canvas, L, W, rail, s } = this;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (bg) {
      ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#5a3a22';
      roundRect(ctx, 0, 0, canvas.width, canvas.height, rail * s * 0.4);
      ctx.fill();
      ctx.fillStyle = '#0f6b45';
      ctx.fillRect(rail * s, rail * s, L * s, W * s);
    }

    // クッションライン
    ctx.strokeStyle = bg ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(rail * s, rail * s, L * s, W * s);

    // ポケット
    const pr = 60 * s;
    ctx.fillStyle = bg ? 'rgba(0,0,0,.35)' : '#111';
    for (const [x, y] of [[0, 0], [L / 2, 0], [L, 0], [0, W], [L / 2, W], [L, W]]) {
      const [cx, cy] = this.toCanvas(x, y);
      const dy = y === 0 ? -pr * 0.4 : pr * 0.4;
      ctx.beginPath();
      ctx.arc(cx, cy + (x === L / 2 ? dy : 0), pr, 0, Math.PI * 2);
      ctx.fill();
    }

    // ダイヤモンド
    ctx.fillStyle = bg ? '#fff' : '#e8dcc0';
    const dia = (x, y) => {
      const [cx, cy] = this.toCanvas(x, y);
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
    };
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      dia((L * i) / 8, -rail / 2);
      dia((L * i) / 8, W + rail / 2);
    }
    for (let i = 1; i < 4; i++) {
      dia(-rail / 2, (W * i) / 4);
      dia(L + rail / 2, (W * i) / 4);
    }

    // ヘッドストリング / スポット
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    const [hx0, hy0] = this.toCanvas(L / 4, 0);
    const [, hy1] = this.toCanvas(L / 4, W);
    ctx.moveTo(hx0, hy0);
    ctx.lineTo(hx0, hy1);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const x of [L / 4, (L * 3) / 4]) {
      const [cx, cy] = this.toCanvas(x, W / 2);
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    balls.forEach((b, i) => {
      const [cx, cy] = this.toCanvas(b.x, b.y);
      drawBall(ctx, cx, cy, BALL_R * s, b.n, { selected: i === selected, alpha: ballAlpha });
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// カメラ画像上に仮想台を射影して重ねる。Ht2i: 台座標 -> 画像座標
export function renderOverlay(ctx, Ht2i, L, W, balls, opt) {
  const P = (x, y) => applyH(Ht2i, x, y);
  const lw = Math.max(1.5, ctx.canvas.width / 700);
  ctx.save();

  if (opt.showTable) {
    ctx.globalAlpha = opt.opacity;
    const poly = tableCorners(L, W).map(([x, y]) => P(x, y));
    ctx.fillStyle = 'rgba(0,200,255,.08)';
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = lw * 1.5;
    path(ctx, poly, true);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0,229,255,.55)';
    ctx.lineWidth = lw * 0.6;
    for (let i = 1; i < 8; i++) path(ctx, [P((L * i) / 8, 0), P((L * i) / 8, W)]), ctx.stroke();
    for (let i = 1; i < 4; i++) path(ctx, [P(0, (W * i) / 4), P(L, (W * i) / 4)]), ctx.stroke();
  }

  if (opt.showBalls) {
    balls.forEach((b, idx) => {
      const pts = [];
      for (let k = 0; k < 28; k++) {
        const a = (k / 28) * Math.PI * 2;
        pts.push(P(b.x + BALL_R * Math.cos(a), b.y + BALL_R * Math.sin(a)));
      }
      const d = ballDef(b.n);
      ctx.globalAlpha = opt.opacity;
      path(ctx, pts, true);
      ctx.fillStyle = d.color;
      ctx.fill();
      ctx.globalAlpha = Math.min(1, opt.opacity + 0.3);
      ctx.lineWidth = lw * 2.4;
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.stroke();
      ctx.lineWidth = lw * 1.2;
      ctx.strokeStyle = idx === opt.selected ? '#00e5ff' : d.stripe ? '#fff' : '#ffe680';
      ctx.stroke();

      if (opt.showLabels) {
        const [cx, cy] = P(b.x, b.y);
        const top = Math.min(...pts.map((p) => p[1]));
        const fs = Math.max(12, ctx.canvas.width / 70);
        ctx.globalAlpha = 1;
        ctx.font = `bold ${fs}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = fs / 5;
        ctx.strokeStyle = '#000';
        const t = ballName(b.n);
        ctx.strokeText(t, cx, top - 4);
        ctx.fillStyle = '#fff';
        ctx.fillText(t, cx, top - 4);
      }
    });
  }
  ctx.restore();
}

function path(ctx, pts, close = false) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
}

// カメラ画像を台座標の真上視点に補正する (最近傍サンプリング)
export function rectify(src, Ht2i, extent, outW, outH) {
  const out = new ImageData(outW, outH);
  const sd = src.data, od = out.data, sw = src.width, sh = src.height;
  const [a, b, c, d, e, f, g, h, i] = Ht2i;
  const sx = (extent.x1 - extent.x0) / outW;
  const sy = (extent.y1 - extent.y0) / outH;
  let o = 0;
  for (let py = 0; py < outH; py++) {
    const ty = extent.y0 + (py + 0.5) * sy;
    for (let px = 0; px < outW; px++, o += 4) {
      const tx = extent.x0 + (px + 0.5) * sx;
      const w = g * tx + h * ty + i;
      const u = ((a * tx + b * ty + c) / w) | 0;
      const v = ((d * tx + e * ty + f) / w) | 0;
      if (w <= 0 || u < 0 || v < 0 || u >= sw || v >= sh) {
        od[o + 3] = 255;
        continue;
      }
      const s = (v * sw + u) * 4;
      od[o] = sd[s];
      od[o + 1] = sd[s + 1];
      od[o + 2] = sd[s + 2];
      od[o + 3] = 255;
    }
  }
  return out;
}
