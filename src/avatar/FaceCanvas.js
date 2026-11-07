// Procedural 2D face drawn every frame on a canvas that is wrapped on the 3D
// head (UV layout exported by blender/build_character.py -> face.json).
// Eyes, lids, pupils, mouth shapes (visemes) and blush are pure 2D drawing:
// 2D animation on a 3D volume.

const TAU = Math.PI * 2;

export const DEFAULT_FACE = {
  lidL: 0.42, lidR: 0.42,   // 0 = wide open, 1 = closed (the drawing: bored, half-lidded)
  droop: 0,                  // + outer corners down (sad), - up (angry/doubt)
  lower: 0,                  // happy squint (lower lid up)
  pupilX: 0.25, pupilY: 0,   // gaze inside the eye, -1..1
  pupilScale: 1,
  smile: 0,                  // -1 frown .. 1 smile
  wave: 0.65,                // skeptical wavy mouth from the drawing
  asym: 0.35,                // one corner higher
  blush: 0,
  mouth: { open: 0, wide: 0.25, round: 0, teeth: 0, tongue: 0, press: 0 },
};

export class FaceCanvas {
  constructor(layout, size = 1024) {
    this.layout = layout;
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d');
    this.pal = layout.palette;
    this.boil = 0;
  }

  // UV (v up) -> canvas pixels. The glTF exporter flips V, and the texture
  // uses flipY=false, so canvas row 0 is the top of the face.
  px(u, v) { return [u * this.size, (1 - v) * this.size]; }

  jitter(i, amp = 1.2) {
    // "boiling" hand-drawn line: deterministic wobble that changes 12×/s
    const s = Math.sin(i * 12.9898 + this.boil * 78.233) * 43758.5453;
    return ((s - Math.floor(s)) - 0.5) * 2 * amp;
  }

  draw(f, time) {
    const { ctx, size } = this;
    this.boil = Math.floor(time * 12);
    ctx.clearRect(0, 0, size, size);
    if (f.blush > 0.01) this.drawBlush(f.blush);
    for (const eye of this.layout.eyes) this.drawEye(eye, f);
    this.drawMouth(f);
  }

  drawBlush(k) {
    const { ctx } = this;
    for (const u of [0.2, 0.8]) {
      const [x, y] = this.px(u, 0.42);
      const g = ctx.createRadialGradient(x, y, 4, x, y, 90);
      g.addColorStop(0, `rgba(255, 105, 105, ${0.42 * k})`);
      g.addColorStop(1, 'rgba(255, 105, 105, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, 95, 60, 0, 0, TAU);
      ctx.fill();
      // little hatch strokes on the cheek (sketchbook touch)
      ctx.strokeStyle = `rgba(214, 80, 80, ${0.5 * k})`;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const ox = x - 30 + i * 24 + this.jitter(i + u * 10, 1.5);
        ctx.beginPath();
        ctx.moveTo(ox, y + 12);
        ctx.lineTo(ox + 14, y - 12);
        ctx.stroke();
      }
    }
  }

  eyeShape(x0, y0, x1, y1) {
    // lens-like outline: soft top corners, chamfered bottom corners
    const { ctx } = this;
    const w = x1 - x0;
    const h = y1 - y0;
    const c0 = Math.min(w, h) * 0.08;
    const c1 = Math.min(w, h) * 0.32;
    ctx.beginPath();
    ctx.moveTo(x0 + c0, y0);
    ctx.lineTo(x1 - c0, y0);
    ctx.quadraticCurveTo(x1, y0, x1, y0 + c0);
    ctx.lineTo(x1, y1 - c1);
    ctx.lineTo(x1 - c1, y1);
    ctx.lineTo(x0 + c1, y1);
    ctx.lineTo(x0, y1 - c1);
    ctx.lineTo(x0, y0 + c0);
    ctx.quadraticCurveTo(x0, y0, x0 + c0, y0);
    ctx.closePath();
  }

  drawEye(e, f) {
    const { ctx } = this;
    const left = e.side === 'R'; // character's right eye is on screen-left
    const [x0, y0] = this.px(e.u0, e.v1);
    const [x1, y1] = this.px(e.u1, e.v0);
    const w = x1 - x0;
    const h = y1 - y0;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const lid = Math.min(1, Math.max(0, left ? f.lidR : f.lidL));

    ctx.save();
    this.eyeShape(x0, y0, x1, y1);
    ctx.clip();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, w, h);

    // pupil (big, as in the drawing), follows the gaze
    const r = h * 0.38 * f.pupilScale;
    const px = cx + f.pupilX * (w / 2 - r * 0.9);
    const py = cy + h * 0.08 + f.pupilY * (h / 2 - r * 0.6);
    ctx.fillStyle = this.pal.Pupil;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(px - r * 0.35, py - r * 0.35, r * 0.16, 0, TAU);
    ctx.fill();

