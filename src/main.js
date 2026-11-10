// Wires everything together: renderer, avatar, behaviour, voice, brains, UI.
import * as THREE from 'three';
import { Avatar, setupLights } from './avatar/Avatar.js';
import { Behavior } from './behavior/Behavior.js';
import { Doodles } from './fx/Doodles.js';
import { PixelPass } from './fx/PixelPass.js';
import { Voice, Listener } from './speech/Voice.js';
import { MicLipSync } from './lipsync/MicLipSync.js';
import { ClaudeBrain, DemoBrain } from './ai/brains.js';
import { analyze, takeSentences, takeGestureCues } from './emotion/sentiment.js';
import { cueGesture } from './behavior/gestures.js';
import { PROFILE } from './ai/profile.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas: $('#gl'), antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
setupLights(scene);
const avatar = new Avatar(scene);
const behavior = new Behavior();
const doodles = new Doodles($('#fx'));
const pixel = new PixelPass(renderer);

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  // pixel mode: ~220 virtual pixels tall whatever the screen, doodles at the same grain
  pixel.pixelSize = Math.max(3, Math.round(h / 220));
  pixel.setSize(w, h);
  doodles.resize(w, h, pixel.enabled ? 2 / pixel.pixelSize : Math.min(2, window.devicePixelRatio));
  camera.aspect = w / h;
  // keep the bust framed on any aspect ratio
  const dist = w / h < 0.9 ? 8.6 / Math.max(0.55, w / h) * 0.8 : 6.3;
  camera.position.set(0, 1.66, dist);
  camera.lookAt(0, 1.47, 0);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// the page is pixel art only (the 3D toon render stays available for tests: ?toon)
pixel.enabled = !new URLSearchParams(location.search).has('toon');
document.body.classList.toggle('pixel-mode', pixel.enabled);
resize();

function toScreen(v) {
  const p = v.clone().project(camera);
  return { x: (p.x * 0.5 + 0.5) * stage.clientWidth, y: (-p.y * 0.5 + 0.5) * stage.clientHeight };
}

// ---------------------------------------------------------------------------
// Voice, listening, mirror mode
// ---------------------------------------------------------------------------
let subtitleTimer = null;
let spokenCount = 0;
const sentenceCues = new Map();                 // spoken sentence -> gesture asked by the brain
const voice = new Voice({
  onSentence: (s) => {
    spokenCount++;
    $('#progress').style.width = `${Math.min(100, (spokenCount / Math.max(1, spokenCount + voice.queue.length)) * 100)}%`;
    clearTimeout(subtitleTimer);
    doodles.setSubtitle(s);
    setState('speaking');
    // body language for this sentence: the reply's own cue, else one read from the words
    const cue = sentenceCues.get(s);
    sentenceCues.delete(s);
    const g = cue || cueGesture(s, 'jose');
    if (g) behavior.gesture(g, 0.15);
  },
  onIdle: () => {
    spokenCount = 0;
    $('#progress').style.width = '0%';
    subtitleTimer = setTimeout(() => doodles.setSubtitle(''), 1400);
    if (!busy) setState('idle');
    relaxLater();
  },
});
const listener = new Listener();
const mic = new MicLipSync();

let relaxTimer = null;
function relaxLater() {
  clearTimeout(relaxTimer);
  relaxTimer = setTimeout(() => { if (!voice.speaking && !busy) setEmotion('neutral'); }, 6000);
}

function setEmotion(e) {
  behavior.setEmotion(e);
  doodles.setEmotion(e);
}

const statusText = { idle: 'Listo', listening: 'Escuchando…', thinking: 'Pensando…', speaking: 'Hablando', mirror: 'Modo espejo' };
function setState(s) {
  behavior.state = s === 'mirror' ? 'idle' : s;
  $('#status').dataset.state = s;
  $('#status span').textContent = statusText[s] || s;
}

// ---------------------------------------------------------------------------
// Brain + chat
// ---------------------------------------------------------------------------
let brain = null;
let busy = false;
function makeBrain() {
  const mode = store.get('dh.mode', 'demo');
  const key = sessionKey || store.get('dh.key', '');
  brain = mode === 'claude' && key ? new ClaudeBrain(key) : new DemoBrain();
  $('#modeLabel').textContent = brain instanceof ClaudeBrain ? 'Cerebro: Claude' : 'Cerebro: modo demo';
}
let sessionKey = '';

