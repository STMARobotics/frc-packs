// How long the pack takes to burst open after a full swipe, against a local server started with DEV_TOOLS=1, with a
// phone-like delay added to the server's answer to "open" (and a third of it to each photo), and a quick thumb swipe:
//   node test/tear-gap.cjs [http://127.0.0.1:3000] [delay ms]
// Prints, over a few packs: from the swipe completing to the burst (the pack torn open), and to the cards rising.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const DELAY = +(process.argv[3] || 300);
const VERSION = fs.readFileSync(path.join(__dirname, '../src/site/notes.ts'), 'utf8').match(/VERSION = "([^"]+)"/)[1];

(async () => {
  let cookie = '';
  const call = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    return r.json();
  };
  const { code } = await call('/api/dev/invite', {});
  await call('/api/signup', { code, username: 'tg' + Date.now().toString(36).slice(-6), password: 'password123', firstName: 'Tg' });
  for (let i = 0; i < 4; i++) await call('/api/dev/pack', { pack: 'cmp26' });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addCookies([{ name: 'sid', value: cookie.slice(4), url: BASE }]);
  await ctx.addInitScript((v) => { localStorage.setItem('frcpacks.beta', '1'); localStorage.setItem('frcpacks.version', v); }, VERSION);
  await ctx.route('**/api/open', async (route) => { await new Promise((r) => setTimeout(r, DELAY)); await route.continue(); });
  await ctx.route('**/photos/*.webp', async (route) => { await new Promise((r) => setTimeout(r, DELAY / 3)); await route.continue(); });
  const p = await ctx.newPage();
  await p.goto(BASE + '/#open');
  await p.waitForSelector('.op-hero');
  const rows = [];
  for (let n = 0; n < 3; n++) {
    if (n === 0) await p.click('.op-hero'); else await p.click('.op-sum-b button:has-text("Open another")');
    await p.waitForSelector('.op-hold');
    await p.waitForTimeout(1200);
    await p.evaluate(() => {
      window.__t = {};
      new MutationObserver(() => {
        const now = performance.now();
        if (!window.__t.torn && document.querySelector('.op-hold.op-torn')) window.__t.torn = now;
        if (!window.__t.deal && document.querySelector('.op-stack')) window.__t.deal = now;
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
    const g = await p.locator('.op-grip').boundingBox(), y = g.y + g.height * 0.1;
    await p.mouse.move(g.x + g.width * 0.06, y);
    await p.mouse.down();
    // Eight quick moves, about 150 ms in all; the sixth completes the tear (72% across).
    for (let i = 1; i <= 8; i++) {
      if (i === 6) await p.evaluate(() => { window.__t.done = performance.now(); });
      await p.mouse.move(g.x + g.width * (0.06 + i * 0.12), y);
      await p.waitForTimeout(18);
    }
    await p.mouse.up();
    await p.waitForSelector('.op-stack');
    await p.waitForTimeout(300);
    const t = await p.evaluate(() => window.__t);
    rows.push([t.torn - t.done, t.deal - t.done]);
    await p.click('text=Reveal all');
    await p.waitForSelector('.op-sum');
    await p.waitForTimeout(1200);
  }
  for (const [b, d] of rows) console.log(`burst after ${b.toFixed(0)} ms, cards rising after ${d.toFixed(0)} ms`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
