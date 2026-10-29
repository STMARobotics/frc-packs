// Profiles, trade matches and counter-offers at phone size, against a local server started with DEV_TOOLS=1:
//   node test/social-ui.cjs [http://127.0.0.1:3000] [screenshot dir]
// Two players with packs opened through the API. A edits their profile (bio, picture, banner, showcase) and it shows on
// their page and in the People list; A opens B's profile page from Social (its own address, the back button leaves
// it), sees what B has that A needs, starts the suggested trade and sends it; B answers with a counter-offer, which
// declines A's; A accepts the counter. A reports B. Also: a bad bio is refused, and a profile link opens directly.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const OUT = process.argv[3] || path.join(__dirname, 'shots-social');
fs.mkdirSync(OUT, { recursive: true });
const VERSION = fs.readFileSync(path.join(__dirname, '../src/site/notes.ts'), 'utf8').match(/VERSION = "([^"]+)"/)[1];
const assert = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok  ' + m); };

function client() {
  let cookie = '';
  async function call(method, p, body, headers = {}) {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    const t = await r.text();
    if (!r.ok) { const e = new Error(`${method} ${p} -> ${r.status} ${t}`); e.status = r.status; e.body = t; throw e; }
    return t ? JSON.parse(t) : null;
  }
  return { call, sid: () => cookie.slice(4) };
}

async function setup(name, packs) {
  const c = client();
  const { code } = await c.call('POST', '/api/dev/invite', {});
  await c.call('POST', '/api/signup', { code, username: name, password: 'password123', firstName: name[0].toUpperCase() + name.slice(1, 4) });
  for (let i = 0; i < packs; i++) {
    await c.call('POST', '/api/dev/pack', { pack: 'cmp26' });
    const o = await c.call('POST', '/api/open', { pack: 'cmp26' }, { 'Idempotency-Key': Math.random().toString(36).slice(2) + Date.now() });
    await c.call('POST', `/api/openings/${o.opening.id}/progress`, { revealed: 5 });
  }
  return c;
}
const counts = async (c) => {
  const col = await c.call('GET', '/api/collection/cmp26');
  return Object.fromEntries(col.cards.map((x) => [x.num, x.serials.length]));
};

