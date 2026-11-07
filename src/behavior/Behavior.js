// Turns high-level state (emotion, where to look, viseme stream, listening)
// into per-frame face parameters, head rotation and morph-target weights.
import { DEFAULT_FACE } from '../avatar/FaceCanvas.js';
import { VISEMES, mix } from '../lipsync/visemes.js';

// Expression presets (face parameters; the mouth is added by the lip-sync)
export const EXPRESSIONS = {
  neutral:  { lidL: 0.42, lidR: 0.42, droop: 0, lower: 0, pupilScale: 1, smile: 0, wave: 0.65, asym: 0.35, blush: 0, cheeks: 0, tilt: 0.0, nod: 0 },
  alegria:  { lidL: 0.16, lidR: 0.16, droop: -0.1, lower: 0.38, pupilScale: 1.05, smile: 1, wave: 0, asym: 0, blush: 0.9, cheeks: 1, tilt: 0.07, nod: -0.03 },
  sorpresa: { lidL: 0.0, lidR: 0.0, droop: -0.2, lower: 0, pupilScale: 0.72, smile: 0.1, wave: 0, asym: 0, blush: 0.15, cheeks: 0, tilt: 0, nod: -0.07, idleOpen: 0.45, idleRound: 0.8 },
  duda:     { lidL: 0.58, lidR: 0.3, droop: -0.25, lower: 0.1, pupilScale: 1, smile: -0.2, wave: 0.9, asym: 0.9, blush: 0, cheeks: 0, tilt: -0.1, nod: 0.02 },
  tristeza: { lidL: 0.5, lidR: 0.5, droop: 0.65, lower: 0, pupilScale: 1.05, smile: -0.85, wave: 0.2, asym: 0, blush: 0, cheeks: 0, tilt: 0.04, nod: 0.09 },
  pensativo:{ lidL: 0.32, lidR: 0.36, droop: -0.05, lower: 0.12, pupilScale: 0.95, smile: -0.1, wave: 0.4, asym: 0.6, blush: 0, cheeks: 0, tilt: -0.06, nod: -0.02, press: 0.4 },
};

const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Critically damped spring towards a target (smooth, no overshoot).
 *  Closed-form step: unconditionally stable for any frame time (an explicit
 *  Euler step blew up on slow devices and threw the pupils out of the eyes). */
export class Spring {
  constructor(value = 0, speed = 8) { this.v = value; this.vel = 0; this.speed = speed; }
  step(target, dt) {
    const w = this.speed;
    const x0 = this.v - target;
    const v0 = this.vel;
    const e = Math.exp(-w * dt);
    const c = v0 + w * x0;
    this.v = target + (x0 + c * dt) * e;
    this.vel = (v0 - w * c * dt) * e;
    return this.v;
  }
}

export class Behavior {
  constructor() {
    this.emotion = 'neutral';
    this.expr = { ...EXPRESSIONS.neutral };
    this.mouth = { ...VISEMES.REST };
    this.look = { x: 0.3, y: 0 };             // where the user is (normalized screen, -1..1)
    this.lastPointer = 0;
    this.yaw = new Spring(0, 6);
    this.pitch = new Spring(0, 6);
    this.eyeX = new Spring(0.25, 18);
    this.eyeY = new Spring(0, 18);
    this.blinkT = 0;
    this.nextBlink = 2.5;
    this.doubleBlink = false;
    this.saccade = { x: 0, y: 0, t: 0 };
    this.idleTarget = { x: 0.3, y: 0, t: 0 };
    this.state = 'idle';                      // idle | listening | thinking | speaking
    this.speakEnergy = 0;
  }

  setEmotion(e) { if (EXPRESSIONS[e]) this.emotion = e; }

  pointer(nx, ny, now) {
    this.look = { x: clamp(nx, -1, 1), y: clamp(ny, -1, 1) };
    this.lastPointer = now;
  }

  /** viseme params from the lip-sync driver (or null when silent) */
  setMouth(params) { this.target = params; }

