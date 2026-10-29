// Captures the real card faces from a local server (DEV_TOOLS=1) for the WebGL prototype, and measures the CSS card's
// frame rate while it's dragged on a mid-range phone profile (390x844, CPU 4x slower):
//   node prototype/three-card/capture.cjs [http://127.0.0.1:3000]
// Writes faces/<num>.png (the card face at 3x), shots/css-<num>.png (the CSS card mid-drag) and css-fps.json.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const DIR = __dirname;
for (const d of ['faces', 'shots']) fs.mkdirSync(path.join(DIR, d), { recursive: true });

function client() {
  let cookie = '';
  async function call(method, p, body, headers = {}) {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  }
  return { call, sid: () => cookie.slice(4) };
}

/** Drags the pointer across the card for `ms` and counts frames (CPU slowed 4x). */
async function dragFps(p, box, ms = 3000) {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.evaluate(() => {
    window.__f = []; let last = performance.now();
    const tick = (t) => { window.__f.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(tick); };
    window.__stop = false; requestAnimationFrame(tick);
  });
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await p.mouse.move(cx, cy); await p.mouse.down();
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < ms) {
    const a = i++ / 12;
    await p.mouse.move(cx + Math.sin(a) * 90, cy + Math.cos(a * 0.7) * 70);
    await p.waitForTimeout(16);
  }
  const f = await p.evaluate(() => { window.__stop = true; return window.__f.slice(5); });
  await p.mouse.up();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  f.sort((a, b) => a - b);
  const avg = f.reduce((a, b) => a + b, 0) / f.length;
  return { fps: +(1000 / avg).toFixed(1), p95ms: +f[Math.floor(f.length * 0.95)].toFixed(1), over33ms: f.filter((x) => x > 33.4).length, frames: f.length };
}

(async () => {
  const c = client();
  const { code } = await c.call('POST', '/api/dev/invite', {});
  await c.call('POST', '/api/signup', { code, username: 'proto' + Date.now().toString(36).slice(-5), password: 'password123', firstName: 'Proto' });
  await c.call('POST', '/api/dev/demo', { on: true });
  const recipe = await c.call('GET', '/packs/cmp26.json');
  const tierOf = Object.fromEntries(recipe.teams.map((t) => [t.num, t.tier]));
  let col;
  for (let i = 0; i < 60; i++) {
    await c.call('POST', '/api/dev/pack', { pack: 'cmp26' });
    const o = await c.call('POST', '/api/open', { pack: 'cmp26' }, { 'Idempotency-Key': Math.random().toString(36).slice(2) + Date.now() });
    await c.call('POST', `/api/openings/${o.opening.id}/progress`, { revealed: 5 });
    col = await c.call('GET', '/api/collection/cmp26');
    if (col.cards.some((x) => tierOf[x.num] === 'mythic') && col.cards.some((x) => tierOf[x.num] === 'rare')) break;
  }
  const mythic = col.cards.find((x) => tierOf[x.num] === 'mythic').num, rare = col.cards.find((x) => tierOf[x.num] === 'rare').num;
  console.log('cards:', { mythic, rare });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'sid', value: c.sid(), url: BASE }]);
  await ctx.addInitScript(() => { for (const [k, v] of [['frcpacks.beta', '1'], ['frcpacks.version', '9.9.9'], ['frcpacks.fbbar', String(Date.now() + 1e9)], ['frcpacks.daily', '0']]) localStorage.setItem(k, v); });
  const p = await ctx.newPage();
  const out = { cards: { mythic, rare }, css: {} };
  for (const num of [mythic, rare]) {
    await p.goto(BASE + '/#binder');
    await p.waitForSelector('.s-grid .s-cell');
    await p.fill('input[type=search]', String(num));
    await p.waitForTimeout(400);
    await p.click('.s-grid .s-cell >> nth=0');
    await p.waitForSelector('.s-tilt');
    await p.waitForFunction(() => [...document.querySelectorAll('.s-tilt img')].every((i) => i.complete));
    await p.waitForTimeout(600);
    const card = p.locator('.s-tilt .flip');
    const box = await card.boundingBox();
    out.card = { w: box.width, h: box.height, radius: await card.evaluate((e) => getComputedStyle(e).borderTopLeftRadius) };
    await card.screenshot({ path: path.join(DIR, 'faces', `${num}.png`) });
    // The CSS card mid-drag, for the side-by-side.
    const slot = await p.locator('.s-tilt').boundingBox();
    await p.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2); await p.mouse.down();
    for (let i = 1; i <= 10; i++) await p.mouse.move(slot.x + slot.width / 2 + i * 9, slot.y + slot.height / 2 - i * 5);
    await p.waitForTimeout(150);
    await p.screenshot({ path: path.join(DIR, 'shots', `css-${num}.png`), clip: { x: 0, y: Math.max(0, slot.y - 30), width: 390, height: Math.min(844 - Math.max(0, slot.y - 30), slot.height + 60) } });
    await p.mouse.up(); await p.waitForTimeout(800);
    out.css[num] = await dragFps(p, slot);
  }
  out.cssBundle = 'see README';
  fs.writeFileSync(path.join(DIR, 'css-fps.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
