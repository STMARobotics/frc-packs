// Upgrade test, before merging a branch into main: data written by main's server must survive the branch's server.
//   1. Build main in a worktree and run it with DEV_TOOLS=1 on its own table (TABLE_NAME=frc-packs-upgrade) and port
//      (BIND=127.0.0.1:3001), and make an admin there (frc-packs-server create-admin <name>).
//   2. ADMIN_USER=<name> ADMIN_PASS=<password> node test/upgrade.cjs seed [http://127.0.0.1:3001]
//   3. Stop main's server; run the branch's server on the same table and port.
//   4. ADMIN_USER=<name> ADMIN_PASS=<password> node test/upgrade.cjs check [http://127.0.0.1:3001]
// Seed makes two players with opened packs, a held pack, marks, a collected mission, trades (accepted, declined and
// open), feedback (one accepted) and a game in the old lobby. Check signs in with the old sessions and passwords and
// compares everything; then the open offer is accepted, the held pack minted and opened, and the new features used.
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.argv[3] || 'http://127.0.0.1:3001';
const SNAP = path.join(require('node:os').tmpdir(), 'frc-packs-upgrade-snap.json');
const ok = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok  ' + m); };
const idem = () => ({ 'Idempotency-Key': Math.random().toString(36).slice(2) + Date.now() });
function client(cookie = '') {
  async function call(method, p, body, headers = {}) {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    const t = await r.text();
    if (!r.ok) { const e = new Error(`${method} ${p} -> ${r.status} ${t}`); e.status = r.status; e.body = t; throw e; }
    return t ? JSON.parse(t) : null;
  }
  return { call, cookie: () => cookie };
}
const adminCreds = () => {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) throw new Error('set ADMIN_USER and ADMIN_PASS');
  return { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASS };
};
const cols = (c) => Object.fromEntries(c.cards.map((x) => [x.num, [...x.serials].sort((a, b) => a - b)]));
// What a player has, the parts of it that must not change.
async function snapshot(c) {
  const st = await c.call('GET', '/api/state');
  const col = await c.call('GET', '/api/collection/cmp26');
  const tr = await c.call('GET', '/api/trades');
  const fb = await c.call('GET', '/api/feedback/mine');
  return {
    parts: st.parts, packs: st.packs.map(({ id, sealed, boosted, mythic, opened, pity }) => ({ id, sealed, boosted, mythic, opened, pity })),
    streak: st.streak, missions: st.missions.map(({ id, progress, claimed }) => ({ id, progress, claimed })),
    wishlist: st.wishlist, showcase: st.showcase, favorites: st.favorites, level: st.level,
    account: { username: st.account.username, firstName: st.account.firstName, badge: st.account.badge ?? null },
    collection: cols(col), sets: col.sets ?? null,
    trades: { incoming: tr.incoming.map((t) => t.id).sort(), outgoing: tr.outgoing.map((t) => t.id).sort(), recent: tr.recent.map((t) => `${t.id}:${t.status}`).sort() },
    feedback: fb.map((f) => `${f.id}:${f.status}`).sort(),
  };
}

