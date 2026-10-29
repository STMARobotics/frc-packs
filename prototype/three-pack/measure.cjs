// Plays the WebGL pack opening on a mid-range phone profile (390x844, CPU 4x slower): a short swipe that lets go early
// (it must close again), a full tear, then a tap through every card. Saves shots/*.png and reports frame times.
//   node prototype/three-pack/measure.cjs
const { chromium } = require('playwright');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIR = __dirname, types = { '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png' };
fs.mkdirSync(path.join(DIR, 'shots'), { recursive: true });
const srv = http.createServer((q, r) => { const f = path.join(DIR, decodeURIComponent(q.url.split('?')[0]).replace(/^\/$/, '/index.html')); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); }).listen(0);
const ok = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok  ' + m); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(m.text()); });
  await p.goto(`http://127.0.0.1:${srv.address().port}/`); await p.waitForTimeout(2500);
  const stage = p.locator('#stage'); const b = await stage.boundingBox();
  const shot = (n) => stage.screenshot({ path: path.join(DIR, 'shots', `${n}.png`) });
  const st = () => p.evaluate(() => window.__state());
  const topY = b.y + b.height * 0.17;
  // A short swipe, let go: it closes again.
  await p.mouse.move(b.x + b.width * 0.18, topY); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(b.x + b.width * 0.18 + i * 14, topY);
  await p.waitForTimeout(100); await shot('1-tearing');
  await p.mouse.up(); await p.waitForTimeout(600);
  ok((await st()).tear === 0 && (await st()).phase === 'pack', 'letting go early closes the pack again');
  // The full tear, on the slow CPU, timed.
  const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.mouse.move(b.x + b.width * 0.15, topY); await p.mouse.down();
  for (let i = 1; i <= 24; i++) { await p.mouse.move(b.x + b.width * 0.15 + i * 9, topY + Math.sin(i / 4) * 3); await p.waitForTimeout(16); if (i === 16) await shot('2-light'); }
  await p.mouse.up();
  await p.waitForTimeout(450); await shot('3-opening');
  await p.waitForFunction(() => window.__state().phase === 'reveal', null, { timeout: 15000 });
  await p.waitForTimeout(300);
  const tear = await p.evaluate(() => window.__anim);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await shot('4-cards-out');
  ok(true, 'a full tear opens the pack and the cards come out');
  // Tap through: three plain cards on top, then the face-down Rare, Legendary and Mythic (each tap turns it, the next sends it on).
  const tap = async () => {
    await p.mouse.click(b.x + b.width / 2, b.y + b.height * 0.5);
    try { await p.waitForFunction(() => ['reveal', 'done'].includes(window.__state().phase), null, { timeout: 8000 }); }
    catch (e) { console.log('stuck:', JSON.stringify(await st()), errs); throw e; }
    await p.waitForTimeout(150);
  };
  await tap(); await tap(); // common, uncommon off
  await tap(); await shot('5-rare-flipped');
  await tap(); await tap(); await shot('6-legendary-flipped');
  await tap();
  // The Mythic flip, caught mid-burst.
  await p.mouse.click(b.x + b.width / 2, b.y + b.height * 0.5); await p.waitForTimeout(380); await shot('7-mythic-burst');
  await p.waitForFunction(() => window.__state().phase === 'reveal'); await p.waitForTimeout(200); await shot('8-mythic');
  // Tilt the Mythic for its foil.
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(b.x + b.width / 2 + i * 9, b.y + b.height / 2 - i * 5);
  await p.waitForTimeout(150); await shot('9-mythic-tilted'); await p.mouse.up(); await p.waitForTimeout(700);
  await tap(); await p.waitForFunction(() => window.__state().phase === 'done'); await p.waitForTimeout(200); await shot('10-pull');
  ok(await p.isVisible('#again'), 'the pull shows every card and Open another');
  await p.click('#again'); await p.waitForTimeout(400);
  ok((await st()).phase === 'pack', 'Open another starts a new pack');
  const out = { tearAndOpen: tear, errors: errs };
  fs.writeFileSync(path.join(DIR, 'webgl-fps.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  ok(!errs.length, 'no page errors');
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
