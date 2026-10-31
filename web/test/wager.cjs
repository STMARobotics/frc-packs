// Wagers on private Battler matches, through the API, against a local server started with DEV_TOOLS=1:
//   node test/wager.cjs [http://127.0.0.1:3000]
// Two players: a private match, stakes (cards against a pink slip), the match waits for the wager, changing a stake
// takes back both acceptances, both accept and the stakes leave both collections into escrow. Leaving before the
// schedule returns stakes; forfeiting at the schedule or in the pit awards both stakes to the opponent. Also: a brand-new
// account can't stake parts, a pink slip needs a picked deck, and a Quick Play match takes no wager.
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const assert = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok  ' + m); };

function client() {
  let cookie = '';
  async function call(method, p, body, headers = {}) {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${method} ${p} -> ${r.status} ${t}`), { status: r.status, body: t });
    return t ? JSON.parse(t) : null;
  }
  return { call };
}
const refusedWith = async (pr, code) => { try { await pr; return false; } catch (e) { return e.body?.includes(`"${code}"`); } };

async function setup(name) {
  const c = client();
  const { code } = await c.call('POST', '/api/dev/invite', {});
  await c.call('POST', '/api/signup', { code, username: name, password: 'password123', firstName: name });
  for (let i = 0; i < 40; i++) {
    const home = await c.call('GET', '/api/battler/home');
    if (home.owned_teams.length >= 16) break;
    await c.call('POST', '/api/dev/pack', { pack: 'cmp26' });
    await c.call('POST', '/api/hand', { pack: 'cmp26' }).catch(() => {});
    const o = await c.call('POST', '/api/open', { pack: 'cmp26' }, { 'Idempotency-Key': Math.random().toString(36).slice(2) + Date.now() });
    await c.call('POST', `/api/openings/${o.opening.id}/progress`, { revealed: 5 });
  }
  const home = await c.call('GET', '/api/battler/home'), cat = await c.call('GET', '/api/battler/catalog');
  const owned = home.owned_teams, support = [];
  for (const s of cat.support) for (let k = 0; k < Math.min(3, home.support_owned[s.id] || 0) && support.length < 15; k++) support.push(s.id);
  const deck = await c.call('POST', '/api/battler/decks', { name: 'Deck', captain: owned[0], robots: owned.slice(1, 11), support });
  return Object.assign(c, { deck: deck.deck.id, deckTeams: owned.slice(0, 11), spare: owned.slice(11) });
}
const copies = async (c) => {
  const col = await c.call('GET', '/api/collection/cmp26');
  return col.cards.reduce((a, x) => a + x.serials.length, 0);
};
const view = (c, id) => c.call('GET', `/api/battler/games/${id}`);
const act = async (c, id, action) => { const g = await view(c, id); return c.call('POST', `/api/battler/games/${id}/act`, { rev: g.rev, action }); };

async function privateMatch(A, B) {
  const g = await A.call('POST', '/api/battler/games');
  await B.call('POST', `/api/battler/games/${g.id}/join?code=${g.code}`);
  return g.id;
}

async function main() {
  const tag = Date.now().toString(36).slice(-4);
  const A = await setup('wa' + tag), B = await setup('wb' + tag);

  // Quick Play takes no wager.
  const q = await A.call('POST', '/api/battler/quick');
  await B.call('POST', '/api/battler/quick');
  assert(await refusedWith(A.call('PUT', `/api/battler/games/${q.id}/wager`, { teams: [A.spare[0]] }), 'no_wager_here'), 'Quick Play matches take no wager');
  await act(A, q.id, { kind: 'forfeit' });

  // Before decks are picked, leaving still returns both locked stakes without changing ratings.
  let id = await privateMatch(A, B);
  const beforeA = await copies(A), beforeB = await copies(B);
  await A.call('PUT', `/api/battler/games/${id}/wager`, { teams: [A.spare[0]] });
  await B.call('PUT', `/api/battler/games/${id}/wager`, { teams: [B.spare[0]] });
  await A.call('POST', `/api/battler/games/${id}/wager/accept`);
  await B.call('POST', `/api/battler/games/${id}/wager/accept`);
  await act(A, id, { kind: 'forfeit' });
  let g = await view(A, id);
  assert(g.status === 'CANCELLED' && g.stakes.status === 'returned', 'leaving before the schedule returns the wager');
  assert((await copies(A)) === beforeA && (await copies(B)) === beforeB, 'both stakes returned before the schedule');

  // Match 1: stakes, waiting, resets, escrow, then A forfeits at the schedule and B wins.
  id = await privateMatch(A, B);
  assert(await refusedWith(B.call('PUT', `/api/battler/games/${id}/wager`, { parts: 10 }), 'too_new'), 'a brand-new account can\'t stake parts');
  const a0 = await copies(A), b0 = await copies(B);
  await A.call('PUT', `/api/battler/games/${id}/wager`, { teams: [A.spare[0], A.spare[1]] });
  await B.call('PUT', `/api/battler/games/${id}/wager`, { pink: true });
  assert(await refusedWith(B.call('POST', `/api/battler/games/${id}/wager/accept`), 'pick_deck_first'), 'a pink slip needs the deck picked first');
  await act(A, id, { kind: 'pick_deck', deck: A.deck });
  await act(B, id, { kind: 'pick_deck', deck: B.deck });
  g = await view(A, id);
  assert(g.status === 'DECKS' && g.wager === 'open', 'both decks picked, but the match waits for the wager');
  await A.call('POST', `/api/battler/games/${id}/wager/accept`);
  await A.call('PUT', `/api/battler/games/${id}/wager`, { teams: [A.spare[0]] });
  g = await view(B, id);
  assert(!g.stakes.accepted[0] && !g.stakes.accepted[1], 'changing a stake takes back both acceptances');
  await A.call('POST', `/api/battler/games/${id}/wager/accept`);
  await B.call('POST', `/api/battler/games/${id}/wager/accept`);
  g = await view(A, id);
  assert(g.wager === 'locked' && g.status === 'SCHEDULE', 'both accepted: locked in, and the schedule is shown');
  assert(g.stakes.held[0].cards.length === 1 && g.stakes.held[1].cards.length >= 10, `escrow holds A's card and B's deck (${g.stakes.held[1].cards.length} robots)`);
  assert((await copies(A)) === a0 - 1 && (await copies(B)) === b0 - g.stakes.held[1].cards.length, 'the stakes left both collections');
  await act(A, id, { kind: 'forfeit' });
  g = await view(B, id);
  assert(g.status === 'FINAL' && g.outcome.winner === g.me.side && g.outcome.reason === 'forfeit', 'leaving at the schedule is a loss');
  assert(g.stakes.status === 'settled' && g.stakes.winner === g.me.side, 'the schedule winner receives the wager');
  assert((await copies(A)) === a0 - 1 && (await copies(B)) === b0 + 1, 'B wins A\'s card and keeps their own stake');
  const homeA = await A.call('GET', '/api/battler/home'), homeB = await B.call('GET', '/api/battler/home');
  assert(homeA.profile.losses === 1 && homeB.profile.wins === 1, 'schedule forfeit updates both records');
  assert(homeA.profile.elo === 984 && homeB.profile.elo === 1016, 'schedule forfeit updates Elo');

  // Match 2: A forfeits in the pit, and B gets both stakes.
  id = await privateMatch(A, B);
  const a1 = await copies(A), b1 = await copies(B);
  await A.call('PUT', `/api/battler/games/${id}/wager`, { teams: [A.spare[2]] });
  await B.call('PUT', `/api/battler/games/${id}/wager`, { teams: [B.spare[0], B.spare[1]] });
  await A.call('POST', `/api/battler/games/${id}/wager/accept`);
  await B.call('POST', `/api/battler/games/${id}/wager/accept`);
  await act(A, id, { kind: 'pick_deck', deck: A.deck });
  await act(B, id, { kind: 'pick_deck', deck: B.deck });
  await act(A, id, { kind: 'ack' });
  await act(B, id, { kind: 'ack' });
  g = await view(A, id);
  assert(g.status === 'PIT', 'both ready: the first pit starts');
  await act(A, id, { kind: 'forfeit' });
  g = await view(B, id);
  assert(g.status === 'FINAL' && g.stakes.status === 'settled' && g.stakes.winner === g.me.side, 'A forfeited: the wager is settled to B');
  assert((await copies(A)) === a1 - 1 && (await copies(B)) === b1 + 1, 'B has A\'s card and kept their own');
  console.log('PASSED');
}
main().catch((e) => { console.error(e); process.exit(1); });
