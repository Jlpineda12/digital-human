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
  // (bust centred in the stage, head near the spotlight)
  const portrait = w / h < 0.9;
  const dist = portrait ? 8.6 / Math.max(0.55, w / h) * 0.62 : 6.2;
  const lookY = portrait ? 1.5 : 1.52;
  camera.position.set(0, lookY + 0.19, dist);
  camera.lookAt(0, lookY, 0);
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
// Chat + voice (procedural blips by default)
// ---------------------------------------------------------------------------
const log = $('#log');
function addMsg(role, text = '') {
  const li = document.createElement('li');
  li.className = role;
  li.innerHTML = role === 'bot' ? '<span class="who">JOSE</span><span class="text"></span>' : '<span class="text"></span>';
  li.querySelector('.text').textContent = text;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
  return li;
}

// Jose's current chat bubble fills in sentence by sentence, letter by letter,
// in step with the voice.
let bubble = null;          // <li> being spoken into
let bubblePrefix = '';      // sentences of this bubble already finished
let line = '';              // sentence being said right now
let pendingFull = '';       // full text of the next say(), kept if he gets interrupted
const setBubbleText = (t) => {
  if (!bubble) return;
  bubble.querySelector('.text').textContent = t;
  log.scrollTop = log.scrollHeight;
};
/** Interrupted mid-sentence: the chat still keeps everything he meant to say. */
function completeBubble() {
  if (bubble && bubble.dataset.full) { bubble.querySelector('.text').textContent = bubble.dataset.full; }
  if (bubble) bubble.classList.remove('typing');
  line = '';
}
function finishLine() {
  if (bubble && line) { bubblePrefix += `${line} `; setBubbleText(bubblePrefix.trim()); }
  line = '';
}

const sentenceCues = new Map();                 // spoken sentence -> gesture asked by the brain
const voice = new Voice({
  onSentence: (s) => {
    finishLine();
    if (!bubble) { bubble = addMsg('bot'); bubblePrefix = ''; bubble.dataset.full = pendingFull; pendingFull = ''; }
    bubble.classList.remove('thinking');
    bubble.classList.add('typing');
    line = s;
    setState('speaking');
    // body language for this sentence: the reply's own cue, else one read from the words
    const cue = sentenceCues.get(s);
    sentenceCues.delete(s);
    const g = cue || cueGesture(s, 'jose');
    if (g) behavior.gesture(g, 0.15);
  },
  onIdle: () => {
    finishLine();
    if (bubble) bubble.classList.remove('typing');
    if (!busy) { bubble = null; setState('idle'); }
    relaxLater();
  },
});
const listener = new Listener();
const mic = new MicLipSync();

// browsers only allow sound after a user gesture: unlock on the first one
const unlock = () => voice.unlock();
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

let relaxTimer = null;
function relaxLater() {
  clearTimeout(relaxTimer);
  relaxTimer = setTimeout(() => { if (!voice.speaking && !busy) setEmotion('neutral'); }, 6000);
}

function setEmotion(e) {
  behavior.setEmotion(e);
  doodles.setEmotion(e);
  voice.mood = e;                               // the blips follow his mood
}

const presenceText = { idle: 'en línea', listening: 'escuchando…', thinking: 'pensando…', speaking: 'hablando…', mirror: 'modo espejo' };
function setState(s) {
  behavior.state = s === 'mirror' ? 'idle' : s;
  $('#presence').textContent = presenceText[s] || s;
}

/** Jose says something outside a question (greeting, errors). */
function say(text) {
  completeBubble();
  voice.stop();
  bubble = null;
  pendingFull = text;
  voice.say(text);
}

// ---------------------------------------------------------------------------
// Brain + the gesture sequence of every question:
//   1. react to the question (tilt at a question, wave back at a greeting…)
//   2. think: chin up, eyes up, "..." in the chat (the brain works meanwhile)
//   3. a doubtful question gets the doubt face + gesture before the answer
//   4. answer, with a gesture per sentence
// ---------------------------------------------------------------------------
let brain = null;
let busy = false;
let sessionKey = '';
function makeBrain() {
  const mode = store.get('dh.mode', 'demo');
  const key = sessionKey || store.get('dh.key', '');
  brain = mode === 'claude' && key ? new ClaudeBrain(key) : new DemoBrain();
}

