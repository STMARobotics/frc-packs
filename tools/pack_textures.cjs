// The pictures the WebGL pack (web/src/site/gl/pack.ts) is drawn with: each kind of pack's front and back (the odds),
// photographed from the site's own CSS pack, so the 3D pack looks exactly like the one on the Open tab. Run it against
// a local server (DEV_TOOLS=1) after changing the pack's look, the odds or the season:
//   node tools/pack_textures.cjs [http://127.0.0.1:3000]
// Writes web/public/gl/pack-<kind>.webp: the front on the left half, the back on the right, 600 x 912 each.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', 'web', 'public', 'gl');
const KINDS = ['std', 'gold', 'myth', 'test'];
const FW = 600, FH = 912; // one face (the pack is 5 by 7.6)

async function signUp() {
  let cookie = '';
  const call = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
    return r.json();
  };
  const { code } = await call('/api/dev/invite', {});
  await call('/api/signup', { code, username: 'tx' + Date.now().toString(36).slice(-6), password: 'password123', firstName: 'Tex' });
  return cookie.slice(4);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const sid = await signUp();
  const browser = await chromium.launch();
  // Reduced motion: no WebGL, and the CSS settles at once.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: 'sid', value: sid, url: BASE }]);
  // Seen the welcome and this version's notes, so nothing covers the pack.
  const version = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'site', 'notes.ts'), 'utf8').match(/VERSION = "([^"]+)"/)[1];
  await ctx.addInitScript((v) => { localStorage.setItem('frcpacks.beta', '1'); localStorage.setItem('frcpacks.version', v); }, version);
  // Every kind of pack on the shelf (the test pack is the admin's), and a pack in hand that never runs out.
  const shelf = async (route) => {
    const r = await route.fetch(), s = await r.json();
    s.account.admin = true;
    s.packs = [{ id: 'cmp26', sealed: 9, boosted: 6, mythic: 3, opened: 0, pity: { m: 0, l: 0 } }];
    s.pending = null;
    await route.fulfill({ response: r, json: s });
  };
  await ctx.route('**/api/state', shelf);
  await ctx.route('**/api/session', shelf);
  await ctx.route('**/api/hand', (route) => route.fulfill({ json: { best: 'rare' } }));
  await ctx.route('**/api/admin/test-pack**', (route) => route.fulfill({ json: { cards: [] } }));
  const p = await ctx.newPage();
  await p.goto(BASE + '/#open');
  await p.waitForSelector('.op-hero .op-pface');
  await p.evaluate(() => document.fonts.ready);
  /** A face straightened out (no perspective, tilt or sheen), photographed on a clear background. */
  const shoot = async (sel) => {
    await p.evaluate((sel) => {
      const f = document.querySelector(sel);
      for (let x = f; x && !x.classList.contains('s-layer') && x !== document.body; x = x.parentElement) { x.style.transform = 'none'; x.style.perspective = 'none'; x.style.filter = 'none'; x.style.animation = 'none'; x.style.transition = 'none'; }
      f.querySelector('.op-psheen')?.remove();
      for (const e of f.closest('.op-pack').querySelectorAll('.op-pedge')) e.style.display = 'none';
      for (const e of document.querySelectorAll('.op-count, .op-cutzone')) e.style.display = 'none';
      // Nothing behind it: the page's own backgrounds would fill the picture's corners outside the rounded edge.
      for (let x = f.parentElement; x; x = x.parentElement) x.style.background = 'transparent';
      // and nothing else on the page showing through: only the face is visible.
      document.documentElement.style.visibility = 'hidden';
      f.style.visibility = 'visible';
      // No outer shadows either: outside the rounded edge they'd darken those corners. WebGL draws the pack's shadow.
      for (const e of [f, ...f.querySelectorAll('*')]) {
        const sh = getComputedStyle(e).boxShadow;
        if (sh && sh !== 'none') e.style.boxShadow = sh.split(/,(?![^(]*\))/).filter((x) => x.includes('inset')).join(',') || 'none';
      }
    }, sel);
    await p.waitForTimeout(100);
    const shot = (await p.locator(sel).screenshot({ omitBackground: true })).toString('base64');
    await p.evaluate(() => { document.documentElement.style.visibility = ''; });
    return shot;
  };
  for (const k of KINDS) {
    await p.goto(`${BASE}/?kind=${k}#open`); // a fresh page for each kind
    await p.waitForSelector('.op-hero .op-pface');
    if (await p.locator(`.op-kind.k-${k}`).count()) await p.click(`.op-kind.k-${k}`);
    await p.waitForTimeout(150);
    const front = await shoot('.op-hero .op-pfront');
    // The back, from the pack in your hand.
    await p.click('.op-hero');
    await p.waitForSelector('.op-hold .op-pback');
    await p.waitForTimeout(400);
    await p.evaluate(() => { document.querySelector('.op-hold .op-pfront').style.display = 'none'; const b = document.querySelector('.op-hold .op-pback'); b.style.backfaceVisibility = 'visible'; });
    const back = await shoot('.op-hold .op-pback');
    // Side by side on one picture, as WebP (the browser encodes it).
    const webp = await p.evaluate(async ({ front, back, FW, FH }) => {
      const img = (b) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b; });
      const [a, b] = await Promise.all([img(front), img(back)]);
      const cv = document.createElement('canvas');
      cv.width = FW * 2; cv.height = FH;
      const c = cv.getContext('2d');
      c.drawImage(a, 0, 0, FW, FH);
      c.drawImage(b, FW, 0, FW, FH);
      return cv.toDataURL('image/webp', 0.9).split(',')[1];
    }, { front, back, FW, FH });
    const file = path.join(OUT, `pack-${k}.webp`);
    fs.writeFileSync(file, Buffer.from(webp, 'base64'));
    console.log(`${path.relative(process.cwd(), file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
    await p.keyboard.press('Escape');
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
