// Lightweight Spanish sentiment -> emotion. Used for the user's messages and
// as a fallback when the AI reply carries no explicit [emotion] tag.

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
 * Extracts a leading "[emoción]" tag from an AI reply.
 * Returns {emotion|null, text, pending} where pending=true means the tag may
 * still be arriving (streaming) and the caller should wait for more text.
 */
export function parseEmotionTag(buffer) {
  const s = buffer.trimStart();
  if (!s.startsWith('[')) return { emotion: null, text: buffer, pending: false };
  const end = s.indexOf(']');
  if (end === -1) return { emotion: null, text: '', pending: s.length < 24 };
  const raw = strip(s.slice(1, end).trim());
  const map = { alegria: 'alegria', feliz: 'alegria', sorpresa: 'sorpresa', duda: 'duda', tristeza: 'tristeza',
    pensativo: 'pensativo', neutral: 'neutral', neutro: 'neutral' };
  return { emotion: map[raw] || 'neutral', text: s.slice(end + 1).trimStart(), pending: false };
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