const TIMING = { react: 750, think: 1400, doubt: 950 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUESTION = /[?¿]|^\s*(que|qué|como|cómo|cual|cuál|cuales|cuáles|cuando|cuándo|donde|dónde|quien|quién|por que|por qué|cuantos|cuántos)\b/i;

let lastReply = '';
const queued = [];
async function send(text) {
  text = text.trim();
  if (!text) return;
  if (busy) { queued.push(text); return; }       // asked while he was answering: next in line
  busy = true;
  completeBubble();
  voice.stop();
  $('#starters').hidden = true;
  addMsg('user', text);
  bubble = null;
  bubblePrefix = '';
  line = '';

  // the brain starts right away; its events wait while Jose reacts and thinks
  const events = [];
  let ended = false;
  let wake = null;
  (async () => {
    try { for await (const ev of brain.reply(text)) { events.push(ev); wake?.(); } } finally { ended = true; wake?.(); }
  })();
  const nextEvent = async () => {
    while (!events.length && !ended) await new Promise((r) => { wake = r; });
    return events.shift() || null;
  };

  let raw = '';           // reply as streamed (may hold [gesto] cues)
  let spoken = 0;         // chars of `raw` already handed to the voice
  const speak = (final) => {
    const { sentences, rest } = takeSentences(raw.slice(spoken));
    const chunks = final && rest.trim() ? [...sentences, rest.trim()] : sentences;
    spoken = final ? raw.length : raw.length - rest.length;
    for (const chunk of chunks) {
      const { text: s, gestures } = takeGestureCues(chunk);
      const ln = s.trim();
      if (!ln) { if (gestures[0]) behavior.gesture(gestures[0]); continue; }
      if (gestures[0]) sentenceCues.set(ln.split(/(?<=[.!?…])\s+/)[0].trim(), gestures[0]);
      voice.say(ln);
    }
  };

  try {
    // 1. react
    setEmotion(analyze(text).emotion);
    behavior.gesture(cueGesture(text, 'user') || (QUESTION.test(text) ? 'ladear' : 'asentir'));
    setState('listening');
    await sleep(TIMING.react);

    // 2. think
    setEmotion('pensativo');
    behavior.gesture('pensando');
    setState('thinking');
    bubble = addMsg('bot', '...');
    bubble.classList.add('thinking');
    const t0 = performance.now();
    let emotion = null;
    let gesture = null;
    let first = null;
    for (let ev = await nextEvent(); ev; ev = await nextEvent()) {
      if (ev.type === 'emotion') emotion = ev.value;
      else if (ev.type === 'gesture') gesture = ev.value;
      else if (ev.type === 'text') { first = ev; break; }
    }
    await sleep(Math.max(0, TIMING.think - (performance.now() - t0)));

    // 3. doubt first, when the question is doubtful
    if (emotion === 'duda') {
      setEmotion('duda');
      behavior.gesture('dudar');
      await sleep(TIMING.doubt);
    }
    if (emotion) setEmotion(emotion);
    if (gesture && gesture !== 'dudar') behavior.gesture(gesture);

    // 4. answer
    if (first) { raw += first.delta; speak(false); }
    for (let ev = await nextEvent(); ev; ev = await nextEvent()) {
      if (ev.type === 'emotion') setEmotion(ev.value);
      else if (ev.type === 'gesture') behavior.gesture(ev.value);
      else if (ev.type === 'text') { raw += ev.delta; speak(false); }
    }
  } finally {
    speak(true);
    lastReply = takeGestureCues(raw).text.trim();
    if (bubble && !lastReply) { bubble.remove(); bubble = null; }
    if (bubble) bubble.dataset.full = lastReply;
    busy = false;
    if (!voice.speaking) { finishLine(); if (bubble) bubble.classList.remove('typing', 'thinking'); bubble = null; }
    if (queued.length) setTimeout(() => send(queued.shift()), 250);
    else if (!voice.speaking) { setState('idle'); relaxLater(); }
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  voice.unlock();
  const v = $('#input').value;
  $('#input').value = '';
  send(v);
});
$('#starters').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { voice.unlock(); send(e.target.textContent); } });

