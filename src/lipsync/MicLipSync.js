// "Mirror" mode: the avatar lip-syncs to your microphone in real time.
// Audio analysis (no ML): loudness drives how open the mouth is, and the
// balance between low formant energy (≈300-900 Hz, round vowels O/U) and
// high formant energy (≈1.6-3.5 kHz, spread vowels E/I) drives round vs wide.
// Bursts of very high frequencies (fricatives s/f/ch) show the teeth.
export class MicLipSync {
  constructor() {
    this.active = false;
    this.params = null;
    this.level = 0;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.src = this.ctx.createMediaStreamSource(stream);
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 2048;
    this.an.smoothingTimeConstant = 0.55;
    this.src.connect(this.an);
    this.freq = new Float32Array(this.an.frequencyBinCount);
    this.time = new Float32Array(this.an.fftSize);
    this.stream = stream;
    this.active = true;
    this.noise = 0.01;
  }

  stop() {
    this.active = false;
    this.params = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
  }

  band(lo, hi) {
    const hz = this.ctx.sampleRate / this.an.fftSize;
    let s = 0;
    let n = 0;
    for (let i = Math.floor(lo / hz); i <= Math.ceil(hi / hz); i++) { s += 10 ** (this.freq[i] / 20); n++; }
    return s / Math.max(1, n);
  }

  frame() {
    if (!this.active) return null;
    this.an.getFloatTimeDomainData(this.time);
    let rms = 0;
    for (const v of this.time) rms += v * v;
    rms = Math.sqrt(rms / this.time.length);
    // adaptive noise floor so silence keeps the mouth shut
    this.noise = rms < this.noise * 1.5 ? this.noise * 0.95 + rms * 0.05 : this.noise * 0.999 + rms * 0.001;
    const loud = Math.max(0, Math.min(1, (rms - this.noise * 1.8) * 9));
    this.level = loud;
    if (loud < 0.03) { this.params = null; return null; }
    this.an.getFloatFrequencyData(this.freq);
    const low = this.band(300, 900);
    const high = this.band(1600, 3500);
    const hiss = this.band(4500, 8000);
    const spread = Math.max(0, Math.min(1, high / (low + high + 1e-9) * 1.6));
    const fric = Math.max(0, Math.min(1, hiss / (low + 1e-9) * 2));
    this.params = {
      open: Math.min(1, loud * 1.25) * (1 - fric * 0.6),
      wide: 0.2 + spread * 0.8,
      round: (1 - spread) * 0.9,
      teeth: Math.max(fric, spread * 0.6),
      tongue: 0.2 * loud,
      press: 0,
    };
    return this.params;
  }
}
