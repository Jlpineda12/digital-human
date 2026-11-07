// Records docs/demo.gif: greeting + a question + emotion tour (headless Chromium).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'docs', '_frames');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 880, height: 700 } });
  await p.goto(process.argv[2] || 'http://localhost:8095/');
  await p.waitForFunction(() => window.__dh && window.__dh.ready, null, { timeout: 30000 });
  await p.evaluate(() => { document.querySelector('.chat').style.display = 'none'; window.dispatchEvent(new Event('resize')); });
  let n = 0;
  const snap = async (count, gap = 90, mouse = null) => {
    for (let i = 0; i < count; i++) {
      if (mouse) await p.mouse.move(...mouse(i));
      await p.screenshot({ path: path.join(out, `f${String(n++).padStart(3, '0')}.png`), clip: { x: 190, y: 40, width: 500, height: 600 } });
      await p.waitForTimeout(gap);
    }
  };
  await snap(18);
  await p.evaluate(() => { window.__dh.voice.stop(); window.__dh.send('¿Cómo funciona tu boca?'); });
  await snap(30, 80);
  for (const e of ['sorpresa', 'duda', 'tristeza', 'alegria']) {
    await p.evaluate((x) => { window.__dh.voice.stop(); window.__dh.setEmotion(x); }, e);
    await snap(5, 90, (i) => [200 + i * 120, 200 + (i % 2) * 300]);
  }
  await b.close();
  console.log('frames', n);
})();