    // upper lid (skin) with a tilted lash line: droop lowers the outer corner
    const outer = left ? -1 : 1;           // outer corner direction in x
    const yl = y0 + h * lid;
    const tilt = f.droop * h * 0.22;
    const yOuter = yl + tilt;
    const yInner = yl - tilt * 0.4;
    const xa = outer < 0 ? x0 : x1;
    const xb = outer < 0 ? x1 : x0;
    ctx.fillStyle = this.pal.Skin;
    ctx.beginPath();
    ctx.moveTo(x0 - 4, y0 - 4);
    ctx.lineTo(x1 + 4, y0 - 4);
    ctx.lineTo(xb === x1 ? x1 + 4 : x1 + 4, xb === x1 ? yInner : yOuter);
    ctx.quadraticCurveTo(cx, (yOuter + yInner) / 2 + h * 0.03 + this.jitter(3, 1), x0 - 4, xa === x0 ? yOuter : yInner);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#2b2b2b';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, xa === x0 ? yOuter : yInner);
    ctx.quadraticCurveTo(cx, (yOuter + yInner) / 2 + h * 0.03 + this.jitter(3, 1), x1, xa === x1 ? yOuter : yInner);
    ctx.stroke();

    // lower lid (happy squint)
    if (f.lower > 0.02) {
      const yb = y1 - h * 0.55 * f.lower;
      ctx.fillStyle = this.pal.Skin;
      ctx.beginPath();
      ctx.moveTo(x0 - 4, y1 + 4);
      ctx.lineTo(x0 - 4, y1 - h * 0.1 * f.lower);
      ctx.quadraticCurveTo(cx, yb - h * 0.25 * f.lower, x1 + 4, y1 - h * 0.1 * f.lower);
      ctx.lineTo(x1 + 4, y1 + 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  drawMouth(f) {
    const { ctx } = this;
    const m = f.mouth;
    const L = this.layout.mouth;
    const [cx, cy] = this.px(L.u, L.v);
    const base = L.w * this.size * 0.5;            // half width of the drawn mouth
    const W = base * (0.72 + 0.35 * m.wide - 0.45 * m.round) * (1 + 0.12 * Math.max(0, f.smile));
    const H = base * 0.95 * m.open;
    const corner = -f.smile * base * 0.28;          // + smile lifts corners (y up = smaller)
    const tilt = f.asym * base * 0.12;
    const lip = this.pal.Mouth;
    const j = (i) => this.jitter(i, 1.4);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (m.open < 0.06) {
      // closed: thick wavy stroke (the drawing's skeptical mouth)
      const press = 1 + m.press * 0.25;
      ctx.strokeStyle = lip;
      ctx.lineWidth = 26 * press;
      ctx.beginPath();
      const n = 14;
      for (let i = 0; i <= n; i++) {
        const t = i / n * 2 - 1;
        const x = cx + t * W * (1 - m.press * 0.1);
        const wave = f.wave * base * 0.09 * Math.sin(t * Math.PI * 1.1 + 0.6);
        const y = cy + corner * t * t + wave - tilt * t + j(i);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      // open: lips outline + dark mouth + teeth + tongue
      const top = cy - H * 0.45;
      const bot = cy + H * 0.75;
      const xl = cx - W;
      const xr = cx + W;
      const yl = cy + corner - tilt;
      const yr = cy + corner + tilt;
      const roundK = m.round * 0.55;
      const shape = () => {
        ctx.beginPath();
        ctx.moveTo(xl, yl);
        ctx.bezierCurveTo(xl + W * roundK, top - H * 0.15 + j(1), xr - W * roundK, top - H * 0.15 + j(2), xr, yr);
        ctx.bezierCurveTo(xr - W * (0.15 - roundK * 0.2), bot + j(3), xl + W * (0.15 - roundK * 0.2), bot + j(4), xl, yl);
        ctx.closePath();
      };
      shape();
      ctx.fillStyle = '#4f1012';
      ctx.fill();
      ctx.save();
      shape();
      ctx.clip();
      if (m.teeth > 0.05) {
        ctx.fillStyle = '#fffaf2';
        ctx.fillRect(xl, top - H, W * 2, H * 0.35 + H * 0.45 * m.teeth);
      }
      if (m.tongue > 0.05) {
        ctx.fillStyle = '#e8625b';
        ctx.beginPath();
        ctx.ellipse(cx, bot + H * 0.05, W * 0.62, H * (0.25 + 0.35 * m.tongue), 0, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
      shape();
      ctx.strokeStyle = lip;
      ctx.lineWidth = 16;
      ctx.stroke();
    }
    ctx.restore();
  }
}
