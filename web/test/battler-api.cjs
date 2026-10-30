// Two players play a whole Battler game through the API against a local server started with DEV_TOOLS=1:
//   node test/battler-api.cjs [http://127.0.0.1:3000]
// Signs up two accounts, opens packs until each owns enough robots, builds decks, plays five rounds and checks the
// rules the server must enforce (stale actions, hidden hands, one lore, ratings changing once).
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const assert = (c, m) => { if (!c) throw new Error('FAILED: ' + m); };

function client(label) {
  let cookie = '';
  async function call(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.getSetCookie?.() || [];
    for (const c of set) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) { const e = new Error(`${label} ${method} ${path} -> ${r.status} ${text}`); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  return { call, label };
}

async function signup(c, name) {
  const { code } = await c.call('POST', '/api/dev/invite', {});
  await c.call('POST', '/api/signup', { code, username: name, password: 'password123', firstName: name });
}

async function collect(c, want) {
  for (let i = 0; i < 40; i++) {
    const home = await c.call('GET', '/api/battler/home');
    if (home.owned_teams.length >= want) return home;
    await c.call('POST', '/api/dev/pack', { pack: 'cmp26' });
    await c.call('POST', '/api/hand', { pack: 'cmp26' }).catch(() => {});
    const key = Math.random().toString(36).slice(2) + Date.now();
    const o = await c.call('POST', '/api/open', { pack: 'cmp26' }, { 'Idempotency-Key': key });
    await c.call('POST', `/api/openings/${o.opening.id}/progress`, { revealed: 5 });
  }
  throw new Error('could not collect robots');
}

async function main() {
  const tag = Date.now().toString(36).slice(-5);
  const A = client('A'), B = client('B');
  await signup(A, 'bta' + tag);
  await signup(B, 'btb' + tag);
  const cat = await A.call('GET', '/api/battler/catalog');
  assert(cat.robots.length > 500 && cat.support.length >= 30, 'catalog has robots and support cards');
  const parts = cat.support.filter((s) => s.kind === 'PART').map((s) => s.id);
  const lore = cat.support.filter((s) => s.kind === 'LORE').map((s) => s.id);

  const decks = {};
  for (const c of [A, B]) {
    const home = await collect(c, 11);
    const teams = home.owned_teams;
    const support = [...parts.slice(0, 5).flatMap((p) => [p, p]), ...lore.slice(0, 5)];
    // Draft first: incomplete decks save but aren't playable.
    const draft = await c.call('POST', '/api/battler/decks', { name: 'Draft', captain: teams[0], robots: teams.slice(1, 4), support: [] });
    assert(draft.problems.length > 0, 'an incomplete deck lists its problems');
    const four = await c.call('POST', '/api/battler/decks', { name: 'Too many', captain: teams[0], robots: teams.slice(1, 11), support: [...support.slice(0, 11), parts[0], parts[0], parts[0], parts[0]] }).catch((e) => e);
    if (!(four instanceof Error)) assert(four.problems.some((p) => p.includes('At most')), 'more than 3 copies is a problem');
    const d = await c.call('PUT', `/api/battler/decks/${draft.deck.id}`, { name: 'Main', captain: teams[0], robots: teams.slice(1, 11), support });
    assert(d.problems.length === 0, 'full deck is ready: ' + d.problems.join('; '));
    decks[c.label] = d.deck.id;
  }

  // A private game: found by its code, joined with it.
  const g0 = await A.call('POST', '/api/battler/games');
  const found = await B.call('GET', `/api/battler/code/${g0.code}`);
  assert(found.id === g0.id, 'the game is found by its code');
  const nocode = await B.call('POST', `/api/battler/games/${g0.id}/join`).catch((e) => e);
  assert(nocode instanceof Error, 'joining a private game needs its code');
  const busy = await A.call('POST', '/api/battler/games').catch((e) => e);
  assert(busy instanceof Error && busy.status === 409, 'one game at a time');
  const self = await A.call('POST', `/api/battler/games/${g0.id}/join?code=${g0.code}`).catch((e) => e);
  assert(self instanceof Error, "can't join your own game");
  let gb = await B.call('POST', `/api/battler/games/${g0.id}/join?code=${g0.code}`);
  assert(gb.status === 'DECKS', 'both seated: pick decks');
  const C = client('C');
  await signup(C, 'btc' + tag);
  const third = await C.call('POST', `/api/battler/games/${g0.id}/join?code=${g0.code}`).catch((e) => e);
  assert(third instanceof Error && third.status === 409, 'a third player is refused');

  const id = g0.id;
  const view = (c) => c.call('GET', `/api/battler/games/${id}`);
  const act = async (c, action) => { const v = await view(c); return c.call('POST', `/api/battler/games/${id}/act`, { rev: v.rev, action }); };

  await act(A, { kind: 'pick_deck', deck: decks.A });
  let v = await act(B, { kind: 'pick_deck', deck: decks.B });
  assert(v.status === 'SCHEDULE' && v.round === 0 && v.schedule.length === 5, 'both decks in: schedule is the first screen');
  assert(v.alliances[0][0] && v.alliances[1][0], 'both Captains are known from the start');

  const schedule = v.schedule;
  assert(v.offer.length === 0 && v.me.hand.length === 0, 'no draft and no cards before reviewing the schedule');
  const attemptedDraft = await act(A, { kind: 'draft_pick', robot: 99999 }).catch((e) => e);
  assert(attemptedDraft instanceof Error && attemptedDraft.data.error === 'no_drafting', 'draft actions refused');
  for (const side of [0, 1]) {
    const partners = schedule.flatMap((m) => m.alliances[side].slice(1));
    assert(new Set(partners).size === 10, 'all ten partners play exactly once');
    for (const m of schedule) {
      assert(m.alliances[side].every((id) => v.robots.find((r) => r.inst === id).from === side), 'all scheduled robots belong to the player who brought them');
      assert(Math.abs(m.prediction.win_chance[0] + m.prediction.win_chance[1] - 1) < 1e-10, 'both win chances add to 100%');
    }
  }
  const scheduleB = await view(B);
  for (let i = 0; i < schedule.length; i++) {
    const other = scheduleB.schedule[i], first = schedule[i];
    require('node:assert/strict').deepEqual(other.alliances, first.alliances, 'both players get the same fixed schedule');
    require('node:assert/strict').deepEqual(other.prediction.scores, first.prediction.scores);
    assert(other.prediction.win_chance.every((p, side) => Math.abs(p - first.prediction.win_chance[side]) < 1e-12), 'predictions survive database round trips');
  }
  await act(A, { kind: 'ack' });
  assert((await view(B)).status === 'SCHEDULE', 'waits for the second player');
  await act(B, { kind: 'ack' });
  v = await view(A);
  assert(v.status === 'PIT' && v.round === 1, 'round 1 pit after both ready up');
  assert(v.seats[0].pool.length === 10 && v.seats[1].pool.length === 10, 'ten robots in each pool');
  const vb = await view(B);
  assert(JSON.stringify(vb.alliances) === JSON.stringify(schedule[0].alliances), 'scheduled partners are public in the pit');
  assert(vb.alliances[vb.me.side][1] !== 0, 'your own partners are shown');

  // A stale action is refused.
  const stale = await B.call('POST', `/api/battler/games/${id}/act`, { rev: 1, action: { kind: 'lock' } }).catch((e) => e);
  assert(stale instanceof Error && stale.data.error === 'stale', 'stale rev refused');

  for (let round = 1; round <= 5; round++) {
    for (const c of [A, B]) {
      let me = await view(c);
      assert(me.status === 'PIT' && me.round === round, `round ${round} pit for ${c.label}`);
      const mine = me.me.side;
      if (round === 3 && c === A) {
        // Scheduled partners cannot be swapped, including to robots from the opponent's deck.
        const out = me.seats[mine].pool.filter((i) => !me.alliances[mine].includes(i) && me.robots.find((r) => r.inst === i).broken === 0);
        const swap = await act(c, { kind: 'partners', robots: [out[0], out[1]] }).catch((e) => e);
        assert(swap instanceof Error && swap.data.error === 'scheduled_partners', 'scheduled partners cannot be swapped');
        const dup = await act(c, { kind: 'partners', robots: [out[0], out[0]] }).catch((e) => e);
        assert(dup instanceof Error && dup.data.error === 'scheduled_partners', 'duplicate partner swaps refused');
        const foreign = await act(c, { kind: 'partners', robots: [out[0], me.seats[1 - mine].pool[0]] }).catch((e) => e);
        assert(foreign instanceof Error && foreign.data.error === 'scheduled_partners', "can't field the other player's robots");
      }
      // The opponent's hand cards are never in my view.
      const oppHand = me.seats[1 - mine].hand_count;
      const visibleOpp = me.support.filter((s) => s.owner !== mine).length;
      assert(visibleOpp <= 6 * (round - 1), 'opponent cards only visible once played');
      assert(oppHand >= 0, 'hand count visible');
      const hand = me.me.hand.map((i) => me.support.find((s) => s.inst === i));
      const part = hand.find((s) => s.kind === 'PART');
      const lores = hand.filter((s) => s.kind === 'LORE');
      const myBots = me.alliances[mine];
      assert(JSON.stringify(myBots) === JSON.stringify(schedule[round - 1].alliances[mine]), 'each match uses its scheduled alliance');
      if (part) me = await act(c, { kind: 'attach', part: part.inst, robot: myBots[0] });
      if (lores.length >= 1) {
        me = await act(c, { kind: 'lore', card: lores[0].inst });
        if (lores.length >= 2) {
          me = await act(c, { kind: 'lore', card: lores[1].inst });
          assert(me.me.plan.lore === lores[1].inst, 'the lore slot holds one card');
        }
      }
      me = await act(c, { kind: 'stations', robots: [myBots[2], myBots[0], myBots[1]] });
      const bad = await act(c, { kind: 'attach', part: 999999, robot: myBots[0] }).catch((e) => e);
      assert(bad instanceof Error, 'a card not in hand is refused');
      await act(c, { kind: 'lock' });
    }
    v = await view(A);
    assert(v.status === 'RESULTS', 'both locked: results');
    const r = v.rounds[round - 1].result;
    assert(r.robots.length === 6, 'six robots scored');
    assert(r.robots.every((x) => x.power >= 65 && x.power <= 100 && x.battery >= 0), 'batteries and power reported');
    if (round === 1) assert(r.robots.every((x) => x.battery === 100 && x.power === 100), 'everyone starts fully charged');
    assert(r.robots.every((x) => x.rp_chance >= 0 && x.rp_chance <= 100), 'RP chances clamped');
    console.log(`round ${round}: ${r.totals.join(' - ')}  RP +${r.match_rp[0] + r.bonus_rp[0]} / +${r.match_rp[1] + r.bonus_rp[1]}`);
    await act(A, { kind: 'ack' });
    await act(B, { kind: 'ack' });
  }
  v = await view(A);
  assert(v.status === 'FINAL', 'final after five rounds');
  assert(v.seed && v.seed_hash, 'seed revealed at the end');
  const o = v.outcome;
  console.log('final RP', o.rp, 'points', o.points, 'winner', o.winner, 'elo', o.elo_before, '->', o.elo_after);
  const ha = await A.call('GET', '/api/battler/home');
  const hb = await B.call('GET', '/api/battler/home');
  assert(ha.profile.games === 1 && hb.profile.games === 1, 'one game counted each');
  assert(ha.profile.elo === o.elo_after[0] && hb.profile.elo === o.elo_after[1], 'ratings saved once');
  assert(!ha.active && !hb.active, 'both players are free again');
  const leaders = await A.call('GET', '/api/battler/leaderboard');
  assert(leaders.length <= 25 && leaders.every(p => p.games > 0), 'leaderboard shows up to 25 players who have played');
  assert(leaders.every((p, i) => i === 0 || leaders[i - 1].elo >= p.elo), 'leaderboard is ordered by Elo');
  assert(leaders.every(p => Object.keys(p).sort().join(',') === 'draws,elo,games,losses,me,name,rank,wins'), 'leaderboard exposes only public rating data');
  const own = leaders.find(p => p.name === ha.name);
  if (own) assert(own.me && own.elo === ha.profile.elo, 'your leaderboard entry uses your saved rating');
  const anonymous = await fetch(BASE + '/api/battler/leaderboard');
  assert(anonymous.status === 401, 'leaderboard requires sign-in');
  const hist = await A.call('GET', '/api/battler/history');
  assert(hist.games.length === 1, 'history has the game');
  // Acting on a finished game does nothing.
  const late = await act(A, { kind: 'forfeit' }).catch((e) => e);
  assert(late instanceof Error, 'no forfeit after the end');
  const again = await A.call('GET', '/api/battler/home');
  assert(again.profile.games === 1, 'still one game');
  console.log('battler API: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
