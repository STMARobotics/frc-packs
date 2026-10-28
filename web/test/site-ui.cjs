// The new site (/next.html) at phone size, against a local server started with DEV_TOOLS=1:
//   node test/site-ui.cjs [http://127.0.0.1:3000] [screenshot dir]
// Makes an account with some packs opened through the API, then visits every screen that has moved to the new version,
// tapping through it, and checks: no page errors, and no card photos re-created while you move around the binder.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const OUT = process.argv[3] || path.join(__dirname, 'shots-site');
fs.mkdirSync(OUT, { recursive: true });
const assert = (c, m) => { if (!c) throw new Error('FAILED: ' + m); };

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

async function setup(name, packs) {
  const c = client();
  const { code } = await c.call('POST', '/api/dev/invite', {});
  await c.call('POST', '/api/signup', { code, username: name, password: 'password123', firstName: name });
  for (let i = 0; i < packs; i++) {
    await c.call('POST', '/api/dev/pack', { pack: 'cmp26' });
    await c.call('POST', '/api/hand', { pack: 'cmp26' }).catch(() => {});
    const o = await c.call('POST', '/api/open', { pack: 'cmp26' }, { 'Idempotency-Key': Math.random().toString(36).slice(2) + Date.now() });
    await c.call('POST', `/api/openings/${o.opening.id}/progress`, { revealed: 5 });
  }
  return c;
}

