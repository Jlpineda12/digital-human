// node tests/unit.test.mjs  — pure-JS modules (no browser)
import { VISEMES, PARAMS, wordToVisemes, buildTimeline, sampleTimeline, wordStartTime, tokenize } from '../src/lipsync/visemes.js';
import { analyze, parseEmotionTag, takeSentences } from '../src/emotion/sentiment.js';
import { Spring, Behavior } from '../src/behavior/Behavior.js';
import { cueGesture, sampleGestures, GESTURE_NAMES } from '../src/behavior/gestures.js';
import { takeGestureCues } from '../src/emotion/sentiment.js';
import { demoAnswer, PERSONA } from '../src/ai/brains.js';
import { PROFILE } from '../src/ai/profile.js';

let pass = 0;
let fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(cond, name) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); }
}

console.log('\nVisemas (español)');
check(eq(wordToVisemes('hola'), ['O', 'TD', 'A']), 'h muda: hola → O TD A');
check(eq(wordToVisemes('queso'), ['K', 'E', 'S', 'O']), 'qu → K: queso');
check(eq(wordToVisemes('guitarra'), ['K', 'I', 'TD', 'A', 'R', 'A']), 'gu+i y rr: guitarra');
check(eq(wordToVisemes('cielo')[0], 'S') && wordToVisemes('casa')[0] === 'K', 'c suave/dura: cielo / casa');
check(eq(wordToVisemes('chévere'), ['CH', 'E', 'MBP', 'E', 'TD', 'E']), 'ch + acentos: chévere');
check(eq(wordToVisemes('llama'), ['CH', 'A', 'MBP', 'A']), 'll: llama');
check(eq(wordToVisemes('niño'), ['TD', 'I', 'CH', 'O']), 'ñ: niño');
check(eq(wordToVisemes('pingüino'), ['MBP', 'I', 'TD', 'K', 'U', 'I', 'TD', 'O']), 'ü: pingüino');
check(eq(wordToVisemes('voy'), ['MBP', 'O', 'I']), 'v = b, y final vocal: voy');
check(eq(wordToVisemes('fuego')[0], 'F'), 'f labiodental');
check(Object.values(VISEMES).every((v) => PARAMS.every((p) => v[p] >= 0 && v[p] <= 1)), 'todos los visemas en rango 0..1');

console.log('\nLínea de tiempo');
const tl = buildTimeline('Hola, soy Jose. ¿Cómo estás?');
check(tl.events.length > 10 && tl.total > 1000 && tl.total < 5000, `duración plausible (${Math.round(tl.total)} ms)`);
check(tl.events.every((e, i) => i === 0 || e.t >= tl.events[i - 1].t), 'eventos ordenados');
check(tl.words.length === 5, `5 palabras para sincronizar (${tl.words.length})`);
const fast = buildTimeline('Hola, soy Jose. ¿Cómo estás?', { rate: 2 });
check(Math.abs(fast.total * 2 - tl.total) < 1, 'velocidad 2× → mitad de duración');
let maxJump = 0;
let prev = sampleTimeline(tl, 0);
for (let t = 5; t < tl.total; t += 5) {
  const cur = sampleTimeline(tl, t);
  maxJump = Math.max(maxJump, Math.abs(cur.open - prev.open));
  prev = cur;
}
check(maxJump < 0.95, `coarticulación: salto máx. de apertura por 5 ms = ${maxJump.toFixed(2)}`);
const opens = [];
for (let t = 0; t < tl.total; t += 10) opens.push(sampleTimeline(tl, t).open);
check(Math.max(...opens) > 0.8 && Math.min(...opens) === 0, 'la boca abre (A) y cierra (pausas)');
check(eq(sampleTimeline(tl, -1), VISEMES.REST) && eq(sampleTimeline(tl, tl.total + 1), VISEMES.REST), 'fuera de rango = reposo');
const iJose = 'Hola, soy Jose.'.indexOf('Jose');
check(Math.abs(wordStartTime(tl, iJose) - tl.words[2].t) < 1e-6, 'resincronización por palabra (onboundary)');
check(tokenize('¡Hola!').map((w) => w.text).join('|') === '¡|Hola|!', 'tokenizador conserva signos');

