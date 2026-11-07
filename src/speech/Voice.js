// Text-to-speech + procedural lip-sync.
// Each sentence gets a viseme timeline (src/lipsync/visemes.js). With the Web
// Speech API the timeline starts on `onstart` and is re-anchored on every
// `onboundary` word event, so the mouth stays in sync even if the voice speeds
// up or pauses. Without a usable voice it runs in "silent" mode (subtitles +
// lip-sync on the estimated timing), so the avatar always talks.
import { buildTimeline, sampleTimeline, wordStartTime } from '../lipsync/visemes.js';

export class Voice {
  constructor({ onSentence, onWord, onIdle } = {}) {
    this.onSentence = onSentence || (() => {});
    this.onWord = onWord || (() => {});
    this.onIdle = onIdle || (() => {});
    this.queue = [];
    this.busy = false;
    this.enabled = true;
    this.rate = 1.05;
    this.voice = null;
    this.tl = null;
    this.t0 = 0;
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    if (this.synth) {
      const pick = () => {
        const vs = this.synth.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith('es'));
        const pref = ['es-MX', 'es-US', 'es-CO', 'es-ES'];
        vs.sort((a, b) => (pref.indexOf(a.lang) + 10 * !/google|natural|online/i.test(a.name)) -
                          (pref.indexOf(b.lang) + 10 * !/google|natural|online/i.test(b.name)));
        this.voices = vs;
        if (!this.voice && vs.length) this.voice = vs[0];
      };
      pick();
      this.synth.onvoiceschanged = pick;
    }
  }

  get speaking() { return this.busy; }

  say(text) {
    const parts = text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
    this.queue.push(...parts);
    if (!this.busy) this.next();
  }

  stop() {
    this.queue = [];
    if (this.synth) this.synth.cancel();
    this.tl = null;
    this.busy = false;
    clearTimeout(this.timer);
    this.onIdle();
  }

  next() {
    const sentence = this.queue.shift();
    if (!sentence) { this.busy = false; this.tl = null; this.onIdle(); return; }
    this.busy = true;
    this.onSentence(sentence);
    const useTTS = this.enabled && this.synth && this.voice;
    this.tl = buildTimeline(sentence, { rate: useTTS ? this.rate : 1 });
    const done = () => { if (this.current === u) { clearTimeout(this.timer); this.next(); } };
    let u = null;
    if (!useTTS) {
      this.current = null;
      this.t0 = performance.now();
      this.timer = setTimeout(() => this.next(), this.tl.total + 150);
      return;
    }
    u = new SpeechSynthesisUtterance(sentence);
    this.current = u;
    u.voice = this.voice;
    u.lang = this.voice.lang;
    u.rate = this.rate;
    let started = false;
    u.onstart = () => { started = true; this.t0 = performance.now(); };
    u.onboundary = (e) => {
      if (e.name && e.name !== 'word') return;
      const target = performance.now() - wordStartTime(this.tl, e.charIndex);
      // re-anchor smoothly when the voice drifts from the estimate
      if (Math.abs(target - this.t0) > 90) this.t0 = this.t0 + (target - this.t0) * 0.7;
      this.onWord(e.charIndex);
    };
    u.onend = done;
    u.onerror = done;
    this.t0 = performance.now() + 60;
    this.synth.speak(u);
    // safety nets: voice never started (blocked autoplay) / never ended
    this.timer = setTimeout(() => {
      if (!started) { this.synth.cancel(); this.current = null; this.t0 = performance.now(); this.timer = setTimeout(() => this.next(), this.tl.total + 150); }
    }, 1200);
  }

  /** Mouth parameters right now, or null when not speaking. */
  frame(now = performance.now()) {
    if (!this.tl) return null;
    return sampleTimeline(this.tl, now - this.t0);
  }
}

export class Listener {
  constructor() {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    this.supported = !!SR;
    if (!SR) return;
    this.rec = new SR();
    this.rec.lang = 'es-ES';
    this.rec.interimResults = true;
    this.rec.continuous = false;
  }

  start({ onInterim, onFinal, onEnd }) {
    if (!this.supported) return false;
    this.rec.onresult = (e) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      if (interim) onInterim?.(interim);
      if (final) onFinal?.(final.trim());
    };
    this.rec.onend = () => onEnd?.();
    this.rec.onerror = () => onEnd?.();
    this.rec.start();
    return true;
  }

  stop() { try { this.rec?.stop(); } catch { /* not started */ } }
}