const errors = [];
async function main() {
  const tag = Date.now().toString(36).slice(-4);
  const an = 'soa' + tag, bn = 'sob' + tag;
  // Enough packs that each has spares the other lacks.
  const A = await setup(an, 30), B = await setup(bn, 30);
  const [ca, cb] = [await counts(A), await counts(B)];
  const aSpare = Object.keys(ca).filter((n) => ca[n] >= 2 && !cb[n]), bSpare = Object.keys(cb).filter((n) => cb[n] >= 2 && !ca[n]);
  assert(aSpare.length && bSpare.length, `both have spares the other needs (${aSpare.length}, ${bSpare.length})`);

  // The API: a bad bio is refused; a good one, a picture and a banner from owned cards are kept.
  let bad = await A.call('POST', '/api/profile', { pack: 'cmp26', bio: 'a\nb\nc\nd', avatar: null, banner: null }).catch((e) => e);
  assert(bad.status === 400 && /bad_bio/.test(bad.body), 'a four-line bio is refused');
  const notMine = Object.keys(cb).find((n) => !ca[n]);
  bad = await A.call('POST', '/api/profile', { pack: 'cmp26', bio: '', avatar: +notMine, banner: null }).catch((e) => e);
  assert(bad.status === 409, 'a picture from a card you don\'t own is refused');
  const m = await A.call('GET', '/api/trade-matches/cmp26');
  const mb = m.find((x) => x.name === bn);
  assert(mb && mb.theyHave.length === bSpare.length && mb.youHave.length === aSpare.length, 'trade matches list B with the right spares each way');

  const browser = await chromium.launch();
  const ctx = (sid) => browser.newContext({ viewport: { width: +(process.env.W || 390), height: +(process.env.H || 844) }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    .then(async (c) => {
      await c.addCookies([{ name: 'sid', value: sid, url: BASE }]);
      await c.addInitScript((v) => { localStorage.setItem('frcpacks.beta', '1'); localStorage.setItem('frcpacks.version', v); localStorage.setItem('frcpacks.fbbar', String(Date.now() + 1e9)); }, VERSION);
      return c;
    });
  const ca2 = await ctx(A.sid());
  const p = await ca2.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) errors.push(msg.text()); });
  let n = 0;
  const shot = async (name, pg = p) => { await pg.waitForTimeout(300); await pg.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) }); };

  // Your own profile, then Edit profile.
  await p.goto(BASE + '/#open');
  await p.waitForSelector('.s-avbtn');
  await p.click('.s-avbtn');
  await p.waitForSelector('.pp-id h1');
  assert(p.url().endsWith('#u/' + an), 'your profile has its own address');
  await shot('my-profile');
  await p.click('.pp-acts >> text=Edit profile');
  await p.waitForSelector('.ed');
  await p.fill('.ed-bio textarea', 'Drive team on 7028.\nCollecting every Mythic.');
  await p.click('.ed-row >> text=Picture');
  await p.waitForSelector('.ed-grid .ed-tile');
  await shot('pick-picture');
  const firstTile = await p.$eval('.ed-grid .ed-tile', (e) => e.getAttribute('aria-label'));
  await p.click('.ed-grid .ed-tile');
  await p.click('.ed-row >> text=Banner');
  await p.waitForSelector('.ed-grid .ed-tile');
  await p.click('.ed-grid .ed-tile >> nth=1');
  await p.click('.ed-row >> text=Showcase');
  await p.waitForSelector('.ed-grid .ed-tile');
  for (const i of [0, 1, 2]) await p.click(`.ed-grid .ed-tile >> nth=${i}`);
  await p.click('.ed-pick .s-head >> text=Done');
  await shot('edit-profile');
  await p.click('.ed >> text=Save');
  await p.waitForSelector('.ed', { state: 'detached' });
  await p.waitForSelector('.pp-bio');
  assert((await p.textContent('.pp-bio')).includes('Collecting every Mythic.'), 'the bio shows on the profile');
  assert(await p.$('.pp-top .s-av.ph img'), 'the picture is the card picked');
  assert(await p.$('.pp-banner img'), 'and so is the banner');
  assert((await p.$$('.pp > section:first-of-type .pr-row .s-cell')).length === 3, 'three cards in the showcase');
  await shot('my-profile-edited');
  const st = await A.call('GET', '/api/state');
  assert(st.account.avatar === +firstTile.split(' ')[0] && st.account.bio.includes('7028'), 'the server kept the picture and bio');

  // B's profile from the People list: a page with its own address, back leaves it.
  await p.click('.s-tabbar >> text=Social');
  await p.click('.s-social .s-tabs >> text=Players');
  await p.fill('.s-social input[type=search]', bn);
  await p.click(`.so-row:has-text("${bn}")`);
  await p.waitForSelector('.pp-match');
  assert(p.url().endsWith('#u/' + bn), "B's profile has its own address");
  await shot('their-profile');
  assert((await p.textContent('.pp-match')).includes(`${bSpare.length} spare`), 'the match strip counts the spares you need');
  await p.click('.pp .s-tabs >> text=Cards');
  await p.click('.pp .s-chip >> text=You need');
  assert((await p.$$('.pr-grid .s-cell')).length === bSpare.length, '"You need" shows exactly their spares you lack');
  await shot('their-cards-you-need');
  await p.goBack();
  await p.waitForSelector('.s-social');
  assert(!p.url().includes('#u/'), 'back leaves the profile');
  await p.goForward();
  await p.waitForSelector('.pp-match');

  // The suggested trade: cards each way, then send it.
  await p.click('.pp-match');
  await p.waitForSelector('.td-table');
  await p.waitForFunction(() => document.querySelectorAll('.td-table .s-mini').length >= 2);
  await shot('suggested-trade');
  const onTable = await p.$$eval('.td-table .s-mini .mi-num', (e) => e.map((x) => x.textContent));
  assert(onTable.length >= 2 && onTable.length % 2 === 0, `a fair offer, as many cards each way (${onTable.join(', ')})`);
  await p.click('.td-table ~ button.s-btn.wide, .s-trade button.s-btn.wide');
  await p.waitForSelector('.s-toast.show');

  // B counters; that declines A's offer.
  const cb2 = await ctx(B.sid());
  const q = await cb2.newPage();
  q.on('pageerror', (e) => errors.push(String(e)));
  await q.goto(BASE + '/#trade');
  await q.waitForSelector('.td-offer');
  await shot('offer-for-b', q);
  await q.click('.td-offer >> text=Counter');
  await q.waitForSelector('.td-match >> text=counter-offer');
  await q.waitForSelector('.td-side.get .td-slot.full');
  await q.waitForTimeout(300);
  // Ask for one card fewer: take one off their side (what B gets).
  const getSide = q.locator('.td-side.get');
  const before = await getSide.locator('.td-slot.full').count();
  await getSide.locator('.td-slot.full').first().click();
  assert(await getSide.locator('.td-slot.full').count() === before - 1, 'B changes the counter before sending it');
  await shot('counter-offer', q);
  await q.click('.s-trade button.s-btn.wide');
  await q.waitForSelector('.s-toast.show >> text=Counter-offer sent');
  const ta = await A.call('GET', '/api/trades');
  assert(ta.incoming.length === 1 && ta.outgoing.length === 0, "A's offer was declined and B's counter is waiting for A");
  const hist = ta.recent.find((t) => t.status === 'declined');
  assert(hist, 'the first offer shows as declined in history');
  const acc = await A.call('POST', `/api/trades/${ta.incoming[0].id}/accept`, {});
  assert(acc.trades.incoming.length === 0, 'A accepts the counter');

  // A link straight to a profile, and a report.
  const p2 = await ca2.newPage();
  p2.on('pageerror', (e) => errors.push(String(e)));
  await p2.goto(`${BASE}/#u/${bn}`);
  await p2.waitForSelector('.pp-id h1');
  await p2.click('.pp-back');
  await p2.waitForSelector('.s-social');
  assert(p2.url().endsWith('#social'), 'back from a linked profile goes to Social');
  await p2.goto(`${BASE}/#u/${bn}`);
  await p2.waitForSelector('.pp-acts');
  await p2.click(`.pp-acts button[aria-label="Report ${bn}"]`);
  await p2.click('.au-sheet >> text=Offensive name or bio');
  await shot('report', p2);
  await p2.click('.au-sheet >> text=Send report');
  await p2.waitForSelector('.s-toast.show >> text=Thanks');
  await p2.goto(`${BASE}/#u/nobody${tag}`);
  await p2.waitForSelector('.pp .s-empty');
  assert(true, 'an unknown player shows a friendly page');

  // A's picture shows in the People list for B.
  await q.goto(BASE + '/#social');
  await q.click('.s-social .s-tabs >> text=Players');
  await q.fill('.s-social input[type=search]', an);
  await q.waitForSelector(`.so-row:has-text("${an}") .s-av.ph img`);
  assert(true, "A's card picture shows in B's People list");
  await shot('people', q);

  await browser.close();
  console.log('errors:', errors.length ? errors : 'none');
  assert(!errors.length, 'no page errors');
  console.log('PASSED');
}
main().catch((e) => { console.error(e); console.error('page errors:', errors); process.exit(1); });