// Questions are posted like comments; Jose's answer is a reply under each one.
// Newest thread on top, as on an old video site.
let thread = null;
function addMsg(role, text = '') {
  const li = document.createElement('li');
  li.className = role;
  const bot = role === 'bot';
  li.innerHTML = `<div class="comment">${bot ? '<img class="ava" src="assets/pixel/avatar.png" alt="">' : '<span class="ava" aria-hidden="true">🙂</span>'}
    <div><div class="meta"><b>${bot ? 'JoseDigital' : 'Tú'}</b>hace un momento <span class="emo"></span></div><div class="text"></div></div></div>`;
  li.querySelector('.text').textContent = text;
  if (role === 'user') {
    const replies = document.createElement('ol');
    replies.className = 'replies';
    li.appendChild(replies);
    $('#log').prepend(li);
    thread = li;
  } else if (thread) {
    thread.querySelector('.replies').appendChild(li);
    thread = null;
  } else {
    $('#log').prepend(li);
  }
  return li;
}

const EMO_LABEL = { neutral: 'neutral', alegria: 'alegría', sorpresa: 'sorpresa', duda: 'duda', tristeza: 'tristeza', pensativo: 'pensativo' };

let lastReply = '';
const queued = [];
let answered = 0;
async function send(text) {
  text = text.trim();
  if (!text) return;
  if (busy) { queued.push(text); return; }       // asked while he was answering: next in line
  busy = true;
  voice.stop();
  addMsg('user', text);
  // react to what the user said while thinking: face + a gesture (tilt at a question, wave back…)
  const felt = analyze(text).emotion;
  setEmotion(felt === 'neutral' ? 'pensativo' : felt);
  const heard = cueGesture(text, 'user');
  if (heard) behavior.gesture(heard);
  setState('thinking');
  const li = addMsg('bot');
  const tag = li.querySelector('.emo');
  const body = li.querySelector('.text');
  li.scrollIntoView({ block: 'nearest' });
  let raw = '';           // reply as streamed (may hold [gesto] cues)
  let spoken = 0;         // chars of `raw` already handed to the voice
  const speak = (final) => {
    const { text: clean } = takeGestureCues(raw);
    body.textContent = clean;
    // sentences are cut on the raw text so each keeps its own cue
    const { sentences, rest } = takeSentences(raw.slice(spoken));
    const chunks = final && rest.trim() ? [...sentences, rest.trim()] : sentences;
    spoken = final ? raw.length : raw.length - rest.length;
    for (const chunk of chunks) {
      const { text: s, gestures } = takeGestureCues(chunk);
      const line = s.trim();
      if (!line) { if (gestures[0]) behavior.gesture(gestures[0]); continue; }
      if (gestures[0]) sentenceCues.set(line.split(/(?<=[.!?…])\s+/)[0].trim(), gestures[0]);
      voice.say(line);                                 // start talking before the reply is complete
    }
  };
  try {
    for await (const ev of brain.reply(text)) {
      if (ev.type === 'emotion') {
        setEmotion(ev.value);
        tag.textContent = EMO_LABEL[ev.value] || ev.value;
      } else if (ev.type === 'gesture') {
        behavior.gesture(ev.value);
      } else if (ev.type === 'text') {
        raw += ev.delta;
        speak(false);
      }
    }
  } finally {
    speak(true);
    lastReply = takeGestureCues(raw).text.trim();
    $('#answered').textContent = String(++answered);
    busy = false;
    if (queued.length) setTimeout(() => send(queued.shift()), 250);
    else if (!voice.speaking) { setState('idle'); relaxLater(); }
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#input').value;
  $('#input').value = '';
  send(v);
});
$('#suggest').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') send(e.target.textContent); });
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#search').value;
  $('#search').value = '';
  $('#comments').scrollIntoView({ behavior: 'smooth', block: 'start' });
  send(v);
});

// related "videos" = Jose's projects; clicking one asks him about it
const THUMBS = { arcade: ['🕹️', '#2b1d4f'], forge: ['👾', '#1d3b4f'], lingo: ['🦜', '#1f4f2b'], melodia: ['🎸', '#4f1d2b'],
  neurotext: ['🧠', '#3d2b4f'], gamevault: ['🗄️', '#4f3b1d'], threejs: ['🧊', '#1d2b4f'], avatar: ['🤓', '#4f1d1d'] };
for (const p of PROFILE.proyectos) {
  const li = document.createElement('li');
  const [icon, color] = THUMBS[p.id] || ['📁', '#333'];
  li.innerHTML = `<button type="button"><span class="thumb" style="--c:${color}">${icon}<small>PROYECTO</small></span>
    <span><span class="t"></span><span class="d"></span></span></button>`;
  li.querySelector('.t').textContent = p.nombre;
  li.querySelector('.d').textContent = `por ${PROFILE.github} · ${p.texto.split('. ')[0].slice(0, 70)}…`;
  li.querySelector('button').addEventListener('click', () => {
    $('#comments').scrollIntoView({ behavior: 'smooth', block: 'start' });
    send(p.id === 'avatar' ? '¿Cómo estás hecho?' : `Cuéntame de ${p.nombre}`);
  });
  $('#relatedList').appendChild(li);
}

