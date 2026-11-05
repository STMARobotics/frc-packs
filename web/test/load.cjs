// Load test: N players at once, the way a team meeting would look. Each signs up, loads the game, claims, then opens
// packs (pick up, open, deal), checks the binder, scraps extras, and half of them trade with a partner. Reports
// latency per kind of request and any errors. Uses the dev-tools test server only (it hands out invites and packs).
// usage: node load.cjs <baseUrl> [players] [packsEach]
const base = (process.argv[2] || 'http://127.0.0.1:3100').replace(/\/$/, '');
const N = +(process.argv[3] || 50), PACKS = +(process.argv[4] || 5);
const times = {}, errors = {};
async function req(cookie, method, path, body, label) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(base + path, { method, headers: { ...(cookie.v ? { cookie: cookie.v } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { (errors[label] = errors[label] || []).push('network ' + e.message); return null; }
  const ms = performance.now() - t0;
  (times[label] = times[label] || []).push(ms);
  const sc = res.headers.get('set-cookie'); if (sc) cookie.v = sc.split(';')[0];
  const text = await res.text();
  if (res.status >= 500 || (res.status >= 400 && !['not_ready', 'no_extras', 'extras_held'].some(c => text.includes(c)))) (errors[label] = errors[label] || []).push(res.status + ' ' + text.slice(0, 80));
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
async function player(i) {
  const c = { v: '' };
  const inv = await req(c, 'POST', '/api/dev/invite', {}, 'invite');
  const name = 'load' + i + '_' + Math.random().toString(36).slice(2, 6);
  await req(c, 'POST', '/api/signup', { code: inv.code, username: name, password: 'load-test-pass' }, 'signup (argon2)');
  await req(c, 'GET', '/api/state', null, 'state');
  await req(c, 'GET', '/api/collection/cmp26', null, 'collection');
  await req(c, 'POST', '/api/claim', {}, 'claim');
  for (let k = 0; k < PACKS; k++) await req(c, 'POST', '/api/dev/pack', { pack: 'cmp26' }, 'dev pack');
  for (let k = 0; k < PACKS; k++) {
    const o = await req(c, 'POST', '/api/open', { pack: 'cmp26' }, 'open');
    if (o && o.opening) for (let d = 1; d <= 5; d++) await req(c, 'POST', `/api/openings/${o.opening.id}/progress`, { revealed: d }, 'deal');
  }
  await req(c, 'GET', '/api/collection/cmp26', null, 'collection');
  await req(c, 'POST', '/api/scrap/extras', { pack: 'cmp26', tiers: ['common', 'uncommon', 'rare'] }, 'scrap');
  await req(c, 'GET', '/api/trades', null, 'trades');
  return { c, name };
}
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
(async () => {
  const t0 = performance.now();
  const players = await Promise.all(Array.from({ length: N }, (_, i) => player(i)));
  // Pairs trade: the first half offers a card to the second half, who accept, all at once.
  const pairs = [];
  for (let i = 0; i + 1 < N; i += 2) pairs.push([players[i], players[i + 1]]);
  await Promise.all(pairs.map(async ([a, b]) => {
    const mine = await req(a.c, 'GET', '/api/collection/cmp26', null, 'collection');
    const theirs = await req(a.c, 'GET', `/api/players/${b.name}/collection/cmp26`, null, 'player collection');
    if (!mine || !theirs || !mine.cards || !theirs.cards || !mine.cards.length || !theirs.cards.length) return;
    const t = await req(a.c, 'POST', '/api/trades', { to: b.name, pack: 'cmp26', give: [mine.cards[0].num], want: [theirs.cards[0].num] }, 'offer');
    if (t && t.outgoing && t.outgoing[0]) await req(b.c, 'POST', `/api/trades/${t.outgoing[0].id}/accept`, {}, 'accept');
  }));
  const total = (performance.now() - t0) / 1000;
  console.log(`${N} players, ${PACKS} packs each, ${total.toFixed(1)}s total\n`);
  console.log('request'.padEnd(20), 'count'.padStart(6), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8), 'p99 ms'.padStart(8), 'max ms'.padStart(8));
  for (const [k, a] of Object.entries(times)) console.log(k.padEnd(20), String(a.length).padStart(6), pct(a, .5).toFixed(0).padStart(8), pct(a, .95).toFixed(0).padStart(8), pct(a, .99).toFixed(0).padStart(8), Math.max(...a).toFixed(0).padStart(8));
  const errs = Object.entries(errors);
  console.log('\nerrors:', errs.length ? '' : 'none');
  for (const [k, e] of errs) console.log(' ', k, e.length, 'e.g.', e[0]);
})();
