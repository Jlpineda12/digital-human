// 2D "Grease Pencil" layer drawn over the 3D render: hand-drawn strokes that
// boil at 12 fps (like animated pencil lines), emotion doodles that float
// around the head, listening waves and a sketchy speech bubble with subtitles.
const TAU = Math.PI * 2;

export class Doodles {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.emotionT = 0;
    this.emotion = 'neutral';
    this.subtitle = '';
    this.subtitleT = 0;
  }

  resize(w, h, dpr) {
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
  }

  setEmotion(e) {
    if (e !== this.emotion) { this.emotion = e; this.emotionT = 0; }
  }

  setSubtitle(text) { this.subtitle = text; this.subtitleT = 0; }

  rnd(i) {
    const s = Math.sin(i * 91.17 + this.boil * 47.3) * 43758.5453;
    return s - Math.floor(s) - 0.5;
  }

  // a pencil stroke through points with per-frame jitter and tapered width
  stroke(points, { color = '#3a2e2e', width = 4, jitter = 1.6, seed = 0, close = false } = {}) {
    const { ctx } = this;
    const pts = points.map(([x, y], i) => [x + this.rnd(seed + i) * jitter, y + this.rnd(seed + i + 50) * jitter]);
    if (close) pts.push(pts[0]);
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {       // double pass = pencil texture
      ctx.lineWidth = width * (pass ? 0.55 : 1);
      ctx.globalAlpha = pass ? 0.5 : 0.95;
      ctx.beginPath();
      ctx.moveTo(pts[0][0] + pass, pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0] + pass, pts[i][1], mx + pass, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last[0] + pass, last[1]);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  circlePts(cx, cy, rx, ry, n = 18, start = 0, end = TAU) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = start + (end - start) * (i / n);
      out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    return out;
  }

  /**
   * @param {object} s  {time, dt, head:{x,y,r}, emotion, listening, thinking, level}
   */
  draw(s) {
    const { ctx } = this;
    const d = this.dpr || 1;
    this.boil = Math.floor(s.time * 12);
    this.emotionT += s.dt;
    this.subtitleT += s.dt;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const { x, y, r } = s.head;
    const pop = Math.min(1, this.emotionT * 4);         // doodles pop in
    const k = 1 - (1 - pop) ** 3;
    const col = '#6b4b4b';

    if (s.thinking) {
      // thought bubble with three dots
      const bx = x + r * 1.15;
      const by = y - r * 1.05;
      this.stroke(this.circlePts(x + r * 0.62, y - r * 0.55, 7, 7, 10), { color: col, width: 3, seed: 1 });
      this.stroke(this.circlePts(x + r * 0.82, y - r * 0.8, 11, 11, 12), { color: col, width: 3, seed: 2 });
      this.stroke(this.circlePts(bx, by, r * 0.42, r * 0.28, 22), { color: col, width: 3.5, seed: 3 });
      for (let i = 0; i < 3; i++) {
        const on = Math.floor(s.time * 3) % 3 >= i;
        ctx.fillStyle = on ? '#ff5d8f' : 'rgba(107,75,75,0.3)';
        ctx.beginPath();
        ctx.arc(bx - r * 0.18 + i * r * 0.18, by, 6, 0, TAU);
        ctx.fill();
      }
    } else if (this.emotion === 'alegria') {
      for (let i = 0; i < 3; i++) {
        const a = -0.5 - i * 0.55;
        const cx = x + Math.cos(a) * r * 1.25;
        const cy = y + Math.sin(a) * r * 1.15;
        const sz = (14 + i * 4) * k * (1 + 0.15 * Math.sin(s.time * 6 + i));
        this.star(cx, cy, sz, i, ['#ffb000', '#ff5d8f', '#00c2a8'][i]);
      }
    } else if (this.emotion === 'sorpresa') {
      const cx = x + r * 1.05;
      const cy = y - r * 0.95;
      this.stroke([[cx, cy - 34 * k], [cx + 3, cy + 6 * k]], { color: '#ff5d8f', width: 8, seed: 4 });
      ctx.fillStyle = '#ff5d8f';
      ctx.beginPath(); ctx.arc(cx + 3, cy + 22 * k, 6, 0, TAU); ctx.fill();
      for (let i = 0; i < 3; i++) {
        const a = -2.2 + i * 0.35;
        this.stroke([[x + Math.cos(a) * r * 1.02, y + Math.sin(a) * r * 1.02],
                     [x + Math.cos(a) * r * (1.02 + 0.22 * k), y + Math.sin(a) * r * (1.02 + 0.22 * k)]],
                    { color: col, width: 4, seed: 10 + i });
      }
    } else if (this.emotion === 'duda') {
      const cx = x + r * 1.08;
      const cy = y - r * 0.85;
      const q = [[-12, -16], [-6, -26], [8, -27], [15, -16], [10, -6], [2, 0], [1, 10]].map(([a, b]) => [cx + a * 1.3 * k, cy + b * 1.3 * k]);
      this.stroke(q, { color: '#7a5cff', width: 6, seed: 20 });
      ctx.fillStyle = '#7a5cff';
      ctx.beginPath(); ctx.arc(cx + 1, cy + 26 * k, 5, 0, TAU); ctx.fill();
    } else if (this.emotion === 'tristeza') {
      const cx = x + r * 0.95;
      const cy = y - r * 0.35 + ((this.emotionT * 40) % 30);
      const drop = [[cx, cy - 18 * k], [cx - 9 * k, cy], [cx, cy + 9 * k], [cx + 9 * k, cy], [cx, cy - 18 * k]];
      ctx.fillStyle = 'rgba(110, 180, 255, 0.55)';
      ctx.beginPath(); ctx.ellipse(cx, cy + 1, 8 * k, 9 * k, 0, 0, TAU); ctx.fill();
      this.stroke(drop, { color: '#4a90d9', width: 3, seed: 30 });
    }

    if (s.listening) {
      // sound waves next to the ear, driven by the mic level
      for (let i = 0; i < 3; i++) {
        const rr = r * (0.35 + i * 0.16 + (s.level || 0) * 0.15);
        this.stroke(this.circlePts(x - r * 0.95, y, rr * 0.5, rr, 10, Math.PI * 0.72, Math.PI * 1.28),
          { color: '#00a88f', width: 3.5, seed: 40 + i });
      }
    }

    if (this.subtitle) this.bubble(x, y, r);
  }

  star(cx, cy, sz, seed, color) {
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * TAU - Math.PI / 2;
      const rr = i % 2 ? sz * 0.38 : sz;
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    this.stroke(pts, { color, width: 3.5, seed: seed * 7 });
  }

  bubble(x, y, r) {
    const { ctx } = this;
    const vw = this.canvas.width / this.dpr;
    const W = Math.min(vw - 24, 320);
    ctx.font = '600 18px "Patrick Hand", "Comic Sans MS", system-ui, sans-serif';
    const lines = [];
    let line = '';
    for (const w of this.subtitle.split(' ')) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width > W - 36 && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    const h = lines.length * 24 + 24;
    // above-right of the head, kept inside the stage
    const bx = Math.max(12, Math.min(vw - W - 12, x + r * 0.35));
    const by = Math.max(70, y - r * 1.5 - h);
    const a = Math.min(1, this.subtitleT * 5);
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(255, 252, 245, 0.95)';
    ctx.beginPath();
    ctx.roundRect(bx, by, W, h, 16);
    ctx.fill();
    // tail towards the head
    const tx = Math.max(bx + 24, Math.min(bx + W - 24, x + r * 0.2));
    ctx.beginPath();
    ctx.moveTo(tx - 12, by + h - 1);
    ctx.lineTo(tx + 12, by + h - 1);
    ctx.lineTo(tx - 6, by + h + 22);
    ctx.closePath();
    ctx.fill();
    // sketchy outline: rounded box + tail, drawn as pencil strokes
    const R = 16;
    const box = [];
    const corner = (cx, cy, a0) => { for (let i = 0; i <= 4; i++) { const t = a0 + (Math.PI / 2) * (i / 4); box.push([cx + Math.cos(t) * R, cy + Math.sin(t) * R]); } };
    corner(bx + W - R, by + R, -Math.PI / 2);
    corner(bx + W - R, by + h - R, 0);
    box.push([tx + 12, by + h], [tx - 6, by + h + 22], [tx - 12, by + h]);
    corner(bx + R, by + h - R, Math.PI / 2);
    corner(bx + R, by + R, Math.PI);
    this.stroke(box, { color: '#6b4b4b', width: 2.6, seed: 60, close: true, jitter: 1.1 });
    ctx.globalAlpha = a;
    ctx.fillStyle = '#3a2e2e';
    lines.forEach((l, i) => ctx.fillText(l, bx + 18, by + 28 + i * 24));
    ctx.globalAlpha = 1;
  }
}
