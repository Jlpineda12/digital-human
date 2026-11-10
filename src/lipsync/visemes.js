// Procedural Spanish lip-sync: text -> phonemes -> visemes -> timeline.
// Spanish spelling is almost phonetic, so a small rule set (digraphs, soft
// c/g, silent h, "qu"/"gu") gives a solid phoneme stream without any model.
// Every viseme is a vector of mouth parameters; the face blends between them.

/** Mouth shape parameters, all 0..1 */
export const VISEMES = {
  REST: { open: 0.0, wide: 0.25, round: 0.0, teeth: 0.0, tongue: 0.0, press: 0.0 },
  A:    { open: 0.9, wide: 0.55, round: 0.1, teeth: 0.55, tongue: 0.35, press: 0.0 },
  E:    { open: 0.5, wide: 0.9, round: 0.0, teeth: 0.9, tongue: 0.2, press: 0.0 },
  I:    { open: 0.32, wide: 1.0, round: 0.0, teeth: 1.0, tongue: 0.1, press: 0.0 },
  O:    { open: 0.7, wide: 0.15, round: 0.85, teeth: 0.2, tongue: 0.2, press: 0.0 },
  U:    { open: 0.32, wide: 0.0, round: 1.0, teeth: 0.0, tongue: 0.0, press: 0.0 },
  MBP:  { open: 0.0, wide: 0.35, round: 0.1, teeth: 0.0, tongue: 0.0, press: 1.0 },
  F:    { open: 0.15, wide: 0.6, round: 0.0, teeth: 1.0, tongue: 0.0, press: 0.4 },
  TD:   { open: 0.3, wide: 0.5, round: 0.0, teeth: 0.7, tongue: 0.9, press: 0.0 },
  S:    { open: 0.14, wide: 0.8, round: 0.0, teeth: 1.0, tongue: 0.0, press: 0.0 },
  K:    { open: 0.42, wide: 0.45, round: 0.1, teeth: 0.3, tongue: 0.3, press: 0.0 },
  CH:   { open: 0.3, wide: 0.2, round: 0.6, teeth: 0.8, tongue: 0.2, press: 0.0 },
  R:    { open: 0.35, wide: 0.45, round: 0.05, teeth: 0.5, tongue: 1.0, press: 0.0 },
};

export const PARAMS = Object.keys(VISEMES.REST);

// Base durations in ms at speech rate 1.0
const DUR = { vowel: 115, cons: 70, pause: 90, comma: 220, stop: 380 };
const VOWEL = { a: 'A', e: 'E', i: 'I', o: 'O', u: 'U', y: 'I' };

function strip(text) {
  // keep ñ, ü is pronounced (pingüino) -> 'w'; drop the other accents: á->a
  return text.toLowerCase()
    .replace(/ü/g, 'w')
    .replace(/ñ/g, '\u0001')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'ñ');
}

/** One word -> list of viseme keys (Spanish rules). */
export function wordToVisemes(word) {
  const w = strip(word).replace(/[^a-zñ]/g, '');
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const n = w[i + 1] || '';
    if (c === 'h') continue;                                  // silent h
    if (c === 'c' && n === 'h') { out.push('CH'); i++; continue; }
    if (c === 'l' && n === 'l') { out.push('CH'); i++; continue; }
    if (c === 'r' && n === 'r') { out.push('R'); i++; continue; }
    if (c === 'q' && n === 'u') { out.push('K'); i++; continue; }      // que, qui
    if (c === 'g' && n === 'u' && 'ei'.includes(w[i + 2] || '')) { out.push('K'); i++; continue; } // gue, gui
    if (c === 'y') {                                          // y = vowel at end / alone, consonant otherwise
      out.push(i === w.length - 1 || !VOWEL[n] ? 'I' : 'CH');
      continue;
    }
    if (VOWEL[c]) { out.push(VOWEL[c]); continue; }
    if ('mbpv'.includes(c)) { out.push('MBP'); continue; }
    if (c === 'f') { out.push('F'); continue; }
    if (c === 'c') { out.push('ei'.includes(n) ? 'S' : 'K'); continue; }
    if (c === 'g') { out.push('K'); continue; }
    if ('kjqx'.includes(c)) { out.push(c === 'x' ? 'S' : 'K'); continue; }
    if ('sz'.includes(c)) { out.push('S'); continue; }
    if ('tdnl'.includes(c)) { out.push('TD'); continue; }
    if (c === 'r') { out.push(i === 0 ? 'R' : 'TD'); continue; }
    if (c === 'ñ') { out.push('CH'); continue; }
    if (c === 'w') { out.push('U'); continue; }
  }
  return out;
}