// player controls
$('#playBtn').addEventListener('click', () => {
  if (voice.speaking) { voice.stop(); return; }
  voice.say(lastReply || 'Hola, soy Jose. Hazme una pregunta en los comentarios.');
});
const syncVoiceBtn = () => {
  $('#voiceBtn').setAttribute('aria-pressed', String(voice.enabled));
  $('#voiceBtn').textContent = voice.enabled ? '🔊' : '🔇';
};
$('#voiceBtn').addEventListener('click', () => {
  voice.enabled = !voice.enabled;
  store.set('dh.voiceOn', voice.enabled ? '1' : '0');
  syncVoiceBtn();
});
$('#fsBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#player').requestFullscreen?.().catch(() => {});
});
document.addEventListener('fullscreenchange', () => requestAnimationFrame(resize));

// star rating: Jose reacts to it
const RATING_LINES = { 1: ['tristeza', 'consolar', 'Auch. Prometo mejorar en la versión 1.0.'],
  2: ['tristeza', 'encoger', 'Bueno, todavía soy una beta.'], 3: ['duda', 'ladear', 'Tres estrellas. Acepto el reto.'],
  4: ['alegria', 'asentir', '¡Cuatro estrellas! Gracias.'], 5: ['alegria', 'reir', '¡Cinco estrellas! Se lo diré a Jose ya mismo.'] };
function paintStars(n) {
  document.querySelectorAll('#rating .stars button').forEach((b) => b.classList.toggle('lit', +b.dataset.star <= n));
  $('#ratingText').textContent = n ? `Tu calificación: ${n} de 5` : 'Califica a Jose';
}
paintStars(+store.get('dh.rating', '0'));
document.querySelectorAll('#rating .stars button').forEach((b) => {
  b.addEventListener('mouseenter', () => paintStars(+b.dataset.star));
  b.addEventListener('mouseleave', () => paintStars(+store.get('dh.rating', '0')));
  b.addEventListener('click', () => {
    const n = +b.dataset.star;
    store.set('dh.rating', String(n));
    paintStars(n);
    const [emo, gesture, line] = RATING_LINES[n];
    setEmotion(emo);
    behavior.gesture(gesture);
    voice.stop();
    voice.say(line);
    relaxLater();
  });
});

$('#shareBtn').addEventListener('click', async () => {
  const url = location.href.split('#')[0];
  try {
    if (navigator.share) await navigator.share({ title: document.title, url });
    else { await navigator.clipboard.writeText(url); $('#shareBtn').textContent = '✔ Enlace copiado'; }
  } catch { /* cancelled */ }
  setTimeout(() => { $('#shareBtn').textContent = '🔗 Compartir'; }, 2000);
});

document.querySelectorAll('.emotions button').forEach((b) => b.addEventListener('click', () => {
  const lines = { neutral: 'Mmm.', alegria: '¡Qué alegría verte por aquí!', sorpresa: '¡No puede ser! ¿En serio?',
    duda: 'Mmm, no estoy tan seguro de eso.', tristeza: 'Ay, qué pena.', pensativo: 'Déjame pensarlo un momento.' };
  setEmotion(b.dataset.emo);
  voice.stop();
  voice.say(lines[b.dataset.emo]);
  relaxLater();
}));

// speech recognition
let listening = false;
$('#micBtn').addEventListener('click', () => {
  if (!listener.supported) { addMsg('bot', 'Tu navegador no soporta reconocimiento de voz. Prueba con Chrome o Edge.'); return; }
  if (listening) { listener.stop(); return; }
  voice.stop();
  listening = true;
  $('#micBtn').classList.add('on');
  setState('listening');
  listener.start({
    onInterim: (t) => { $('#input').value = t; },
    onFinal: (t) => { $('#input').value = ''; send(t); },
    onEnd: () => { listening = false; $('#micBtn').classList.remove('on'); if (!busy && !voice.speaking) setState('idle'); },
  });
});

