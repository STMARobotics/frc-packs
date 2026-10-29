// The site at phone size, against a local server started with DEV_TOOLS=1:
//   node test/site-ui.cjs [http://127.0.0.1:3000] [screenshot dir]
// Makes an account with some packs opened through the API, then visits every screen,
// tapping through it, and checks: no page errors, and no card photos re-created while you move around the binder.
// Then a signed-out browser joins with an invite link, signs out and signs back in.
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
  await ctx.addInitScript(() => localStorage.setItem('frcpacks.beta', '1')); // the welcome is checked on its own below
  const p = page = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  let n = 0;
  const shot = async (name, full = false) => { await p.waitForTimeout(250); await p.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: full }); };

  await p.goto(BASE + '/#binder');
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
  // Copies: a team you have more than one of lists every copy; one can be shown on the card, and an extra one scrapped.
  {
    const col = await A.call('GET', '/api/collection/cmp26'), recipe = await A.call('GET', '/packs/cmp26.json');
    const tierOf = Object.fromEntries(recipe.teams.map((t) => [t.num, t.tier]));
    const dup = col.cards.find((c) => c.serials.length >= 2 && tierOf[c.num] !== 'mythic');
    if (dup) {
      await p.fill('input[type=search]', String(dup.num));
      await p.waitForTimeout(300);
      await p.click('.s-grid .s-cell >> nth=0');
      await p.waitForSelector('.s-cardview');
      await p.click('.s-tabs >> text=Copies');
      await p.waitForSelector('.cw-copy');
      assert((await p.$$('.cw-copy')).length === dup.serials.length, 'Copies lists every copy');
      await shot('card-copies');
      const last = [...dup.serials].sort((x, y) => y - x)[0];
      await p.click(`.cw-copy-main >> text=No. ${last}`);
      await p.waitForSelector('.s-tilt');
      assert((await p.textContent('.s-tilt .sn')).includes(String(last)), 'the picked copy is shown on the card');
      await p.click('.s-tabs >> text=Copies');
      const row = p.locator('.cw-copy', { hasText: `No. ${last}` });
      await row.locator('text=/Scrap/').click();
      await row.locator('text=Tap again').click();
      await p.waitForFunction((n) => document.querySelectorAll('.cw-copy').length === n, dup.serials.length - 1, { timeout: 8000 });
      const after = (await A.call('GET', '/api/collection/cmp26')).cards.find((c) => c.num === dup.num);
      assert(!after.serials.includes(last) && after.serials.length === dup.serials.length - 1, 'that exact copy was scrapped');
      await p.click('.cw-top [aria-label=Close]');
      await p.waitForSelector('.s-cardview', { state: 'detached' });
      await p.fill('input[type=search]', '');
    } else console.log('(no duplicate card to check Copies with)');
  }
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

  // Open a pack: swipe across the top to tear it, deal the five (flipping the face-down ones), then the summary.
  const tapThrough = async (max) => {
    for (let i = 0; i < max && !(await p.$('.op-sum')); i++) { await p.click('.op-stack', { position: { x: 60, y: 120 } }); await p.waitForTimeout(950); }
  };
  await A.call('POST', '/api/dev/pack', { pack: 'cmp26' });
  await A.call('POST', '/api/dev/pack', { pack: 'cmp26' });
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForFunction(() => document.querySelector('.op-count')?.textContent === '×2');
  await p.click('.op-hero');
  await p.waitForSelector('.op-grip');
  await p.waitForTimeout(600);
  await shot('pack-in-hand');
  const g = await p.locator('.op-grip').boundingBox(), gy = g.y + g.height * 0.13;
  await p.mouse.move(g.x + g.width * 0.06, gy);
  await p.mouse.down();
  for (let i = 1; i <= 18; i++) { await p.mouse.move(g.x + g.width * (0.06 + i * 0.05), gy); await p.waitForTimeout(20); }
  await p.mouse.up();
  await p.waitForSelector('.op-stack:not(.op-dealing)');
  await p.waitForTimeout(400);
  await shot('pack-stack');
  await tapThrough(12);
  await p.waitForSelector('.op-sum');
  await shot('pack-summary');
  assert((await A.call('GET', '/api/state')).pending === null, 'the opened pack is finished on the server');
  // Halfway through the next one, leave: the Open tab picks it up again where it was.
  await p.click('.op-sum-b >> text=Open another');
  await p.waitForSelector('.op-grip');
  await p.waitForTimeout(600);
  await p.click('.op-holdbtns >> text=Open');
  await p.waitForSelector('.op-stack:not(.op-dealing)');
  await p.waitForTimeout(400);
  await tapThrough(2);
  await p.reload();
  await p.waitForSelector('.op-hero');
  assert((await p.textContent('.op-cap')) === 'Finish opening', 'a half-opened pack is offered again');
  await p.click('.op-hero');
  await p.waitForSelector('.op-stack');
  await tapThrough(12);
  await p.waitForSelector('.op-sum');
  await p.click('.op-sum-b >> text=Done');
  await p.waitForSelector('.s-layer', { state: 'detached' });
  assert((await A.call('GET', '/api/state')).pending === null, 'the picked-up pack is finished on the server');

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
  await ctxB.addInitScript(() => localStorage.setItem('frcpacks.beta', '1'));
  const b = await ctxB.newPage();
  b.on('pageerror', (e) => errors.push('B: ' + e));
  await b.goto(BASE + '/#trade');
  await b.waitForSelector('.td-offer');
  await b.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-trade-incoming-b.png`) });
  await b.click('.td-offer >> text=Accept');
  await b.waitForSelector('.s-toast.show');
  await b.click('.s-trade .s-tabs >> text=History');
  await b.waitForSelector('.hi-item.accepted');
  await b.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-trade-history-b.png`) });

  // Signed out: join with an invite link (the beta terms first), get the welcome once, sign out, sign back in.
  const ctxC = await browser.newContext({ viewport: { width: +(process.env.W || 390), height: +(process.env.H || 844) }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const c = await ctxC.newPage();
  c.on('pageerror', (e) => errors.push('C: ' + e));
  const cshot = (name) => c.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) });
  const { code } = await client().call('POST', '/api/dev/invite', {});
  const name = 'sic' + tag;
  await c.goto(BASE + '/?invite=' + code);
  await c.waitForSelector('.au-terms');
  await cshot('join-terms');
  await c.click('.au-terms >> text=I agree');
  assert((await c.inputValue('input[name=code]')) === code, 'the invite link fills in the code');
  await c.click('.au-form >> text=Create account');
  await c.waitForSelector('.s-msg.bad');
  await c.fill('input[name=firstName]', 'Cee');
  await c.fill('input[name=username]', name);
  await c.fill('input[name=password]', 'password123');
  await cshot('join-form');
  await c.click('.au-form >> text=Create account');
  await c.waitForSelector('.op-hero');
  assert(!c.url().includes('invite='), 'the invite leaves the address once used');
  await c.waitForSelector('.au-sheet', { timeout: 6000 });
  await cshot('beta-welcome');
  await c.click('.au-sheet >> text=Got it');
  await c.waitForSelector('.s-layer', { state: 'detached' });
  await c.click('.s-avbtn');
  await c.click('.s-profile >> text=Settings');
  await c.click('.s-settings button >> text=Sign out');
  await c.waitForSelector('.au-form input[name=password]');
  await c.fill('input[name=username]', name);
  await c.fill('input[name=password]', 'wrongpassword');
  await c.click('.au-form >> text=Sign in');
  await c.waitForSelector('.s-msg.bad');
  await cshot('sign-in-wrong');
  await c.fill('input[name=password]', 'password123');
  await c.click('.au-form >> text=Sign in');
  await c.waitForSelector('.op-hero');
  await c.waitForTimeout(3500);
  assert(!(await c.$('.au-sheet')), 'the welcome shows once per device');

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