async function seed() {
  const tag = Date.now().toString(36).slice(-4);
  const mk = async (name, packs) => {
    const c = client();
    const { code } = await c.call('POST', '/api/dev/invite', {});
    await c.call('POST', '/api/signup', { code, username: name, password: 'password123', firstName: name.slice(0, 4) });
    for (let i = 0; i < packs; i++) {
      await c.call('POST', '/api/dev/pack', { pack: 'cmp26' });
      const o = await c.call('POST', '/api/open', { pack: 'cmp26' }, idem());
      await c.call('POST', `/api/openings/${o.opening.id}/progress`, { revealed: 5 });
    }
    return c;
  };
  const A = await mk('mga' + tag, 25), B = await mk('mgb' + tag, 25);
  const ca = cols(await A.call('GET', '/api/collection/cmp26')), cb = cols(await B.call('GET', '/api/collection/cmp26'));
  const aSpare = Object.keys(ca).filter((n) => ca[n].length >= 2).map(Number), bSpare = Object.keys(cb).filter((n) => cb[n].length >= 2).map(Number);
  // A held pack (picked up, not opened), and the best rarity it shows.
  await A.call('POST', '/api/dev/pack', { pack: 'cmp26' });
  const hand = await A.call('POST', '/api/hand', { pack: 'cmp26' });
  // Marks.
  const teams = Object.keys(ca).map(Number);
  await A.call('POST', '/api/showcase', { pack: 'cmp26', teams: teams.slice(0, 3) });
  await A.call('POST', '/api/favorites', { pack: 'cmp26', team: teams[0], on: true });
  const missing = Object.keys(cb).map(Number).filter((n) => !ca[n]);
  await A.call('POST', '/api/wishlist', { pack: 'cmp26', team: missing[0], on: true });
  // A mission collected, if one is done.
  const st0 = await A.call('GET', '/api/state');
  const done = st0.missions.find((m) => m.progress >= m.goal && !m.claimed);
  if (done) await A.call('POST', `/api/missions/${done.id}/claim`);
  // Trades: one accepted (history), one declined, one still open.
  let t = await A.call('POST', '/api/trades', { to: 'mgb' + tag, pack: 'cmp26', give: [aSpare[0]], want: [bSpare[0]] }, idem());
  const id1 = t.outgoing[0].id;
  await B.call('POST', `/api/trades/${id1}/accept`);
  t = await A.call('POST', '/api/trades', { to: 'mgb' + tag, pack: 'cmp26', give: [aSpare[1]], want: [bSpare[1]] }, idem());
  const id2 = t.outgoing.find((x) => x.id !== id1).id;
  await B.call('POST', `/api/trades/${id2}/decline`);
  t = await A.call('POST', '/api/trades', { to: 'mgb' + tag, pack: 'cmp26', give: [aSpare[2]], want: [bSpare[2]] }, idem());
  const open = t.outgoing[0].id;
  // Feedback: one accepted on main (no reward existed there), one still open.
  await A.call('POST', '/api/feedback', { kind: 'idea', title: 'Old idea ' + tag, details: '' });
  await A.call('POST', '/api/feedback', { kind: 'bug', title: 'Old bug ' + tag, details: '' });
  const AD = client();
  await AD.call('POST', '/api/login', adminCreds());
  const all = await AD.call('GET', '/api/admin/feedback');
  const idea = all.find((f) => f.title === 'Old idea ' + tag).id;
  await AD.call('POST', `/api/admin/feedback/${idea}/status`, { status: 'done', note: 'Shipped' });
  // Battler: B waits in the old open lobby.
  const g = await B.call('POST', '/api/battler/games');
  const snap = {
    tag, open, idea, hand: hand.best, game: g.id,
    cookies: { A: A.cookie(), B: B.cookie() },
    A: await snapshot(A), B: await snapshot(B),
    users: (await AD.call('GET', '/api/admin/users')).length,
  };
  fs.writeFileSync(SNAP, JSON.stringify(snap, null, 1));
  console.log(`seeded: ${Object.keys(snap.A.collection).length} teams for A, open trade ${open}, held pack best ${hand.best}, lobby game ${g.id}`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function check() {
  const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  // Old sessions still work: nobody is signed out by the update.
  const A = client(snap.cookies.A), B = client(snap.cookies.B);
  const st = await A.call('GET', '/api/state');
  ok(st.account.username === snap.A.account.username, 'old sessions still sign you in');
  for (const [who, c] of [['A', A], ['B', B]]) {
    const now = await snapshot(c), was = snap[who];
    for (const k of Object.keys(was)) ok(same(now[k], was[k]), `${who}: ${k} unchanged`);
  }
  // Signing in with the old password.
  const A2 = client();
  await A2.call('POST', '/api/login', { username: snap.A.account.username, password: 'password123' });
  ok(true, 'the old password still works');
  // The open offer can still be accepted, and the cards move.
  const before = cols(await B.call('GET', '/api/collection/cmp26'));
  const r = await B.call('POST', `/api/trades/${snap.open}/accept`);
  ok(r.trades.incoming.every((t) => t.id !== snap.open), 'the offer from before the update can be accepted');
  const after = cols(await B.call('GET', '/api/collection/cmp26'));
  ok(Object.values(after).flat().length === Object.values(before).flat().length, 'one card each way');
  // The pack picked up before the update opens with what it promised.
  const h = await A.call('POST', '/api/hand', { pack: 'cmp26' });
  ok(h.best === snap.hand, `the held pack is still the same pack (best ${h.best})`);
  ok(h.cards?.length === 5 && h.cards.every((c) => c.serial > 0), 'picked up again, it is minted: five cards with their serial numbers');
  const o = await A.call('POST', '/api/open', { pack: 'cmp26' }, idem());
  const best = ['mythic', 'legendary', 'rare', 'uncommon', 'common'].find((t) => o.opening.cards.some((c) => c.tier === t));
  ok(best === snap.hand, 'and opens with that best card');
  const minted = (cs) => cs.map((c) => `${c.num} No. ${c.serial}`).join(', ');
  ok(minted(o.opening.cards) === minted(h.cards), 'exactly as it was minted');
  // A pack picked up now is minted at once, and opens as minted.
  await B.call('POST', '/api/dev/pack', { pack: 'cmp26' });
  const hb = await B.call('POST', '/api/hand', { pack: 'cmp26' });
  const ob = await B.call('POST', '/api/open', { pack: 'cmp26' }, idem());
  ok(minted(ob.opening.cards) === minted(hb.cards), 'a pack picked up after the update opens as minted');
  // Profiles, social, matches and the new features work on old accounts.
  const p = await B.call('GET', `/api/players/${snap.A.account.username}/profile/cmp26`);
  ok(p.bio === null && p.avatar === null && p.showcase.length === 3, 'an old profile loads (no bio or picture yet, showcase kept)');
  await A.call('POST', '/api/profile', { pack: 'cmp26', bio: 'Hi', avatar: null, banner: null });
  ok((await A.call('GET', '/api/state')).account.bio === 'Hi', 'and can be edited');
  ok((await A.call('GET', '/api/social/cmp26')).players.length >= 2, 'social loads');
  ok(Array.isArray(await A.call('GET', '/api/trade-matches/cmp26')), 'trade matches load');
  const copies = Object.keys(snap.A.collection)[0];
  ok(Array.isArray(await A.call('GET', `/api/copies/cmp26/${copies}`)), 'copies load');
  // Feedback: old items load (nothing is paid by the update itself: parts and packs were checked unchanged above).
  const fb = await A.call('GET', '/api/feedback/mine');
  ok(fb.length === 2, 'old feedback loads');
  // Admin.
  const AD = client();
  await AD.call('POST', '/api/login', adminCreds());
  ok((await AD.call('GET', '/api/admin/users')).length === snap.users, 'every account is still there');
  // Battler: the game waiting in the old lobby doesn't trap its host.
  const home = await B.call('GET', '/api/battler/home');
  ok(home && typeof home === 'object', 'battler home loads for a player waiting in the old lobby');
  const g = await B.call('GET', `/api/battler/games/${snap.game}`);
  console.log('    old lobby game status:', g.status, 'mode:', g.mode);
  const q = await B.call('POST', '/api/battler/quick').then(() => 'ok', (e) => `${e.status} ${e.body}`);
  console.log('    quick play for the waiting host:', q);
  ok(q === 'ok', 'the host of an old lobby game can start Quick Play');
  console.log('PASSED');
}

(process.argv[2] === 'seed' ? seed : check)().catch((e) => { console.error(e); process.exit(1); });