  update(dt, now) {
    // ---- expression blend (300 ms feel)
    const goal = EXPRESSIONS[this.emotion];
    const k = 1 - Math.exp(-dt * 7);
    for (const key of Object.keys(goal)) this.expr[key] = lerp(this.expr[key] ?? 0, goal[key], k);

    // ---- mouth: viseme stream when speaking, expression idle mouth otherwise
    let target = this.target;
    if (!target) {
      const e = this.expr;
      target = { ...VISEMES.REST, open: e.idleOpen || 0, round: e.idleRound || 0, press: e.press || 0 };
    }
    const km = 1 - Math.exp(-dt * 28);
    this.mouth = mix(this.mouth, target, km);
    this.speakEnergy = lerp(this.speakEnergy, this.target ? this.mouth.open : 0, 1 - Math.exp(-dt * 10));

    // ---- gaze: follow the pointer; when idle look around; while thinking look up
    let gx = this.look.x;
    let gy = this.look.y;
    const idle = now - this.lastPointer > 4;
    if (this.state === 'thinking') { gx = 0.55; gy = -0.6; }
    else if (this.state === 'listening') { gx = this.look.x * 0.5; gy = 0.15; }
    else if (idle) {
      if (now > this.idleTarget.t) {
        this.idleTarget = { x: (Math.random() * 2 - 1) * 0.7, y: (Math.random() * 2 - 1) * 0.35, t: now + 1.5 + Math.random() * 3 };
      }
      gx = this.idleTarget.x;
      gy = this.idleTarget.y;
    }
    // micro-saccades: tiny eye jumps every ~0.4-1.2 s
    if (now > this.saccade.t) {
      this.saccade = { x: (Math.random() - 0.5) * 0.12, y: (Math.random() - 0.5) * 0.08, t: now + 0.4 + Math.random() * 0.8 };
    }
    const ex = this.eyeX.step(clamp(gx * 0.9 + this.saccade.x, -1, 1), dt);
    const ey = this.eyeY.step(clamp(gy * 0.8 + this.saccade.y, -1, 1), dt);
    // head follows the eyes more slowly and less far
    const talkNod = this.target ? Math.sin(now * 9) * 0.012 * this.speakEnergy : 0;
    const yaw = this.yaw.step(gx * 0.32, dt);
    const pitch = this.pitch.step(gy * 0.16 + this.expr.nod + talkNod, dt);
    const breathe = Math.sin(now * 1.6) * 0.008;
    const roll = this.expr.tilt + Math.sin(now * 0.7) * 0.01;

    // ---- blink: random 2-6 s, sometimes double; 140 ms
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT <= 0) {
      this.blinkT = 0.14;
      this.doubleBlink = Math.random() < 0.25;
      this.nextBlink = 2 + Math.random() * 4;
    }
    let blink = 0;
    if (this.blinkT > 0) {
      this.blinkT -= dt;
      const p = 1 - this.blinkT / 0.14;
      blink = p < 0.45 ? p / 0.45 : 1 - (p - 0.45) / 0.55;
      if (this.blinkT <= 0 && this.doubleBlink) { this.doubleBlink = false; this.blinkT = 0.14; }
    }

    const e = this.expr;
    const face = {
      ...DEFAULT_FACE,
      lidL: lerp(e.lidL, 1, blink),
      lidR: lerp(e.lidR, 1, blink),
      droop: e.droop,
      lower: e.lower,
      pupilX: ex,
      pupilY: ey,
      pupilScale: e.pupilScale,
      smile: e.smile,
      wave: this.target ? e.wave * 0.2 : e.wave,
      asym: e.asym,
      blush: e.blush,
      mouth: this.mouth,
    };
    return {
      face,
      head: { yaw, pitch: pitch + breathe, roll },
      morphs: { cheeks_up: e.cheeks * 0.9 + Math.max(0, e.smile) * 0.1, squash: this.speakEnergy * 0.35 },
      breathe,
    };
  }
}
