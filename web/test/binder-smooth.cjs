// Checks the binder stays still while you use it: switching tabs, searching and coming back to the app must not re-create
// the cards (re-created cards reload their photos, which flashes). Against a local server started with DEV_TOOLS=1:
//   node test/binder-smooth.cjs [http://127.0.0.1:3000]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

async function main() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  };
  const { code } = await call('POST', '/api/dev/invite', {});
  await call('POST', '/api/signup', { code, username: 'bin' + Date.now().toString(36).slice(-5), password: 'password123', firstName: 'Bin' });
  for (let i = 0; i < 6; i++) {
    await call('POST', '/api/dev/pack', { pack: 'cmp26' });
    await call('POST', '/api/hand', { pack: 'cmp26' }).catch(() => {});
    const o = await call('POST', '/api/open', { pack: 'cmp26' }, { 'Idempotency-Key': Math.random().toString(36).slice(2) + Date.now() });
    await call('POST', `/api/openings/${o.opening.id}/progress`, { revealed: 5 });
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'sid', value: cookie.slice(4), url: BASE }]);
  await ctx.addInitScript(() => { try { localStorage.setItem('frcpacks.tour', 'done'); } catch {} });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(BASE + '/#binder');
  await p.waitForSelector('#grid .slot');
  await p.waitForTimeout(800);
  await p.evaluate(() => {
    window.__imgs = 0;
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) window.__imgs += (n.matches('img') ? 1 : 0) + n.querySelectorAll('img').length; })
      .observe(document.getElementById('grid'), { childList: true, subtree: true });
  });
  const cards = await p.$$eval('#grid .slot', (l) => l.length);
  const step = async (name, f) => { await p.evaluate(() => (window.__imgs = 0)); await f(); await p.waitForTimeout(700); const n = await p.evaluate(() => window.__imgs); console.log(`${name}: ${n} photos re-created`); return n; };
  let total = 0;
  total += await step('tab away and back', async () => { await p.evaluate(() => { location.hash = '#open'; }); await p.waitForTimeout(300); await p.evaluate(() => { location.hash = '#binder'; }); });
  total += await step('app regains focus (sync)', async () => { await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await p.waitForTimeout(800); });
  const search = await p.$('#binderSearch');
  if (search && await search.isVisible()) {
    total += await step('type a search and clear it', async () => { await search.fill('1'); await p.waitForTimeout(300); await search.fill(''); });
  }
  console.log(`${cards} cards in the binder, ${total} photos re-created in all`);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
