// Lightweight Spanish sentiment -> emotion. Used for the user's messages and
// as a fallback when the AI reply carries no explicit [emotion] tag.
import { GESTURE_NAMES } from '../behavior/gestures.js';

export const EMOTIONS = ['neutral', 'alegria', 'sorpresa', 'duda', 'tristeza', 'pensativo'];

const LEXICON = {
  alegria: ['genial', 'gracias', 'feliz', 'excelente', 'me encanta', 'encanta', 'perfecto', 'bien', 'bueno',
    'buenísimo', 'chévere', 'bacano', 'increíble', 'jaja', 'jeje', 'divertido', 'brutal', 'bonito', 'hermoso',
    'felicidades', 'éxito', 'logré', 'funciona', 'me gusta', 'amo', 'gusto', 'hola', 'bienvenido', '😀', '😄', '😂', '❤', '🎉', '👍'],
  sorpresa: ['wow', 'guau', 'en serio', 'de verdad', 'no puede ser', 'impresionante', 'sorprend', 'increíble',
    'asombroso', 'qué locura', 'whoa', 'uff', 'ostras', '😮', '😲', '🤯'],
  duda: ['quizá', 'quizás', 'tal vez', 'no sé', 'nose', 'hmm', 'mmm', 'depende', 'duda', 'no estoy seguro',
    'supongo', 'creo que', 'puede ser', 'confuso', 'raro', 'extraño', '🤔'],
  tristeza: ['triste', 'lo siento', 'lamentablemente', 'mal', 'perdón', 'disculpa', 'error', 'problema',
    'falló', 'no funciona', 'difícil', 'cansado', 'aburrido', 'solo', 'extraño a', '😢', '😞', '💔'],
};

const strip = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Returns {emotion, scores}. */
export function analyze(text) {
  const t = ` ${strip(text)} `;
  const scores = { alegria: 0, sorpresa: 0, duda: 0, tristeza: 0 };
  for (const [emo, words] of Object.entries(LEXICON)) {
    for (const w of words) {
      const k = strip(w);
      let idx = t.indexOf(k);
      while (idx !== -1) {
        scores[emo] += k.length > 4 ? 1.2 : 1;
        idx = t.indexOf(k, idx + k.length);
      }
    }
  }
  const bangs = (text.match(/!/g) || []).length;
  const questions = (text.match(/\?/g) || []).length;
  scores.sorpresa += Math.min(bangs, 3) * 0.6;
  scores.alegria += Math.min(bangs, 3) * 0.3;
  scores.duda += Math.min(questions, 3) * 0.5;
  if (/\bno\b/.test(t)) scores.tristeza += 0.3;
  let best = 'neutral';
  let max = 0.9;
  for (const [emo, v] of Object.entries(scores)) {
    if (v > max) { max = v; best = emo; }
  }
  return { emotion: best, scores };
}

/**
 * Extracts a leading "[emoción]" or "[emoción|gesto]" tag from an AI reply.
 * Returns {emotion|null, gesture|null, text, pending} where pending=true means
 * the tag may still be arriving (streaming) and the caller should wait.
 */
export function parseEmotionTag(buffer) {
  const s = buffer.trimStart();
  if (!s.startsWith('[')) return { emotion: null, gesture: null, text: buffer, pending: false };
  const end = s.indexOf(']');
  if (end === -1) return { emotion: null, gesture: null, text: '', pending: s.length < 40 };
  const parts = strip(s.slice(1, end)).split(/[|,;/\s]+/).filter(Boolean);
  const map = { alegria: 'alegria', feliz: 'alegria', sorpresa: 'sorpresa', duda: 'duda', tristeza: 'tristeza',
    pensativo: 'pensativo', neutral: 'neutral', neutro: 'neutral' };
  const emotion = parts.map((x) => map[x]).find(Boolean) || 'neutral';
  const gesture = parts.find((x) => GESTURE_NAMES.includes(x)) || null;
  return { emotion, gesture, text: s.slice(end + 1).trimStart(), pending: false };
}

const INLINE = new RegExp(`\\s*\\[(${GESTURE_NAMES.join('|')})\\]`, 'gi');

/** Removes inline [gesto] cues from spoken text; returns the clean text and the
 *  cues in order. A trailing, still-incomplete "[..." is held back. */
export function takeGestureCues(text) {
  const gestures = [];
  let clean = text.replace(INLINE, (_, g) => { gestures.push(strip(g)); return ''; });
  const open = clean.lastIndexOf('[');
  if (open !== -1 && clean.indexOf(']', open) === -1 && clean.length - open < 14) clean = clean.slice(0, open);
  return { text: clean, gestures };
}

/** Splits streamed text into complete sentences (for early TTS). */
export function takeSentences(buffer) {
  const out = [];
  const re = /[^.!?…]+[.!?…]+["')\]]*\s+/g;
  let m;
  let last = 0;
  while ((m = re.exec(buffer))) {
    out.push(m[0].trim());
    last = re.lastIndex;
  }
  return { sentences: out, rest: buffer.slice(last) };
}
