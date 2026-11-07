// Wires everything together: renderer, avatar, behaviour, voice, brains, UI.
import * as THREE from 'three';
import { Avatar, setupLights } from './avatar/Avatar.js';
import { Behavior } from './behavior/Behavior.js';
import { Doodles } from './fx/Doodles.js';
import { Voice, Listener } from './speech/Voice.js';
import { MicLipSync } from './lipsync/MicLipSync.js';
import { ClaudeBrain, DemoBrain } from './ai/brains.js';
import { analyze, takeSentences } from './emotion/sentiment.js';

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

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  doodles.resize(w, h, Math.min(2, window.devicePixelRatio));
  camera.aspect = w / h;
  // keep the bust framed on any aspect ratio
  const dist = w / h < 0.9 ? 8.6 / Math.max(0.55, w / h) * 0.8 : 7.4;
  camera.position.set(0, 1.62, dist);
  camera.lookAt(0, 1.5, 0);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function toScreen(v) {
  const p = v.clone().project(camera);
  return { x: (p.x * 0.5 + 0.5) * stage.clientWidth, y: (-p.y * 0.5 + 0.5) * stage.clientHeight };
}

// ---------------------------------------------------------------------------
// Voice, listening, mirror mode
// ---------------------------------------------------------------------------
let subtitleTimer = null;
const voice = new Voice({
  onSentence: (s) => { clearTimeout(subtitleTimer); doodles.setSubtitle(s); setState('speaking'); },
  onIdle: () => {
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
  $('#modeLabel').textContent = brain instanceof ClaudeBrain ? 'Claude · claude-opus-5-5' : 'Modo demo (sin API key)';
}
let sessionKey = '';

function addMsg(role, text = '') {
  const li = document.createElement('li');
  li.className = role;
  li.textContent = text;
  $('#log').appendChild(li);
  $('#log').scrollTop = $('#log').scrollHeight;
  return li;
}

const EMO_LABEL = { neutral: 'neutral', alegria: 'alegría', sorpresa: 'sorpresa', duda: 'duda', tristeza: 'tristeza', pensativo: 'pensativo' };

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  voice.stop();
  addMsg('user', text);
  $('#suggest').style.display = 'none';
  // react to what the user said while thinking
  const felt = analyze(text).emotion;
  setEmotion(felt === 'neutral' ? 'pensativo' : felt);
  setState('thinking');
  const li = addMsg('bot');
  const tag = document.createElement('span');
  tag.className = 'emo';
  const body = document.createElement('span');
  li.append(tag, body);
  let pending = '';
  try {
    for await (const ev of brain.reply(text)) {
      if (ev.type === 'emotion') {
        setEmotion(ev.value);
        tag.textContent = EMO_LABEL[ev.value] || ev.value;
      } else if (ev.type === 'text') {
        body.textContent += ev.delta;
        pending += ev.delta;
        const { sentences, rest } = takeSentences(pending);
        pending = rest;
        for (const s of sentences) voice.say(s);       // start talking before the reply is complete
        $('#log').scrollTop = $('#log').scrollHeight;
      }
    }
  } finally {
    if (pending.trim()) voice.say(pending.trim());
    busy = false;
    if (!voice.speaking) { setState('idle'); relaxLater(); }
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#input').value;
  $('#input').value = '';
  send(v);
});
$('#suggest').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') send(e.target.textContent); });

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
  if (mic.active) { mic.stop(); $('#mirrorBtn').classList.remove('on'); setState('idle'); return; }
  try {
    voice.stop();
    await mic.start();
    $('#mirrorBtn').classList.add('on');
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
  const v = (voice.voices || []).find((x) => x.name === $('#voiceSel').value);
  if (v) voice.voice = v;
  store.set('dh.rate', voice.rate);
  store.set('dh.voiceOn', voice.enabled ? '1' : '0');
  makeBrain();
});
voice.rate = parseFloat(store.get('dh.rate', '1.05'));
voice.enabled = store.get('dh.voiceOn', '1') === '1';
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
    avatar.root.position.y = out.breathe * 0.6;
    avatar.drawFace(out.face, t);
    const c = toScreen(avatar.headPoint(0, 0.55, 0));
    const e = toScreen(avatar.headPoint(0.62, 0.55, 0));
    headScreen = { x: c.x, y: c.y, r: Math.abs(e.x - c.x) };
    doodles.draw({ time: t, dt, head: headScreen, thinking: behavior.state === 'thinking',
      listening: behavior.state === 'listening' || mic.active, level: mic.level });
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

avatar.load('assets/models/jose.glb', 'assets/models/face.json').then(() => {
  $('#loading').classList.add('hidden');
  window.__dh.ready = true;
  setTimeout(() => {
    setEmotion('alegria');
    voice.say('¡Hola! Soy Jose, versión digital. Mueve el ratón y te sigo con la mirada.');
  }, 600);
}).catch((err) => {
  $('#loading').textContent = 'No se pudo cargar el modelo 3D.';
  console.error(err);
});
requestAnimationFrame(frame);

// test / debug handle
window.__dh = { ready: false, behavior, voice, avatar, send, setEmotion, doodles };
