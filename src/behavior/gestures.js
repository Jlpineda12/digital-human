// Head / body gestures layered on top of the gaze and the expression.
// Each gesture is a short curve of additive offsets (radians, metres):
//   yaw (no), pitch (yes, + = chin down), roll (tilt), lift (whole bust up).
// They are triggered by what the user says, by the reply's [emoción|gesto]
// tag, and by each sentence as it is spoken (cueGesture).

const TAU = Math.PI * 2;
// smooth in/out envelope over the gesture's life
const env = (t, d) => Math.sin(Math.PI * Math.min(1, Math.max(0, t / d)));

export const GESTURES = {
  asentir:   { dur: 0.95, f: (t, d) => ({ pitch: 0.085 * Math.sin(TAU * 2.1 * t) * env(t, d) }) },
  negar:     { dur: 1.1,  f: (t, d) => ({ yaw: 0.13 * Math.sin(TAU * 2.3 * t) * env(t, d), pitch: 0.02 * env(t, d) }) },
  ladear:    { dur: 1.6,  f: (t, d) => ({ roll: -0.12 * env(t, d), yaw: 0.05 * env(t, d) }) },
  pensar:    { dur: 1.8,  f: (t, d) => ({ roll: 0.07 * env(t, d), pitch: -0.07 * env(t, d), yaw: -0.08 * env(t, d) }) },
  reir:      { dur: 1.1,  f: (t, d) => ({ pitch: -0.05 * env(t, d) + 0.03 * Math.sin(TAU * 5 * t) * env(t, d),
    lift: 0.012 * Math.abs(Math.sin(TAU * 2.5 * t)) * env(t, d) }) },
  saludar:   { dur: 1.2,  f: (t, d) => ({ roll: 0.1 * Math.sin(TAU * 0.9 * t) * env(t, d), pitch: -0.04 * env(t, d),
    lift: 0.015 * env(t, d) }) },
  encoger:   { dur: 1.2,  f: (t, d) => ({ lift: 0.03 * env(t, d), roll: 0.08 * env(t, d), pitch: -0.02 * env(t, d) }) },
  sorpresa:  { dur: 0.9,  f: (t, d) => ({ pitch: -0.1 * env(t, d) * Math.min(1, t * 6), lift: 0.01 * env(t, d) }) },
  orgullo:   { dur: 1.4,  f: (t, d) => ({ pitch: -0.08 * env(t, d), lift: 0.012 * env(t, d) }) },
  enfasis:   { dur: 0.5,  f: (t, d) => ({ pitch: 0.06 * env(t, d) }) },
  consolar:  { dur: 1.8,  f: (t, d) => ({ roll: 0.1 * env(t, d), pitch: 0.05 * Math.sin(TAU * 0.8 * t) * env(t, d) }) },
};

export const GESTURE_NAMES = Object.keys(GESTURES);

const strip = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Which gesture fits a piece of text.
 *   who = 'user'  -> how Jose reacts while listening / thinking
 *   who = 'jose'  -> body language for a sentence he is saying
 */
export function cueGesture(text, who = 'jose') {
  const t = ` ${strip(text).trim()} `;
  const has = (re) => re.test(t);
  if (who === 'user') {
    if (has(/\b(hola|buenas|hey|saludos|que tal|buenos dias|buenas tardes)\b/)) return 'saludar';
    if (has(/\b(jaja|jeje|jsjs|lol|chiste|xd)\b/)) return 'reir';
    if (has(/\b(gracias|genial|crack|bacano|chevere|incre[ií]ble|me encanta|excelente|brutal|felicitaciones)\b/)) return 'orgullo';
    if (has(/\b(triste|mal dia|cansad|deprimid|aburrid)\b/)) return 'consolar';
    if (has(/\b(wow|guau|en serio|no puede ser)\b/) || /!{2,}/.test(text)) return 'sorpresa';
    if (/\?/.test(text) || has(/^\s*(que|como|cual|cuales|cuando|donde|por que|quien|cuantos?)\b/)) return 'ladear';
    return null;
  }
  if (has(/^\s*(si|claro|exacto|por supuesto|obvio|correcto|tal cual|eso es)\b/)) return 'asentir';
  if (has(/^\s*(no|para nada|nada que ver|jamas|nunca)\b/)) return 'negar';
  if (has(/\b(jaja|jeje)\b/)) return 'reir';
  if (has(/\b(no se|quiza|quizas|tal vez|depende|ni idea)\b/)) return 'encoger';
  if (has(/\b(me gustaria|sueno|quiero|mi meta|aspiro)\b/)) return 'pensar';
  if (has(/\b(orgullo|lo logre|me encanta|el que mas)\b/)) return 'orgullo';
  if (/\?\s*$/.test(text)) return 'ladear';
  if (/!/.test(text)) return 'enfasis';
  return null;
}

/** Sum of the active gestures at time `now`; finished ones are dropped. */
export function sampleGestures(active, now) {
  const out = { yaw: 0, pitch: 0, roll: 0, lift: 0 };
  for (let i = active.length - 1; i >= 0; i--) {
    const g = active[i];
    const def = GESTURES[g.name];
    const t = now - g.t0;
    if (!def || t > def.dur) { active.splice(i, 1); continue; }
    if (t < 0) continue;
    const o = def.f(t, def.dur);
    out.yaw += o.yaw || 0;
    out.pitch += o.pitch || 0;
    out.roll += o.roll || 0;
    out.lift += o.lift || 0;
  }
  return out;
}