// mirror mode: lip-sync to your own voice
$('#mirrorBtn').addEventListener('click', async () => {
  if (mic.active) { mic.stop(); $('#mirrorBtn').classList.remove('on'); $('#mirrorBtn').textContent = '🪞 Modo espejo'; setState('idle'); return; }
  try {
    voice.stop();
    await mic.start();
    $('#mirrorBtn').classList.add('on');
    $('#mirrorBtn').textContent = '⏹ Detener espejo';
    setState('mirror');
  } catch {
    addMsg('bot', 'No pude acceder al micrófono. Revisa los permisos del navegador.');
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const dlg = $('#settings');
function syncSettingsForm() {
  const mode = store.get('dh.mode', 'demo');
  $('#modeSel').value = mode;
  dlg.querySelector('.settings').classList.toggle('claude', mode === 'claude');
  $('#apiKey').value = sessionKey || store.get('dh.key', '');
  $('#rememberKey').checked = !!store.get('dh.key', '');
  $('#rate').value = voice.rate;
  $('#voiceOn').checked = voice.enabled;
  const sel = $('#voiceSel');
  sel.innerHTML = '';
  for (const v of voice.voices || []) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})`;
    o.selected = voice.voice && v.name === voice.voice.name;
    sel.appendChild(o);
  }
  if (!sel.options.length) sel.innerHTML = '<option>Sin voces en español: modo subtítulos</option>';
}
$('#settingsBtn').addEventListener('click', () => { syncSettingsForm(); dlg.showModal(); });
$('#modeSel').addEventListener('change', () => dlg.querySelector('.settings').classList.toggle('claude', $('#modeSel').value === 'claude'));
dlg.addEventListener('close', () => {
  store.set('dh.mode', $('#modeSel').value);
  sessionKey = $('#apiKey').value.trim();
  if ($('#rememberKey').checked && sessionKey) store.set('dh.key', sessionKey); else store.del('dh.key');
  voice.rate = parseFloat($('#rate').value);
  voice.enabled = $('#voiceOn').checked;
  syncVoiceBtn();
  const v = (voice.voices || []).find((x) => x.name === $('#voiceSel').value);
  if (v) voice.voice = v;
  store.set('dh.rate', voice.rate);
  store.set('dh.voiceOn', voice.enabled ? '1' : '0');
  makeBrain();
});
voice.rate = parseFloat(store.get('dh.rate', '1.05'));
voice.enabled = store.get('dh.voiceOn', '1') === '1';
syncVoiceBtn();
makeBrain();

// ---------------------------------------------------------------------------
// Pointer -> gaze
// ---------------------------------------------------------------------------
let headScreen = { x: 0, y: 0, r: 100 };
window.addEventListener('pointermove', (e) => {
  const rect = stage.getBoundingClientRect();
  const nx = (e.clientX - rect.left - headScreen.x) / (rect.width * 0.5);
  const ny = (e.clientY - rect.top - headScreen.y) / (rect.height * 0.5);
  behavior.pointer(nx * 1.4, ny * 1.4, performance.now() / 1000);
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
let last = performance.now();
function frame(nowMs) {
  const dt = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  const t = nowMs / 1000;
  if (avatar.ready) {
    const mouth = mic.active ? mic.frame() : voice.frame(nowMs);
    behavior.setMouth(mouth);
    const out = behavior.update(dt, t);
    avatar.setHead(out.head.yaw, out.head.pitch, out.head.roll);
    avatar.setMorph('cheeks_up', out.morphs.cheeks_up);
    avatar.setMorph('squash', out.morphs.squash);
    avatar.root.position.y = out.breathe * 0.6 + out.lift;
    avatar.drawFace(out.face, t);
    const c = toScreen(avatar.headPoint(0, 0.55, 0));
    const e = toScreen(avatar.headPoint(0.62, 0.55, 0));
    headScreen = { x: c.x, y: c.y, r: Math.abs(e.x - c.x) };
    doodles.draw({ time: t, dt, head: headScreen, thinking: behavior.state === 'thinking',
      listening: behavior.state === 'listening' || mic.active, level: mic.level });
  }
  pixel.render(scene, camera);
  requestAnimationFrame(frame);
}

avatar.load('assets/models/jose.glb', 'assets/models/face.json').then(() => {
  $('#loading').classList.add('hidden');
  window.__dh.ready = true;
  setTimeout(() => {
    setEmotion('alegria');
    behavior.gesture('saludar');
    voice.say('¡Hola! Soy Jose, bueno, mi versión digital. Pregúntame lo que quieras sobre mí: mis proyectos, mi carrera o mis metas.');
  }, 600);
}).catch((err) => {
  $('#loading').textContent = 'No se pudo cargar el modelo 3D.';
  console.error(err);
});
requestAnimationFrame(frame);

// test / debug handle
window.__dh = { ready: false, behavior, voice, avatar, send, setEmotion, doodles, pixel, scene, camera, get busy() { return busy; } };
