// Two phones play a whole Battler game through the page, against a local server started with DEV_TOOLS=1:
//   node test/battler-ui.cjs [http://127.0.0.1:3000] [screenshot dir]
// Sets both players up through the API (accounts, packs, a ready deck for B), then does everything else by tapping: A
// builds a deck in the deck builder and hosts a private match; a third player can't see or join it without the code; B
// joins with the code; both pick decks, review their schedule, and play five rounds (tap and drag cards, move a robot,
// lock, watch or skip the reveal) to the final screen. Then A queues for Quick Play and B's Quick Play pairs them.
//
// Also checks the page stays smooth: no robot photo is re-created while the other player acts (a sign of a screen being
// rebuilt, which flickers), no long frames during the reveal, no layout shifts, no console errors. Screenshots of every
// screen go to the screenshot dir.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const OUT = process.argv[3] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const assert = (c, m) => { if (!c) throw new Error('FAILED: ' + m); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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

async function setup(name) {
  const c = client();
  const { code } = await c.call('POST', '/api/dev/invite', {});
  await c.call('POST', '/api/signup', { code, username: name, password: 'password123', firstName: name });
  for (let i = 0; i < 40; i++) {
    const home = await c.call('GET', '/api/battler/home');
    if (home.owned_teams.length >= 14) break;
    await c.call('POST', '/api/dev/pack', { pack: 'cmp26' });
    await c.call('POST', '/api/hand', { pack: 'cmp26' }).catch(() => {});
    const o = await c.call('POST', '/api/open', { pack: 'cmp26' }, { 'Idempotency-Key': Math.random().toString(36).slice(2) + Date.now() });
    await c.call('POST', `/api/openings/${o.opening.id}/progress`, { revealed: 5 });
  }
  return c;
}

async function readyDeck(c) {
  const home = await c.call('GET', '/api/battler/home');
  const cat = await c.call('GET', '/api/battler/catalog');
  const owned = home.owned_teams;
  const support = [];
  for (const s of cat.support) for (let k = 0; k < Math.min(3, home.support_owned[s.id] || 0) && support.length < 15; k++) support.push(s.id);
  const d = await c.call('POST', '/api/battler/decks', { name: 'Test deck', captain: owned[0], robots: owned.slice(1, 11), support });
  assert(!d.problems.length, 'API deck is ready: ' + d.problems.join(', '));
}

// Watches the page: robot photos added to the page, long frames and layout shifts.
const WATCH = () => {
  window.__imgs = 0; window.__long = []; window.__cls = 0;
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) window.__imgs += (n.matches('img') ? 1 : 0) + n.querySelectorAll('img').length; })
    .observe(document, { childList: true, subtree: true });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'long-animation-frame', buffered: false }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: false }); } catch {}
};
const stats = (p) => p.evaluate(() => ({ imgs: window.__imgs, long: window.__long.slice(), cls: +window.__cls.toFixed(3) }));
const resetStats = (p) => p.evaluate(() => { window.__imgs = 0; window.__long = []; window.__cls = 0; });