let page;
const errors = [];
async function main() {
  const tag = Date.now().toString(36).slice(-4);
  const A = await setup('sia' + tag, 12);
  const B = await setup('sib' + tag, 3);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: +(process.env.W || 390), height: +(process.env.H || 844) }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'sid', value: A.sid(), url: BASE }]);
  const p = page = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  let n = 0;
  const shot = async (name, full = false) => { await p.waitForTimeout(250); await p.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: full }); };

  await p.goto(BASE + '/next.html#binder');
  await p.waitForSelector('.s-grid .s-cell');
  await p.waitForTimeout(600);
  await shot('binder');
  await p.evaluate(() => {
    window.__imgs = 0;
    new MutationObserver((ms) => { for (const m of ms) for (const x of m.addedNodes) if (x.nodeType === 1) { const im = [...(x.matches('img') ? [x] : []), ...x.querySelectorAll('img')]; window.__imgs += im.length; (window.__srcs ||= []).push(...im.map((i) => (i.closest('[class]')?.className || '') + ' ' + i.src.slice(-12))); } })
      .observe(document.querySelector('.s-binder'), { childList: true, subtree: true }); // the binder only (other tabs load their own pictures)
  });
  // Open a card, look at its details, go back with the phone's back button.
  await p.click('.s-grid .s-cell >> nth=0');
  await p.waitForSelector('.s-cardview');
  await shot('card');
  await p.click('text=Details');
  await shot('card-details');
  await p.goBack();
  await p.waitForSelector('.s-cardview', { state: 'detached' });
  // Filters and search.
  await p.selectOption('.s-filters select >> nth=0', 'common');
  await shot('binder-common');
  await p.selectOption('.s-filters select >> nth=0', 'all');
  await p.click('.s-filters >> text=Missing');
  await p.waitForTimeout(300);
  await shot('binder-missing');
  await p.click('.s-filters >> text=Missing');
  await p.fill('input[type=search]', '1');
  await p.waitForTimeout(300);
  await p.fill('input[type=search]', '');
  const before = await p.evaluate(() => window.__imgs);
  // Tab away and back, and the app regaining focus, must not rebuild the grid.
  await p.evaluate(() => (window.__imgs = 0));
  await p.click('.s-tabbar >> text=Social');
  await p.click('.s-tabbar >> text=Binder');
  await p.waitForTimeout(400);
  const tabImgs = await p.evaluate(() => window.__imgs);
  await p.evaluate(() => (window.__imgs = 0));
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(1200);
  const syncImgs = await p.evaluate(() => window.__imgs);
  if (syncImgs) console.log(await p.evaluate((k) => window.__srcs.slice(-k), syncImgs));
  // Workshop.
  await p.click('.s-tabs >> text=Workshop');
  await shot('workshop');
  await p.click('.s-tabs >> text=Cards');
  // A card you don't have: wishlist it.
  await p.click('.s-filters >> text=Missing');
  await p.click('.s-ghost >> nth=0');
  await p.waitForSelector('.s-cardview');
  await p.click('.cw-top >> text=Wishlist');
  await p.waitForTimeout(400);
  await shot('ghost-card-wished');
  await p.click('.cw-top [aria-label=Close]');
  await p.click('.s-filters >> text=Missing');
  // Profile and settings.
  await p.click('.s-avbtn');
  await p.waitForSelector('.s-profile .pr-stats');
  await shot('profile', true);
  await p.click('.s-profile >> text=Settings');
  await p.waitForSelector('.s-settings');
  await shot('settings', true);
  await p.goBack(); await p.goBack();
  await p.waitForSelector('.s-layer', { state: 'detached' });
  // Social tab: someone else's profile.
  await p.click('.s-tabbar >> text=Open');
  await p.waitForSelector('.s-status');
  await p.click('.st-daily-h');
  await shot('open-status');

  // Social, then a trade: A offers B a card for one of B's; B accepts in their own browser.
  await p.click('.s-tabbar >> text=Social');
  await p.waitForSelector('.s-social');
  await shot('social-activity');
  await p.click('.s-social .s-tabs >> text=Players');
  await shot('social-players');
  await p.click('.s-tabbar >> text=Trade');
  await p.waitForSelector('.s-trade');
  await p.fill('.s-trade input[type=search]', 'sib' + tag);
  await p.click(`.td-person >> text=sib${tag}`);
  await p.waitForSelector('.td-table');
  await p.click('.td-side.give .td-slot');
  await p.waitForSelector('.td-picker .td-pick');
  await shot('trade-picker');
  await p.click('.td-picker .td-pick >> nth=0');
  if (await p.$('.td-copies')) { await p.click('.td-copies .s-chip >> nth=0'); await p.click('.td-copies >> text=Done'); }
  await p.click('.td-picker .s-head >> text=Done');
  await p.click('.td-side.get .td-slot');
  await p.waitForSelector('.td-picker .td-pick');
  await p.click('.td-picker .td-pick >> nth=0');
  if (await p.$('.td-copies')) { await p.click('.td-copies .s-chip >> nth=0'); await p.click('.td-copies >> text=Done'); }
  await p.click('.td-picker .s-head >> text=Done');
  await shot('trade-table');
  await p.click('.s-trade .s-btn.wide');
  await p.waitForSelector('.s-toast.show');
  await p.click('.s-trade .s-tabs >> text=Sent');
  await p.waitForSelector('.td-offer');
  await shot('trade-sent');
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctxB.addCookies([{ name: 'sid', value: B.sid(), url: BASE }]);
  const b = await ctxB.newPage();
  b.on('pageerror', (e) => errors.push('B: ' + e));
  await b.goto(BASE + '/next.html#trade');
  await b.waitForSelector('.td-offer');
  await b.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-trade-incoming-b.png`) });
  await b.click('.td-offer >> text=Accept');
  await b.waitForSelector('.s-toast.show');
  await b.click('.s-trade .s-tabs >> text=History');
  await b.waitForSelector('.hi-item.accepted');
  await b.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-trade-history-b.png`) });

  console.log({ photosWhenSearching: before, photosTabSwitch: tabImgs, photosOnSync: syncImgs });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  assert(!errors.length, 'no page errors');
  assert(tabImgs === 0, `no photos re-created switching tabs (${tabImgs})`);
  assert(syncImgs === 0, `no photos re-created on sync (${syncImgs})`);
  console.log('PASSED');
}
main().catch(async (e) => {
  console.error(e);
  console.error('page errors:', errors);
  await page?.screenshot({ path: path.join(OUT, 'zz-fail.png') }).catch(() => {});
  process.exit(1);
});
