// Captures the textures for the WebGL pack prototype from a local server (DEV_TOOLS=1): the standard pack art (from
// the sign-in screen, where it stands straight) and one card face of each rarity, at 3x:
//   node prototype/three-pack/capture.cjs [http://127.0.0.1:3000]
// Writes pack.jpg, pack.json (where the seam is) and cards/<tier>.jpg (+ cards.json: which teams).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const DIR = __dirname;
fs.mkdirSync(path.join(DIR, 'cards'), { recursive: true });
const TIERS = ['common', 'uncommon', 'rare', 'legendary', 'mythic'];

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

(async () => {
  const browser = await chromium.launch();
  // The pack, from the sign-in screen (no cookie).
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 8 });
    const p = await ctx.newPage();
    await p.goto(BASE + '/');
    await p.waitForSelector('.au-p.c .op-pface');
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(800);
    const face = p.locator('.au-p.c .op-pface');
    // Straighten it and drop the sheen and shadow, so the texture is just the art.
    await face.evaluate((e) => { for (let x = e; x && !x.classList.contains('au'); x = x.parentElement) { x.style.transform = 'none'; x.style.filter = 'none'; x.style.animation = 'none'; } e.querySelector('.op-psheen')?.remove(); });
    await p.waitForTimeout(200);
    const box = await face.boundingBox(), top = await p.locator('.au-p.c .op-ptop').boundingBox();
    await face.screenshot({ path: path.join(DIR, 'pack.png') });
    fs.writeFileSync(path.join(DIR, 'pack.json'), JSON.stringify({ w: box.width, h: box.height, seam: (top.y + top.height - box.y) / box.height }, null, 1));
    await ctx.close();
  }
  // One card of each rarity, through a test account with demo luck.
  const c = client();
  const { code } = await c.call('POST', '/api/dev/invite', {});
  await c.call('POST', '/api/signup', { code, username: 'pk' + Date.now().toString(36).slice(-5), password: 'password123', firstName: 'Pack' });
  await c.call('POST', '/api/dev/demo', { on: true });
  const recipe = await c.call('GET', '/packs/cmp26.json');
  const tierOf = Object.fromEntries(recipe.teams.map((t) => [t.num, t.tier]));
  let col;
  for (let i = 0; i < 80; i++) {
    await c.call('POST', '/api/dev/pack', { pack: 'cmp26' });
    const o = await c.call('POST', '/api/open', { pack: 'cmp26' }, { 'Idempotency-Key': Math.random().toString(36).slice(2) + Date.now() });
    await c.call('POST', `/api/openings/${o.opening.id}/progress`, { revealed: 5 });
    col = await c.call('GET', '/api/collection/cmp26');
    if (TIERS.every((t) => col.cards.some((x) => tierOf[x.num] === t))) break;
  }
  const pick = Object.fromEntries(TIERS.map((t) => [t, col.cards.find((x) => tierOf[x.num] === t)?.num]));
  console.log('cards:', pick);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  await ctx.addCookies([{ name: 'sid', value: c.sid(), url: BASE }]);
  await ctx.addInitScript(() => { for (const [k, v] of [['frcpacks.beta', '1'], ['frcpacks.version', '9.9.9'], ['frcpacks.fbbar', String(Date.now() + 1e9)], ['frcpacks.daily', '0']]) localStorage.setItem(k, v); });
  const p = await ctx.newPage();
  for (const t of TIERS) {
    if (!pick[t]) continue;
    await p.goto(BASE + '/#binder');
    await p.waitForSelector('.s-grid .s-cell');
    await p.fill('input[type=search]', String(pick[t]));
    await p.waitForTimeout(400);
    await p.click('.s-grid .s-cell >> nth=0');
    await p.waitForSelector('.s-tilt');
    await p.waitForFunction(() => [...document.querySelectorAll('.s-tilt img')].every((i) => i.complete));
    await p.waitForTimeout(600);
    await p.locator('.s-tilt .flip').screenshot({ path: path.join(DIR, 'cards', `${t}.png`) });
  }
  fs.writeFileSync(path.join(DIR, 'cards.json'), JSON.stringify(pick, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
