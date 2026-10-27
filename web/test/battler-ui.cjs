// Two phones play a Battler game through the page itself, against a local server started with DEV_TOOLS=1:
//   node test/battler-ui.cjs [http://127.0.0.1:3000] [screenshot dir]
// Sets both players up through the API (accounts, packs, a ready deck), then does everything else by tapping:
// host, join, pick decks, attach parts, play lore, set stations, lock, watch results, finish. Saves a screenshot of
// every screen.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const OUT = process.argv[3] || path.join(__dirname, 'shots');
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

let pages = [];
async function main() {
  const tag = Date.now().toString(36).slice(-4);
  const A = await setup('ann' + tag), B = await setup('ben' + tag);
  const browser = await chromium.launch();
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const ctxA = await browser.newContext(phone), ctxB = await browser.newContext(phone);
  await ctxA.addCookies([{ name: 'sid', value: A.sid(), url: BASE }]);
  await ctxB.addCookies([{ name: 'sid', value: B.sid(), url: BASE }]);
  const a = await ctxA.newPage(), b = await ctxB.newPage();
  pages = [a, b];
  const errors = [];
  for (const p of [a, b]) { p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); }); }
  const shot = async (p, name, full = false) => { await p.waitForTimeout(250); await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full }); };

  // Home, library, deck builder (A builds a deck by tapping).
  await a.goto(BASE + '/battle.html');
  await a.waitForSelector('.bt-menu');
  await shot(a, '01-home', true);
  await a.click('text=Library');
  await a.waitForSelector('.bt-cardgrid');
  await shot(a, '02-library');
  await a.click('.bt-cardbtn');
  await a.waitForSelector('.bt-detail');
  await shot(a, '03-robot-detail');
  await a.click('[data-close]');
  await a.click('[data-tab="PART"]');
  await shot(a, '04-library-parts');
  await a.goto(BASE + '/battle.html#decks');
  await a.click('#newDeck');
  await a.waitForSelector('.bt-counts');
  await a.click('[data-pick="captain"]');
  await a.click('#pickList .bt-tile >> nth=0');
  await a.click('[data-pick="robots"]');
  for (let i = 0; i < 10; i++) await a.click(`#pickList .bt-tile:not(.sel):not(.off) >> nth=0`);
  await shot(a, '05-pick-robots');
  await a.click('.bt-sheet-in .cta[data-close]');
  await a.click('[data-pick="support"]');
  const parts = await a.$$('#supList [data-sp-plus]');
  for (let i = 0; i < 5; i++) { await a.click(`#supList [data-sp-plus] >> nth=${i}`); await a.click(`#supList [data-sp-plus] >> nth=${i}`); }
  await a.click('.bt-sheet-in [data-kind="LORE"]');
  for (let i = 0; i < 5; i++) await a.click(`#supList [data-sp-plus] >> nth=${i}`);
  await shot(a, '06-pick-support');
  await a.click('.bt-sheet-in .cta[data-close]');
  await a.click('#deckSave');
  await a.waitForTimeout(1500);
  const probs = await a.$('.bt-problems');
  if (probs) { await shot(a, '07-deck-problems', true); throw new Error('deck problems: ' + (await probs.textContent())); }
  await a.waitForSelector('.bt-readyline');
  await shot(a, '07-deck-ready', true);

  // B's deck through the API (same rules).
  const home = await B.call('GET', '/api/battler/home');
  const cat = await B.call('GET', '/api/battler/catalog');
  const P = cat.support.filter((s) => s.kind === 'PART').map((s) => s.id), L = cat.support.filter((s) => s.kind === 'LORE').map((s) => s.id);
  const d = await B.call('POST', '/api/battler/decks', { name: 'Ben deck', captain: home.owned_teams[0], robots: home.owned_teams.slice(1, 11), support: [...P.slice(5, 10).flatMap((x) => [x, x]), ...L.slice(2, 7)] });
  assert(!d.problems.length, 'B deck ready');

  // Host and join.
  await a.goto(BASE + '/battle.html#play');
  await a.click('#host');
  await a.waitForSelector('.bt-wait');
  await shot(a, '08-waiting');
  await b.goto(BASE + '/battle.html#play');
  await b.waitForSelector('[data-join]');
  await shot(b, '09-lobby');
  await b.click('[data-join]');
  await a.waitForSelector('[data-deck]', { timeout: 10000 });
  await shot(a, '10-pick-deck');
  await a.click('[data-deck]');
  await b.waitForSelector('[data-deck]');
  await b.click('[data-deck]');

  // Pre-game intro (tap to skip), then the draft: take turns, 20 picks, 10 robots each.
  await a.waitForSelector('.intro', { timeout: 10000 });
  await a.waitForTimeout(900); await shot(a, '10b-intro-vs');
  await a.waitForTimeout(2200); await shot(a, '10c-intro-captains');
  await a.waitForTimeout(1500); await shot(a, '10d-intro-shuffle');
  await a.click('.intro');
  if (await b.$('.intro')) await b.click('.intro');
  await a.waitForSelector('.dr .dr-opt');
  await shot(a, '10e-draft');
  await shot(b, '10f-draft-b');
  for (let n = 0; n < 20; n++) {
    const p = await Promise.race([a, b].map((x) => x.waitForSelector('[data-draft]:not([disabled])', { timeout: 15000 }).then(() => x).catch(() => new Promise(() => {}))));
    if (n === 3) { await p.click('.dr-opt >> nth=1'); await shot(p, '10g-draft-pick-selected'); }
    await p.click('[data-draft]');
    await p.waitForFunction(() => !document.querySelector('[data-draft]:not([disabled])'));
  }
  await a.waitForSelector('.ar[data-mode="pit"]', { timeout: 15000 });
  await b.waitForSelector('.ar[data-mode="pit"]', { timeout: 15000 });
  const poolsA = await A.call('GET', '/api/battler/home');
  assert(poolsA.active, 'game is active');
  const gv = await A.call('GET', `/api/battler/games/${poolsA.active}`);
  assert(gv.seats[0].pool.length === 10 && gv.seats[1].pool.length === 10, 'both pools have 10 robots');
  assert(gv.alliances[1 - gv.me.side][1] === 0, "the other player's partners are hidden in the pit");

  const drag = async (p, from, to) => {
    const f = await p.locator(from).first().boundingBox(), t = await p.locator(to).first().boundingBox();
    const sx = f.x + Math.min(14, f.width / 2), sy = f.y + f.height / 2;
    await p.mouse.move(sx, sy);
    await p.mouse.down();
    for (let i = 1; i <= 8; i++) await p.mouse.move(sx + (t.x + t.width / 2 - sx) * i / 8, sy + (t.y + t.height / 2 - sy) * i / 8);
    await p.mouse.up();
  };
  for (let round = 1; round <= 5; round++) {
    for (const [p, who] of [[a, 'a'], [b, 'b']]) {
      await p.waitForSelector('.ar[data-mode="pit"] .ar-hand', { timeout: 15000 });
      const part = p.locator('.ar-hand .ar-card.k-part');
      if (await part.count()) {
        if (who === 'a') {
          // Drag a part onto the middle lane's robot.
          await drag(p, '.ar-hand .ar-card.k-part', '.ar-lane[data-lane="2"] [data-drop-robot]');
        } else {
          await part.first().click({ position: { x: 14, y: 60 } });
          await p.waitForSelector('.ar-bot.target');
          await p.click('.ar-lane[data-lane="2"] [data-drop-robot]');
        }
        await p.waitForTimeout(400);
      }
      const lore = p.locator('.ar-hand .ar-card.k-lore');
      if (await lore.count()) {
        if (who === 'a') await drag(p, '.ar-hand .ar-card.k-lore', '[data-drop-lore]');
        else { await lore.first().click({ position: { x: 14, y: 60 } }); await p.click('[data-drop-lore]'); }
        await p.waitForTimeout(400);
      }
      if (round === 1 && who === 'a') {
        // Move the station-1 robot to station 3: tap it, then tap lane 3.
        await p.click('.ar-lane[data-lane="1"] [data-drop-robot]');
        await p.click('.ar-lane[data-lane="3"] .ar-lane-mid');
        await p.waitForTimeout(400);
        await shot(p, '11-pit-round1');
      }
      if (round === 1 && who === 'b') {
        // Swap a partner from the bench.
        const before = (await B.call('GET', `/api/battler/games/${poolsA.active}`)).alliances[(await B.call('GET', `/api/battler/games/${poolsA.active}`)).me.side];
        await p.click('.ar-steps [data-bench]');
        await p.waitForSelector('.ar-slots');
        await shot(p, '11c-bench');
        await p.locator('.ar-minigrid .ar-mini[data-pick]:not(.broken)').filter({ hasNotText: 'In your alliance' }).first().click();
        await p.click('[data-bench-done]');
        await p.waitForTimeout(700);
        const after = (await B.call('GET', `/api/battler/games/${poolsA.active}`)).alliances;
        const mine = after[(await B.call('GET', `/api/battler/games/${poolsA.active}`)).me.side];
        assert(mine[1] !== before[1] || mine[2] !== before[2], 'bench swap changed a partner');
        await p.click('#emoteBtn');
        await p.click('[data-emote="nice"]');
        await a.waitForSelector('.ar-bubble.op', { timeout: 5000 });
        await shot(a, '11b-opponent-acting');
      }
      await p.click('[data-act="lock"]');
      await p.waitForTimeout(300);
      if (round === 1 && who === 'a') await shot(p, '12-locked');
    }
    await a.waitForSelector('.ar[data-mode="reveal"]', { timeout: 15000 });
    if (round === 1) {
      await a.waitForTimeout(3500); await shot(a, '13-reveal-scoring');
      await a.waitForSelector('.ar.revealed', { timeout: 20000 }); await shot(a, '14-revealed', true);
    }
    if (round >= 2 && round <= 4) { await a.waitForSelector('.ar.revealed', { timeout: 25000 }); await shot(a, `14-reveal-round${round}`, true); }
    for (const p of [a, b]) {
      await p.waitForSelector('.ar [data-act="ack"]:not([disabled])', { timeout: 30000 });
      await p.click('.ar [data-act="ack"]');
    }
  }
  await a.waitForSelector('.bt-final', { timeout: 15000 });
  await shot(a, '15-final', true);
  await b.waitForSelector('.bt-final', { timeout: 15000 });
  await shot(b, '16-final-b');
  await a.goto(BASE + '/battle.html#history');
  await a.waitForSelector('.bt-lobbyrow');
  await shot(a, '17-history');
  await browser.close();
  if (errors.length) { console.log('page errors:\n' + errors.join('\n')); process.exit(1); }
  console.log('battler UI: a full game played by tapping; screenshots in', OUT);
}

main().catch(async (e) => {
  console.error(e);
  for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(OUT, `zz-fail-${'ab'[i]}.png`), fullPage: true }).catch(() => {});
  process.exit(1);
});
