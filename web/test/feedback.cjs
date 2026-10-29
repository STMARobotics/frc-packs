// Feedback rewards, through the API, against a local server started with DEV_TOOLS=1 and an admin account:
//   ADMIN_USER=<name> ADMIN_PASS=<password> node test/feedback.cjs [http://127.0.0.1:3000]
// (make one with `frc-packs-server create-admin <name>`, which prints the password). A player sends an idea, a bug and
// an "other"; the admin accepts the idea (planned): the player gets one pack and a thank-you note. Moving it to done,
// or back and forth, gives nothing more; accepting the bug gives one more; "other" never pays.
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const assert = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok  ' + m); };

function client() {
  let cookie = '';
  async function call(method, p, body) {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  }
  return { call };
}
const sealed = (st) => st.packs.find((p) => p.id === 'cmp26')?.sealed ?? 0;

async function main() {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) throw new Error('set ADMIN_USER and ADMIN_PASS');
  const tag = Date.now().toString(36).slice(-5);
  const P = client(), A = client();
  const { code } = await P.call('POST', '/api/dev/invite', {});
  await P.call('POST', '/api/signup', { code, username: 'fb' + tag, password: 'password123', firstName: 'Fee' });
  await A.call('POST', '/api/login', { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASS });
  for (const [kind, title] of [['idea', 'Idea ' + tag], ['bug', 'Bug ' + tag], ['other', 'Other ' + tag]]) await P.call('POST', '/api/feedback', { kind, title, details: '' });
  const all = await A.call('GET', '/api/admin/feedback');
  const id = (t) => all.find((f) => f.title === t).id;
  const before = sealed(await P.call('GET', '/api/state'));

  let r = await A.call('POST', `/api/admin/feedback/${id('Idea ' + tag)}/status`, { status: 'planned', note: '' });
  assert(r.rewarded, 'accepting an idea rewards its sender');
  let st = await P.call('GET', '/api/state');
  assert(sealed(st) === before + 1, 'the sender has one more pack');
  assert(/accepted/.test(st.notice || ''), 'and a thank-you note');
  r = await A.call('POST', `/api/admin/feedback/${id('Idea ' + tag)}/status`, { status: 'done', note: 'Shipped' });
  assert(!r.rewarded, 'moving it on to done gives nothing more');
  await A.call('POST', `/api/admin/feedback/${id('Idea ' + tag)}/status`, { status: 'open', note: '' });
  r = await A.call('POST', `/api/admin/feedback/${id('Idea ' + tag)}/status`, { status: 'planned', note: '' });
  assert(!r.rewarded, 'reopening and accepting again gives nothing more');
  r = await A.call('POST', `/api/admin/feedback/${id('Other ' + tag)}/status`, { status: 'done', note: '' });
  assert(!r.rewarded, '"other" feedback never pays');
  r = await A.call('POST', `/api/admin/feedback/${id('Bug ' + tag)}/status`, { status: 'done', note: '' });
  assert(r.rewarded, 'accepting a bug report rewards its sender too');
  st = await P.call('GET', '/api/state');
  assert(sealed(st) === before + 2, 'two accepted, two packs');
  const mine = await P.call('GET', '/api/feedback/mine');
  assert(mine.filter((f) => f.rewarded).length === 2, 'the sender sees which of theirs paid');
  console.log('PASSED');
}
main().catch((e) => { console.error(e); process.exit(1); });
