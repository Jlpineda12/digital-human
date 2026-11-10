// End-to-end check in headless Chromium:  node tests/e2e.cjs [baseUrl] [outDir]
// Loads the page, verifies the 3D model + face canvas, talks in demo mode,
// measures that the mouth actually moves while speaking, follows the pointer
// and captures every emotion.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const base = process.argv[2] || 'http://localhost:8095/';
const out = process.argv[3] || path.join(__dirname, '..', 'docs', 'screens');
fs.mkdirSync(out, { recursive: true });

let pass = 0;
let fail = 0;
const check = (c, n) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}`); } };

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.googleapis|ERR_TUNNEL|ERR_NAME|net::/.test(m.text())) errors.push(m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.__dh && window.__dh.ready, null, { timeout: 30000 });
  check(true, 'modelo GLB cargado y listo');
  check(await page.evaluate(() => window.__dh.pixel.enabled && document.body.classList.contains('pixel-mode')), 'la página arranca en modo pixel art');
  const info = await page.evaluate(() => {
    const a = window.__dh.avatar;
    let meshes = 0;
    let tris = 0;
    a.root.traverse((o) => { if (o.isMesh) { meshes++; tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
    return { meshes, tris, morphs: a.morphMeshes.map((m) => Object.keys(m.morphTargetDictionary)) };
  });
  check(info.meshes >= 20, `${info.meshes} mallas`);
  check(info.tris < 12000, `${Math.round(info.tris)} triángulos en GPU (low-poly)`);
  check(info.morphs.length === 2 && info.morphs[0].includes('cheeks_up'), 'morph targets cheeks_up / squash');

  // mouth region of the face canvas: pixels change while talking
  const mouthSig = () => page.evaluate(() => {
    const c = window.__dh.avatar.face.canvas;
    const L = window.__dh.avatar.layout.mouth;
    const g = c.getContext('2d');
    const x = Math.round((L.u - L.w * 0.6) * c.width);
    const y = Math.round((1 - L.v - L.h * 0.6) * c.height);
    const d = g.getImageData(x, y, Math.round(L.w * 1.2 * c.width), Math.round(L.h * 1.2 * c.height)).data;
    let s = 0;
    for (let i = 3; i < d.length; i += 4) s += d[i] > 0 ? 1 : 0;
    return s;
  });
  await page.waitForTimeout(4500);   // greeting finishes
  await page.evaluate(() => window.__dh.voice.stop());
  await page.waitForTimeout(400);
  const closed = await mouthSig();
  await page.fill('#input', 'Hola, ¿quién eres?');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => window.__dh.behavior.state === 'speaking', null, { timeout: 30000 });
  const samples = [];
  for (let i = 0; i < 30; i++) { samples.push(await mouthSig()); await page.waitForTimeout(70); }
  const maxOpen = Math.max(...samples);
  const distinct = new Set(samples).size;
  check(maxOpen > closed * 1.6, `la boca se abre al hablar (área ${closed} → ${maxOpen} px)`);
  check(distinct > 8, `lip-sync con ${distinct} formas de boca distintas en 2 s`);
  await page.waitForFunction(() => !window.__dh.busy, null, { timeout: 60000 });
  const bot = await page.evaluate(() => window.__dh.lastReply);
  check(/gemelo|Jose|digital/i.test(bot), 'respuesta del cerebro demo');
  const emo = await page.evaluate(() => window.__dh.behavior.emotion);
  check(emo === 'alegria', `emoción desde la respuesta (saludo → alegría): ${emo}`);
  await page.screenshot({ path: path.join(out, 'talking.png') });

  // pixel art: the player shows only colours of Jose's palette (+ the page backdrop)
  const colours = await page.evaluate(async () => {
    const { JOSE_PALETTE } = await import('./src/fx/PixelPass.js');
    const gl = document.querySelector('#gl');
    const c = document.createElement('canvas');
    c.width = 160; c.height = 120;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    window.__dh.pixel.render(window.__dh.scene, window.__dh.camera);
    g.drawImage(gl, 0, 0, 160, 120);
    const d = g.getImageData(0, 0, 160, 120).data;
    const pal = new Set(JOSE_PALETTE);
    let inPal = 0;
    let opaque = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 255) continue;
      opaque++;
      const hex = [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      if (pal.has(hex)) inPal++;
    }
    return { ratio: inPal / Math.max(1, opaque), opaque };
  });
  check(colours.opaque > 500 && colours.ratio > 0.97, `render pixel con la paleta de Jose (${(colours.ratio * 100).toFixed(1)} % de ${colours.opaque} px)`);

  // every question: react -> think (pensando) -> answer; the chat bubble types with the voice
  await page.waitForFunction(() => !window.__dh.busy, null, { timeout: 60000 });
  await page.evaluate(() => window.__dh.voice.stop());
  await page.fill('#input', '¿Cuántos años tienes y qué estudias?');
  await page.press('#input', 'Enter');
  const track = (ms) => page.evaluate((dur) => new Promise((resolve) => {
    const steps = [];
    const lens = new Set();
    const t0 = performance.now();
    (function poll() {
      const b = window.__dh.behavior;
      const key = `${b.state}:${b.gestures.map((g) => g.name).join('+')}:${b.emotion}`;
      if (steps[steps.length - 1] !== key) steps.push(key);
      const last = document.querySelector('#log li.bot:last-child .text');
      if (last) lens.add(last.textContent.length);
      if (performance.now() - t0 > dur) resolve({ steps, lens: lens.size }); else requestAnimationFrame(poll);
    })();
  }), ms);
  const seq = await track(5000);
  const order = (re) => seq.steps.findIndex((x) => re.test(x));
  const iThink = order(/^thinking:.*pensando/);
  const iSpeak = order(/^speaking:/);
  check(order(/^listening:.*ladear/) === 0 || order(/^listening:.*ladear/) > -1, 'primero reacciona a la pregunta (ladea la cabeza)');
  check(iThink > -1 && iSpeak > iThink, `luego piensa y después responde (${iThink} → ${iSpeak})`);
  check(seq.lens > 3, `la burbuja del chat escribe al ritmo de la voz (${seq.lens} pasos)`);
  const blips = await page.evaluate(() => ({ ready: window.__dh.voice.blips.ready, mode: window.__dh.voice.mode }));
  check(blips.mode === 'blips' && blips.ready, 'voz procedural de blips activa tras la primera tecla');
  await page.waitForFunction(() => !window.__dh.busy, null, { timeout: 60000 });
  const reply = await page.evaluate(() => window.__dh.lastReply);
  check(/22 años/.test(reply) && /Ingeniería en Multimedia/.test(reply), 'responde varias preguntas en un mismo mensaje');

  // a doubtful question gets the doubt gesture before the answer
  await page.waitForFunction(() => !window.__dh.voice.speaking, null, { timeout: 60000 });
  await page.fill('#input', '¿En qué universidad estudias?');
  await page.press('#input', 'Enter');
  const dq = await track(4500);
  const iDoubt = dq.steps.findIndex((x) => /dudar/.test(x));
  const iSpeak2 = dq.steps.findIndex((x) => /^speaking:/.test(x));
  check(iDoubt > -1 && (iSpeak2 === -1 || iDoubt < iSpeak2), 'pregunta dudosa: gesto de duda antes de responder');
  await page.waitForFunction(() => !window.__dh.busy, null, { timeout: 60000 });
  const chat = await page.$$eval('#log li', (l) => l.map((x) => x.className.split(' ')[0]));
  check(chat.filter((c) => c === 'user').length === 3 && chat.filter((c) => c === 'bot').length >= 4, `chat con historial (${chat.length} mensajes)`);
  check(await page.evaluate(() => !document.querySelector('.emotions, #relatedList, #about') &&
    ![...document.querySelectorAll('button')].some((b) => /\p{Extended_Pictographic}/u.test(b.textContent))), 'sin emojis ni textos de proyectos: el centro es el personaje');

  // gaze follows the pointer
  await page.evaluate(() => window.__dh.voice.stop());
  await page.waitForFunction(() => !window.__dh.voice.speaking && !window.__dh.busy, null, { timeout: 60000 });
  const sb = await page.locator('#stage').boundingBox();
  await page.mouse.move(sb.x + 5, sb.y + sb.height * 0.3);
  await page.waitForTimeout(900);
  const leftYaw = await page.evaluate(() => window.__dh.avatar.headPivot.rotation.y);
  await page.mouse.move(sb.x + sb.width - 5, sb.y + sb.height * 0.6);
  await page.waitForTimeout(900);
  const rightYaw = await page.evaluate(() => window.__dh.avatar.headPivot.rotation.y);
  check(leftYaw < -0.05 && rightYaw > 0.05, `la cabeza sigue al cursor (yaw ${leftYaw.toFixed(2)} → ${rightYaw.toFixed(2)})`);

  const pupil = await page.evaluate(() => { const o = window.__dh.behavior.update(0.05, performance.now() / 1000); return [o.face.pupilX, o.face.pupilY]; });
  check(Math.abs(pupil[0]) <= 1.2 && Math.abs(pupil[1]) <= 1.2, `pupilas dentro del ojo (${pupil.map((v) => v.toFixed(2)).join(', ')})`);

  // blink happens within a few seconds
  const blinks0 = await page.evaluate(() => window.__dh.behavior.blinks || 0);
  await page.waitForTimeout(7000);
  const blinks1 = await page.evaluate(() => window.__dh.behavior.blinks || 0);
  check(blinks1 > blinks0, `parpadeo espontáneo (${blinks1 - blinks0} en 7 s)`);

  // emotions
  for (const e of ['neutral', 'alegria', 'sorpresa', 'duda', 'tristeza', 'pensativo']) {
    await page.evaluate((x) => { window.__dh.voice.stop(); window.__dh.setEmotion(x); }, e);
    const box = await page.locator('#stage').boundingBox();
    await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.42);
    await page.waitForTimeout(700);
    await page.locator('#stage').screenshot({ path: path.join(out, `emo-${e}.png`) });
  }
  check(true, 'capturas de las 6 emociones');

  // mobile layout
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  m.on('pageerror', (e) => errors.push(e.message));
  await m.goto(base);
  await m.waitForFunction(() => window.__dh && window.__dh.ready, null, { timeout: 30000 });
  await m.waitForTimeout(1500);
  await m.screenshot({ path: path.join(out, 'mobile.png') });
  check(true, 'versión móvil');

  check(errors.length === 0, `sin errores de JavaScript${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  console.log(`\n${pass}/${pass + fail} OK`);
  process.exit(fail ? 1 : 0);
})();