/** Splits text into words keeping character offsets (for TTS boundary sync). */
export function tokenize(text) {
  const words = [];
  const re = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+|[.,;:!?¡¿…]/g;
  let m;
  while ((m = re.exec(text))) words.push({ text: m[0], index: m.index });
  return words;
}

/**
 * Builds a viseme timeline.
 * @returns {{events: {t:number, dur:number, v:string}[], words: {t:number, index:number}[], total:number}}
 */
export function buildTimeline(text, { rate = 1 } = {}) {
  const events = [];
  const words = [];
  let t = 0;
  const k = 1 / Math.max(0.3, rate);
  for (const tok of tokenize(text)) {
    if (/^[.!?…]$/.test(tok.text)) { events.push({ t, dur: DUR.stop * k, v: 'REST' }); t += DUR.stop * k; continue; }
    if (/^[,;:]$/.test(tok.text)) { events.push({ t, dur: DUR.comma * k, v: 'REST' }); t += DUR.comma * k; continue; }
    if (/^[¡¿]$/.test(tok.text)) continue;
    words.push({ t, index: tok.index, len: tok.text.length });
    let vis = wordToVisemes(tok.text);
    if (!vis.length && /\d/.test(tok.text)) vis = ['E', 'TD', 'O'];  // numbers: generic chatter
    for (const v of vis) {
      const isVowel = 'AEIOU'.includes(v);
      const dur = (isVowel ? DUR.vowel : DUR.cons) * k;
      events.push({ t, dur, v });
      t += dur;
    }
    events.push({ t, dur: DUR.pause * k * 0.5, v: 'REST' });
    t += DUR.pause * k * 0.5;
  }
  return { events, words, total: t };
}

/** Index of the event active at time t (binary search). */
function eventAt(events, t) {
  let lo = 0;
  let hi = events.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Mouth parameters at time t with coarticulation: each viseme eases into the
 * next during the last 45% of its duration, so the mouth never "pops".
 */
export function sampleTimeline(tl, t) {
  if (!tl || !tl.events.length || t < 0 || t >= tl.total) return { ...VISEMES.REST };
  const i = eventAt(tl.events, t);
  const ev = tl.events[i];
  const next = tl.events[i + 1];
  const a = VISEMES[ev.v];
  const local = (t - ev.t) / ev.dur;
  if (!next || local < 0.55) return { ...a };
  const b = VISEMES[next.v];
  const x = (local - 0.55) / 0.45;
  const s = x * x * (3 - 2 * x); // smoothstep
  const out = {};
  for (const p of PARAMS) out[p] = a[p] + (b[p] - a[p]) * s;
  return out;
}

/** How many characters of the sentence have been "said" at time t (ms):
 *  the typewriter of the dialogue box follows the voice word by word. */
export function revealedChars(tl, t, textLength) {
  if (!tl || t >= tl.total) return textLength;
  let n = 0;
  for (const w of tl.words) {
    if (w.t > t) break;
    n = w.index + (w.len || 0);
  }
  return Math.min(textLength, n);
}

/** Re-anchors a running timeline to the start of word `wordIdx` (TTS boundary). */
export function wordStartTime(tl, charIndex) {
  let best = null;
  for (const w of tl.words) {
    if (w.index <= charIndex) best = w; else break;
  }
  return best ? best.t : 0;
}

/** Linear blend of two parameter sets. */
export function mix(a, b, k) {
  const out = {};
  for (const p of PARAMS) out[p] = a[p] + (b[p] - a[p]) * k;
  return out;
}