const syncVoiceBtn = () => { $('#voiceBtn').setAttribute('aria-pressed', String(voice.enabled)); };
$('#voiceBtn').addEventListener('click', () => {
  voice.enabled = !voice.enabled;
  if (!voice.enabled) voice.blips.stop();
  store.set('dh.voiceOn', voice.enabled ? '1' : '0');
  syncVoiceBtn();
});

// speech recognition
let listening = false;
$('#micBtn').addEventListener('click', () => {
  if (!listener.supported) { say('Tu navegador no me deja escucharte. Prueba con Chrome o Edge.'); return; }
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
  if (mic.active) { mic.stop(); $('#mirrorBtn').setAttribute('aria-pressed', 'false'); setState('idle'); return; }
  try {
    voice.stop();
    await mic.start();
    $('#mirrorBtn').setAttribute('aria-pressed', 'true');
    setState('mirror');
  } catch {
    say('No pude usar el micrófono. Revisa los permisos del navegador.');
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const dlg = $('#settings');
const form = dlg.querySelector('.settings');
function syncSettingsForm() {
  const mode = store.get('dh.mode', 'demo');
  $('#modeSel').value = mode;
  form.classList.toggle('claude', mode === 'claude');
  $('#apiKey').value = sessionKey || store.get('dh.key', '');
  $('#rememberKey').checked = !!store.get('dh.key', '');
  $('#voiceMode').value = voice.mode;
  form.classList.toggle('tts', voice.mode === 'tts');
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
  if (!sel.options.length) sel.innerHTML = '<option>Sin voces en español</option>';
}
$('#settingsBtn').addEventListener('click', () => { syncSettingsForm(); dlg.showModal(); });
$('#modeSel').addEventListener('change', () => form.classList.toggle('claude', $('#modeSel').value === 'claude'));
$('#voiceMode').addEventListener('change', () => form.classList.toggle('tts', $('#voiceMode').value === 'tts'));
dlg.addEventListener('close', () => {
  store.set('dh.mode', $('#modeSel').value);
  sessionKey = $('#apiKey').value.trim();
  if ($('#rememberKey').checked && sessionKey) store.set('dh.key', sessionKey); else store.del('dh.key');
  voice.mode = $('#voiceMode').value;
  voice.rate = parseFloat($('#rate').value);
  voice.enabled = $('#voiceOn').checked;
  syncVoiceBtn();
  const v = (voice.voices || []).find((x) => x.name === $('#voiceSel').value);
  if (v) voice.voice = v;
  store.set('dh.voiceMode', voice.mode);
  store.set('dh.rate', voice.rate);
  store.set('dh.voiceOn', voice.enabled ? '1' : '0');
  makeBrain();
});
voice.mode = store.get('dh.voiceMode', 'blips');
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
    // chat bubble typewriter, in step with the voice
    if (voice.speaking && line && bubble) {
      const n = voice.revealed(nowMs);
      const shown = bubblePrefix + line.slice(0, n);
      if (bubble.querySelector('.text').textContent !== shown) setBubbleText(shown);
    }
    // the light behind him follows his head (colour framing stays on the face)
    stage.style.setProperty('--spot-y', `${Math.round((headScreen.y / stage.clientHeight) * 100)}%`);
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
    say('¡Hola! Soy Jose, bueno, mi versión digital. Pregúntame lo que quieras.');
  }, 600);
}).catch((err) => {
  $('#loading').textContent = 'No se pudo cargar el modelo 3D.';
  console.error(err);
});
requestAnimationFrame(frame);

// test / debug handle
window.__dh = { TIMING, ready: false, behavior, voice, avatar, send, setEmotion, doodles, pixel, scene, camera,
  get busy() { return busy; }, get lastReply() { return lastReply; } };