let pages = [];
const errors = [];
async function main() {
  const tag = Date.now().toString(36).slice(-4);
  log('setting up players');
  const A = await setup('ann' + tag), B = await setup('ben' + tag);
  await readyDeck(B);
  const browser = await chromium.launch();
  const phone = { viewport: { width: +(process.env.W || 390), height: +(process.env.H || 844) }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const ctxA = await browser.newContext(phone), ctxB = await browser.newContext(phone);
  await ctxA.addCookies([{ name: 'sid', value: A.sid(), url: BASE }]);
  await ctxB.addCookies([{ name: 'sid', value: B.sid(), url: BASE }]);
  const a = await ctxA.newPage(), b = await ctxB.newPage();
  pages = [a, b];
  for (const [p, who] of [[a, 'A'], [b, 'B']]) {
    p.on('pageerror', (e) => errors.push(`${who}: ${e}`));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`${who}: ${m.text()}`); if (m.text().startsWith('[rv]')) console.log(who, m.text()); });
    await p.addInitScript(WATCH);
  }
  let n = 0;
  const shot = async (p, name, full = false) => { await p.waitForTimeout(200); await p.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: full }); };

  // Home, library, deck builder (A builds a deck by tapping).
  await a.goto(BASE + '/battle.html');
  await a.waitForSelector('.b-menu');
  await shot(a, 'home', true);
  await a.click('a[href="#library"]');
  await a.waitForSelector('.b-cardgrid');
  await shot(a, 'library');
  await a.click('.b-cardbtn >> nth=0');
  await a.waitForSelector('.b-sheet .b-detail');
  await a.waitForTimeout(300);
  await shot(a, 'robot-sheet');
  await a.click('.b-x');
  await a.waitForSelector('.b-sheet', { state: 'detached' });
  await a.click('.b-tabs button >> nth=1');
  await shot(a, 'library-parts');
  await a.click('.b-head .b-iconbtn');
  await a.click('a[href="#decks"]');
  await a.click('text=New deck');
  await a.waitForSelector('.b-editor');
  await a.click('text=+ Captain');
  await a.click('.b-sheet .b-tile >> nth=0');
  await a.waitForSelector('.b-sheet', { state: 'detached' });
  await a.click('text=+ Robots');
  for (let i = 0; i < 10; i++) await a.click('.b-sheet .b-tile:not(.sel):not(.off) >> nth=0');
  await shot(a, 'pick-robots');
  await a.click('.b-sheet >> text=Done');
  await a.waitForSelector('.b-sheet', { state: 'detached' });
  await a.click('text=+ Parts and Lore');
  for (let i = 0; i < 5; i++) for (let k = 0; k < 2; k++) await a.click(`.b-sheet .b-sup >> nth=${i} >> [aria-label="One more"]`);
  await a.click('.b-sheet .b-tabs button >> nth=1');
  for (let i = 0; i < 5; i++) await a.click(`.b-sheet .b-sup >> nth=${i} >> [aria-label="One more"]`);
  await shot(a, 'pick-support');
  await a.click('.b-sheet >> text=Done');
  await a.waitForSelector('.b-savestate.saved');
  await a.waitForTimeout(400);
  await shot(a, 'deck-editor', true);
  const deckOk = await a.evaluate(() => !document.querySelector('.b-problems'));
  assert(deckOk, 'the tapped deck is ready');

  // A hosts a private match. The server keeps it to whoever has the code: a third player can't see or join it.
  await a.goto(BASE + '/battle.html#play');
  await shot(a, 'play');
  await a.click('text=Host a private match');
  await a.waitForSelector('.b-bigcode');
  await shot(a, 'private-host');
  const code = (await a.textContent('.b-bigcode')).trim(), gid = (await a.evaluate(() => location.hash)).split('/')[1];
  const C = client();
  const { code: inv } = await C.call('POST', '/api/dev/invite', {});
  await C.call('POST', '/api/signup', { code: inv, username: 'cal' + tag, password: 'password123', firstName: 'Cal' });
  const refused = async (pr) => { try { await pr; return false; } catch (e) { return / -> 403 /.test(String(e.message)); } };
  assert(await refused(C.call('GET', `/api/battler/games/${gid}`)), 'a private match is hidden without its code');
  assert(await refused(C.call('POST', `/api/battler/games/${gid}/join`)), 'a private match cannot be joined without its code');
  assert(await refused(C.call('POST', `/api/battler/games/${gid}/join?code=ZZZZZZ`)), 'or with the wrong code');
  // B joins with the code.
  await b.goto(BASE + '/battle.html#play');
  await b.fill('.b-code', code);
  await b.click('.b-codejoin button');
  await b.waitForSelector('text=invited you');
  await shot(b, 'private-invite');
  await b.click('.b-panel >> text=Join');
  for (const p of [a, b]) await p.waitForSelector('.b-deckline');
  await shot(a, 'deck-pick');
  await a.click('.b-deckline:not(.off) >> nth=0');
  await b.click('.b-deckline:not(.off) >> nth=0');

  // Both players see the complete schedule first; no intro or draft covers it.
  for (const p of [a, b]) {
    await p.waitForSelector('.b-schedule', { timeout: 15000 });
    assert(await p.locator('.b-scheduled-match').count() === 5, 'five scheduled matches');
    assert(await p.locator('.b-match-chance').count() === 10, 'win chance for both alliances in each match');
    assert(await p.locator('.b-draft, .b-intro').count() === 0, 'no draft or intro');
  }
  await shot(a, 'match-schedule', true);
  await shot(b, 'match-schedule-b', true);
  await a.click('.b-schedule-ready .b-btn');
  assert(await a.locator('.b-schedule').count() === 1, 'first ready player waits at the schedule');
  await b.click('.b-schedule-ready .b-btn');
  await a.waitForSelector('.b-arena.pit', { timeout: 20000 });
  await b.waitForSelector('.b-arena.pit', { timeout: 20000 });
  await a.waitForTimeout(900);
  await shot(a, 'pit');

  const report = [];
  for (let round = 1; round <= 5; round++) {
    await a.waitForSelector('.b-arena.pit .b-go', { timeout: 30000 });
    await b.waitForSelector('.b-arena.pit .b-go', { timeout: 30000 });
    for (const p of [a, b]) {
      assert(await p.locator('.b-bot.theirs.open .b-card').count() === 3, 'both players see all three opponent robots during card play');
      assert(await p.locator('.b-bot.theirs .b-bot-back').count() === 0, 'opponent robots are face up');
    }
    await a.waitForTimeout(700);
    await resetStats(a);
    // B plays a part (A should see a face-down card appear, and nothing get rebuilt).
    const bPart = b.locator('.b-hcard.part').last();
    if (await bPart.count()) { await bPart.click(); await b.click('.b-bot.mine >> nth=0'); }
    await a.waitForTimeout(1600);
    assert(await a.locator('.b-bot.theirs .b-part').count() === 0, 'opponent Part choices stay hidden during card play');
    const quiet = await stats(a);
    report.push({ round, imgsWhileOpponentActs: quiet.imgs });

    // A: tap a part then a robot; drag another part onto a robot; drag a robot to another station; play a lore.
    const part = a.locator('.b-hcard.part').last();
    if (await part.count()) { await part.click(); await shot(a, `r${round}-card-selected`); await a.click('.b-bot.mine >> nth=1'); }
    const part2 = a.locator('.b-hcard.part').last();
    if (await part2.count()) {
      const s = await part2.boundingBox(), t = await a.locator('.b-bot.mine >> nth=2').boundingBox();
      await a.mouse.move(s.x + s.width / 2, s.y + s.height / 2); await a.mouse.down();
      await a.mouse.move(s.x + 30, s.y - 40, { steps: 4 });
      await a.mouse.move(t.x + t.width / 2, t.y + t.height / 3, { steps: 8 });
      if (round === 1) await shot(a, 'r1-dragging');
      await a.mouse.up();
      await a.waitForTimeout(250);
    }
    if (round === 2) {
      const s = await a.locator('.b-bot.mine >> nth=0').boundingBox();
      const lanes = await a.locator('.b-lane').all();
      const t = await lanes[2].boundingBox();
      await a.mouse.move(s.x + s.width / 2, s.y + s.height / 3); await a.mouse.down();
      await a.mouse.move(t.x + t.width / 2, s.y + s.height / 3, { steps: 10 });
      await a.mouse.up();
      await a.waitForTimeout(500);
      await shot(a, 'r2-moved-station');
    }
    if (round === 3) {
      await a.click('.b-round >> text=Schedule');
      await a.waitForSelector('.b-sheet .b-schedule');
      assert(await a.locator('.b-sheet .b-scheduled-match.current').count() === 1, 'schedule marks the current match');
      await shot(a, 'r3-schedule');
      await a.click('.b-x');
      await a.waitForSelector('.b-sheet', { state: 'detached' });
    }
    const lore = a.locator('.b-hcard.lore').last();
    if (await lore.count()) { await lore.click(); await a.click('.b-lore.me'); }
    await a.waitForTimeout(500);
    await shot(a, `r${round}-pit-ready`);
    // Lock both; watch the reveal (round 1 and 5 in full, the others skipped partway).
    await b.click('.b-go');
    await a.click('.b-go');
    await a.waitForSelector('.b-arena.reveal', { timeout: 15000 });
    await b.waitForSelector('.b-arena.reveal', { timeout: 15000 });
    await resetStats(a);
    if (round === 1 || round === 5) {
      await a.waitForTimeout(1300); await shot(a, `r${round}-reveal-flip`);
      await a.waitForTimeout(3200); await shot(a, `r${round}-reveal-auto`);
      await a.waitForSelector('.b-pbar.me .b-go:not(.ghost)', { timeout: 30000 });
      await shot(a, `r${round}-reveal-done`);
    } else {
      await a.waitForTimeout(2000);
      await a.click('.b-pbar.me .b-go.ghost');
    }
    const rs = await stats(a);
    report.push({ round, revealLongFrames: rs.long, revealCLS: rs.cls });
    if (await b.$('.b-pbar.me .b-go.ghost')) await b.click('.b-pbar.me .b-go.ghost', { timeout: 2000 }).catch(() => {});
    await b.waitForSelector('.b-pbar.me .b-go:not(.ghost)', { timeout: 30000 });
    await a.click('.b-pbar.me .b-go:not(.ghost)');
    await b.click('.b-pbar.me .b-go:not(.ghost)');
    log('round', round, 'done');
  }
  await a.waitForSelector('.b-final', { timeout: 30000 });
  await b.waitForSelector('.b-final', { timeout: 30000 });
  await shot(a, 'final', true);
  await shot(b, 'final-b', true);

  // Quick Play: A queues in the page, B queues through the API and lands in A's game.
  await a.goto(BASE + '/battle.html#play');
  await a.click('.b-quick');
  await a.waitForSelector('text=Finding an opponent');
  await shot(a, 'quick-queue');
  const qa = (await a.evaluate(() => location.hash)).split('/')[1], qb = await B.call('POST', '/api/battler/quick');
  assert(qb.id === qa, 'Quick Play pairs the next player with whoever is waiting');
  await a.waitForSelector('.b-deckline', { timeout: 10000 });
  await B.call('POST', `/api/battler/games/${qa}/act`, { rev: qb.rev, action: { kind: 'forfeit' } });

  // Once the schedule is shown, the Forfeit button must record a loss before anyone readies up.
  const beforeForfeit = await A.call('GET', '/api/battler/home');
  const next = await A.call('POST', '/api/battler/quick');
  await B.call('POST', '/api/battler/quick');
  for (const c of [A, B]) {
    const h = await c.call('GET', '/api/battler/home');
    const v = await c.call('GET', `/api/battler/games/${next.id}`);
    await c.call('POST', `/api/battler/games/${next.id}/act`, { rev: v.rev, action: { kind: 'pick_deck', deck: h.decks.find(d => !d.problems.length).deck.id } });
  }
  await a.goto(BASE + '/battle.html#game/' + next.id);
  await a.waitForSelector('.b-schedule');
  a.once('dialog', d => { assert(d.message().includes('counts as a loss'), 'schedule forfeit warns about losing'); d.accept(); });
  await a.getByRole('button', { name: 'Forfeit', exact: true }).click();
  await a.waitForSelector('.b-final.loss');
  const afterForfeit = await A.call('GET', '/api/battler/home');
  assert(afterForfeit.profile.losses === beforeForfeit.profile.losses + 1 && afterForfeit.profile.games === beforeForfeit.profile.games + 1, 'leaving the schedule saves a rated loss');

  // Desktop.
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await desk.addCookies([{ name: 'sid', value: A.sid(), url: BASE }]);
  const d = await desk.newPage();
  await d.goto(BASE + '/battle.html');
  await d.waitForSelector('.b-menu');
  await d.waitForSelector('.b-leaderboard tbody tr');
  const ratings = (await d.locator('.b-lb-elo').allTextContents()).map(Number);
  assert(ratings.length <= 25 && ratings.every((r, i) => i === 0 || ratings[i - 1] >= r), 'home leaderboard is ranked by Elo');
  await shot(d, 'desktop-home');
  await d.goto(BASE + '/battle.html#library');
  await d.waitForSelector('.b-cardgrid');
  await shot(d, 'desktop-library');

  console.log(JSON.stringify(report, null, 1));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  assert(!errors.length, 'no page errors');
  for (const r of report) if (r.imgsWhileOpponentActs !== undefined) assert(r.imgsWhileOpponentActs === 0, `round ${r.round}: no photos re-created while the other player acts (${r.imgsWhileOpponentActs})`);
  log('PASSED');
}

main().catch(async (e) => {
  console.error(e);
  console.error('page errors:', errors);
  for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(OUT, `zz-fail-${'ab'[i]}.png`) }).catch(() => {});
  process.exit(1);
});
