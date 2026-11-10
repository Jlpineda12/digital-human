// Procedural "blip" voice: one short 8-bit tone per syllable, like the
// dialogue boxes of retro games. It reads the same viseme timeline as the
// lip-sync, so every blip lands exactly when the mouth opens on a vowel.
// Pitch follows the vowel (i/e high, o/u low), the emotion (happy = higher
// and bouncier, sad = lower and slower) and the end of the sentence (a
// question goes up, a statement comes down). Pure Web Audio, no samples.

const VOWEL_SEMITONES = { I: 7, E: 4, A: 0, O: -3, U: -5 };
export const MOODS = {
  neutral:   { base: 196, spread: 1.0, wave: 'square',   jitter: 0.6 },
  alegria:   { base: 247, spread: 1.4, wave: 'square',   jitter: 1.2 },
  sorpresa:  { base: 277, spread: 1.6, wave: 'square',   jitter: 1.0 },
  duda:      { base: 185, spread: 0.8, wave: 'triangle', jitter: 1.6 },
  tristeza:  { base: 147, spread: 0.6, wave: 'triangle', jitter: 0.3 },
  pensativo: { base: 175, spread: 0.7, wave: 'triangle', jitter: 0.5 },
};

/** Blip schedule for a timeline: [{t (ms), dur (ms), freq (Hz)}]. Pure, testable. */
export function blipPlan(tl, { mood = 'neutral', text = '', seed = 1 } = {}) {
  const m = MOODS[mood] || MOODS.neutral;
  const vowels = tl.events.filter((e) => e.v in VOWEL_SEMITONES);
  const question = /\?\s*$/.test(text);
  const exclaim = /!\s*$/.test(text);
  let s = seed;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  return vowels.map((e, i) => {
    const k = vowels.length > 1 ? i / (vowels.length - 1) : 0;
    // sentence melody: questions rise at the end, statements fall
    const contour = question ? 8 * k * k : exclaim ? 2 - 2 * k : 1.5 - 3 * k;
    const semis = VOWEL_SEMITONES[e.v] * m.spread + contour + (rand() - 0.5) * 2 * m.jitter;
    return { t: e.t, dur: Math.max(35, Math.min(95, e.dur * 0.8)), freq: m.base * 2 ** (semis / 12) };
  });
}

export class Blips {
  constructor() {
    this.ctx = null;
    this.out = null;
    this.nodes = [];
    this.volume = 0.16;
  }

  /** Must run inside a user gesture the first time (browser autoplay rules). */
  unlock() {
    if (typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      this.ctx = new AC();
      // a gentle low-pass keeps the square wave "chiptune" but not harsh
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      this.out = this.ctx.createGain();
      this.out.gain.value = this.volume;
      this.out.connect(lp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  /** Schedules the blips of a sentence starting `delayMs` from now. */
  play(tl, opts = {}, delayMs = 0) {
    if (!this.ready) return 0;
    const plan = blipPlan(tl, opts);
    const now = this.ctx.currentTime + delayMs / 1000;
    for (const b of plan) {
      const t = now + b.t / 1000;
      const d = b.dur / 1000;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = (MOODS[opts.mood] || MOODS.neutral).wave;
      osc.frequency.setValueAtTime(b.freq, t);
      osc.frequency.exponentialRampToValueAtTime(b.freq * 0.94, t + d);   // tiny droop: more "voice"
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.006);
      g.gain.setValueAtTime(1, t + d * 0.6);
      g.gain.exponentialRampToValueAtTime(0.001, t + d);
      osc.connect(g).connect(this.out);
      osc.start(t);
      osc.stop(t + d + 0.02);
      this.nodes.push(osc);
      osc.onended = () => { this.nodes = this.nodes.filter((n) => n !== osc); };
    }
    return plan.length;
  }

  stop() {
    for (const n of this.nodes) { try { n.stop(); } catch { /* already stopped */ } }
    this.nodes = [];
  }
}
