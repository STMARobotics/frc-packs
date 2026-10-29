// Serves this folder, opens the WebGL card on the same mid-range phone profile as capture.cjs (390x844, CPU 4x slower),
// drags it for 3 seconds per card and reports the frame rate; saves shots/webgl-<num>.png mid-drag.
//   node prototype/three-card/measure.cjs
const { chromium } = require('playwright');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIR = __dirname, types = { '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png', '.js': 'text/javascript' };
const srv = http.createServer((q, r) => { const f = path.join(DIR, decodeURIComponent(q.url.split('?')[0]).replace(/^\/$/, '/index.html')); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); }).listen(0);
(async () => {
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url); await p.waitForTimeout(2500);
  const gpu = await p.textContent('#gpu');
  const out = { gpu, cards: {} };
  for (const [name, num] of [['mythic', 2910], ['rare', 111]]) {
    await p.click(`[data-card=${name}]`); await p.waitForTimeout(1200);
    const box = await p.locator('#stage').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await p.mouse.move(cx, cy); await p.mouse.down();
    for (let i = 1; i <= 10; i++) await p.mouse.move(cx + i * 9, cy - i * 5);
    await p.waitForTimeout(150);
    await p.locator('#stage').screenshot({ path: path.join(DIR, 'shots', `webgl-${num}.png`) });
    await p.mouse.up(); await p.waitForTimeout(1500);
    const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await p.evaluate(() => { window.__f = []; let l = performance.now(); window.__s = false; const t = (n) => { window.__f.push(n - l); l = n; if (!window.__s) requestAnimationFrame(t); }; requestAnimationFrame(t); });
    await p.mouse.move(cx, cy); await p.mouse.down();
    const t0 = Date.now(); let i = 0;
    while (Date.now() - t0 < 3000) { const a = i++ / 12; await p.mouse.move(cx + Math.sin(a) * 90, cy + Math.cos(a * 0.7) * 70); await p.waitForTimeout(16); }
    const f = (await p.evaluate(() => { window.__s = true; return window.__f.slice(5); })).sort((a, b) => a - b);
    await p.mouse.up(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await p.waitForTimeout(1200);
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    out.cards[num] = { fps: +(1000 / avg).toFixed(1), p95ms: +f[Math.floor(f.length * 0.95)].toFixed(1), over33ms: f.filter((x) => x > 33.4).length, frames: f.length };
  }
  await p.screenshot({ path: path.join(DIR, 'shots', 'page.png'), fullPage: true });
  out.errors = errs;
  fs.writeFileSync(path.join(DIR, 'webgl-fps.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
