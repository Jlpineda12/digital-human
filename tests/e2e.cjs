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
  const samples = [];
  for (let i = 0; i < 30; i++) { samples.push(await mouthSig()); await page.waitForTimeout(70); }
  const maxOpen = Math.max(...samples);
  const distinct = new Set(samples).size;
  check(maxOpen > closed * 1.6, `la boca se abre al hablar (área ${closed} → ${maxOpen} px)`);
  check(distinct > 8, `lip-sync con ${distinct} formas de boca distintas en 2 s`);
  const bot = await page.textContent('#log li.bot:last-child');
  check(/gemelo|Jose|digital/i.test(bot), 'respuesta del cerebro demo en el chat');
  const emo = await page.evaluate(() => window.__dh.behavior.emotion);
  check(emo === 'alegria', `emoción desde la respuesta (saludo → alegría): ${emo}`);
  await page.screenshot({ path: path.join(out, 'talking.png') });

  // gaze follows the pointer
  await page.evaluate(() => window.__dh.voice.stop());
  await page.mouse.move(80, 120);
  await page.waitForTimeout(900);
  const leftYaw = await page.evaluate(() => window.__dh.avatar.headPivot.rotation.y);
  await page.mouse.move(820, 650);
  await page.waitForTimeout(900);
  const rightYaw = await page.evaluate(() => window.__dh.avatar.headPivot.rotation.y);
  check(leftYaw < -0.05 && rightYaw > 0.05, `la cabeza sigue al cursor (yaw ${leftYaw.toFixed(2)} → ${rightYaw.toFixed(2)})`);

  const pupil = await page.evaluate(() => { const o = window.__dh.behavior.update(0.05, performance.now() / 1000); return [o.face.pupilX, o.face.pupilY]; });
  check(Math.abs(pupil[0]) <= 1.2 && Math.abs(pupil[1]) <= 1.2, `pupilas dentro del ojo (${pupil.map((v) => v.toFixed(2)).join(', ')})`);

  // blink happens within a few seconds
  const lids = [];
  for (let i = 0; i < 70; i++) { lids.push(await page.evaluate(() => window.__dh.behavior.blinkT)); await page.waitForTimeout(100); }
  check(lids.some((v) => v > 0), 'parpadeo espontáneo');

  // emotions
  for (const e of ['neutral', 'alegria', 'sorpresa', 'duda', 'tristeza', 'pensativo']) {
    await page.evaluate((x) => { window.__dh.voice.stop(); window.__dh.setEmotion(x); }, e);
    await page.mouse.move(640, 380);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(out, `emo-${e}.png`), clip: { x: 220, y: 60, width: 520, height: 640 } });
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