console.log('\nEmociones');
check(analyze('¡Me encanta, gracias! Es genial').emotion === 'alegria', 'alegría');
check(analyze('¡Wow! ¿En serio? No puede ser').emotion === 'sorpresa', 'sorpresa');
check(analyze('Mmm, no sé, tal vez depende...').emotion === 'duda', 'duda');
check(analyze('Lo siento, salió mal, qué triste').emotion === 'tristeza', 'tristeza');
check(analyze('El archivo está en la carpeta docs').emotion === 'neutral', 'neutral');
const tag = parseEmotionTag('[alegría] ¡Hola! Soy Jose.');
check(tag.emotion === 'alegria' && tag.text === '¡Hola! Soy Jose.', 'etiqueta [alegría] del modelo');
check(parseEmotionTag('[sorpr').pending === true, 'etiqueta incompleta en streaming → esperar');
check(parseEmotionTag('Hola sin etiqueta').emotion === null, 'sin etiqueta');
const s = takeSentences('Hola. Esto es una prueba! Y esto sigue');
check(eq(s.sentences, ['Hola.', 'Esto es una prueba!']) && s.rest === 'Y esto sigue', 'frases completas para voz anticipada');

console.log('\nMirada (resorte)');
for (const dt of [1 / 120, 1 / 60, 1 / 20, 0.25, 1]) {
  const sp = new Spring(0, 18);
  let maxAbs = 0;
  for (let i = 0; i < 400; i++) maxAbs = Math.max(maxAbs, Math.abs(sp.step(1, dt)));
  check(maxAbs <= 1.0001 && Math.abs(sp.v - 1) < 1e-3, `estable y sin rebote con dt=${dt.toFixed(3)} s (máx ${maxAbs.toFixed(4)})`);
}

console.log('\nGestos');
const tg = parseEmotionTag('[alegria|asentir] Claro que sí.');
check(tg.emotion === 'alegria' && tg.gesture === 'asentir' && tg.text === 'Claro que sí.', 'etiqueta [emoción|gesto]');
check(parseEmotionTag('[duda] Mmm.').gesture === null, 'etiqueta sin gesto sigue funcionando');
const cues = takeGestureCues('Sí. [negar] No lo creo. Y [ase');
check(eq(cues.gestures, ['negar']) && !cues.text.includes('[') , 'quita [gesto] del texto hablado y retiene uno incompleto');
check(cueGesture('¡Hola Jose!', 'user') === 'saludar', 'saludo del usuario → saludar');
check(cueGesture('¿Qué estudias?', 'user') === 'ladear', 'pregunta del usuario → ladear la cabeza');
check(cueGesture('Hoy tuve un mal día', 'user') === 'consolar', 'tristeza del usuario → consolar');
check(cueGesture('Sí, lo hice yo.', 'jose') === 'asentir', 'Jose afirma → asiente');
check(cueGesture('No, eso no.', 'jose') === 'negar', 'Jose niega → niega con la cabeza');
check(cueGesture('Quizás, depende.', 'jose') === 'encoger', 'duda → encoge los hombros');
const active = [{ name: 'asentir', t0: 0 }];
const mid = sampleGestures(active, 0.12);
check(Math.abs(mid.pitch) > 0.01 && active.length === 1, 'asentir mueve el pitch');
sampleGestures(active, 5);
check(active.length === 0, 'el gesto termina y se descarta');
const b = new Behavior();
b.update(0.016, 1);
b.gesture('negar');
let maxYaw = 0;
for (let i = 1; i < 40; i++) maxYaw = Math.max(maxYaw, Math.abs(b.update(0.016, 1 + i * 0.016).head.yaw));
check(maxYaw > 0.05, `negar gira la cabeza en Behavior (máx ${maxYaw.toFixed(3)} rad)`);
check(GESTURE_NAMES.every((g) => PERSONA.includes(g)), 'el prompt enseña todos los gestos a Claude');

console.log('\nCerebro demo (perfil de Jose)');
const ask = (q) => demoAnswer(q, 0);
check(ask('¿Cuántos años tienes?').text.includes(String(PROFILE.edad)), 'edad: 22 años');
check(ask('¿Qué estudias?').text.includes('Ingeniería en Multimedia'), 'carrera: Ingeniería en Multimedia');
check(ask('¿Cuáles son tus aspiraciones?').id === 'metas', 'aspiraciones');
check(ask('Cuéntame de Arcade Station').id === 'arcade', 'proyecto por nombre');
check(ask('háblame del addon de blender').id === 'forge', 'proyecto por palabra clave');
check(ask('¿Qué proyectos tienes?').id === 'proyectos', 'lista de proyectos');
check(ask('¿Cuál es tu color favorito del universo paralelo?').id !== 'arcade', 'no inventa un proyecto');
check(PERSONA.includes('22 años') && PERSONA.includes('Ingeniería en Multimedia'), 'Claude recibe edad y carrera');

console.log(`\n${pass}/${pass + fail} OK`);
process.exit(fail ? 1 : 0);
