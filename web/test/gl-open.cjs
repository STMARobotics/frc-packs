// The WebGL pack, at phone size, against a local server started with DEV_TOOLS=1:
//   node test/gl-open.cjs [http://127.0.0.1:3000] [screenshot dir]
// Opens packs by hand (swipe across the top, tap through the cards) and checks: the WebGL pack takes over from the DOM
// one, a part-way tear lets go and closes, a full tear opens the pack and deals the cards, the summary shows, no page
// errors, and nothing draws while the pack just sits in your hand. Then the same with reduced motion: the DOM pack,
// no WebGL. Screenshots of each moment go to the screenshot dir.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const OUT = process.argv[3] || path.join(__dirname, 'shots-gl');
fs.mkdirSync(OUT, { recursive: true });
const assert = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok  ' + m); };
const VERSION = fs.readFileSync(path.join(__dirname, '../src/site/notes.ts'), 'utf8').match(/VERSION = "([^"]+)"/)[1];

async function account(packs) {
  let cookie = '';
  const call = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
    return r.json();
  };
  const { code } = await call('/api/dev/invite', {});
  await call('/api/signup', { code, username: 'gl' + Date.now().toString(36).slice(-6), password: 'password123', firstName: 'Gl' });
  for (let i = 0; i < packs; i++) await call('/api/dev/pack', { pack: 'cmp26' });
  return cookie.slice(4);
}

async function run(browser, width, reduced) {
  const tag = `${width}${reduced ? '-rm' : ''}`;
  const ctx = await browser.newContext({ viewport: { width, height: width < 380 ? 740 : 844 }, deviceScaleFactor: 2, hasTouch: false, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.addCookies([{ name: 'sid', value: await account(3), url: BASE }]);
  await ctx.addInitScript((v) => { localStorage.setItem('frcpacks.beta', '1'); localStorage.setItem('frcpacks.version', v); }, VERSION);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = (n) => p.screenshot({ path: path.join(OUT, `${tag}-${n}.png`) });
  await p.goto(BASE + '/#open');
  await p.waitForSelector('.op-hero');
  await p.click('.op-hero');
  await p.waitForSelector('.op-hold');
  if (reduced) {
    await p.waitForTimeout(600);
    assert(!(await p.locator('.op-hold.op-gl').count()), `${tag}: reduced motion keeps the DOM pack`);
  } else {
    await p.waitForSelector('.op-hold.op-gl', { timeout: 8000 });
    assert(true, `${tag}: the WebGL pack takes over`);
  }
  await p.waitForTimeout(900); // landed
  await shot('1-hold');
  // Nothing draws while it sits there: count WebGL frames for a second.
  if (!reduced) {
    const frames = await p.evaluate(() => new Promise((res) => {
      const gl = document.querySelector('.op-glcv').getContext('webgl2') || document.querySelector('.op-glcv').getContext('webgl');
      let n = 0;
      const draw = gl.drawElements.bind(gl), arr = gl.drawArrays.bind(gl);
      gl.drawElements = (...a) => { n++; return draw(...a); };
      gl.drawArrays = (...a) => { n++; return arr(...a); };
      setTimeout(() => res(n), 1000);
    }));
    assert(frames === 0, `${tag}: no drawing while the pack sits in your hand (${frames} draws)`);
  }
  const g = await p.locator('.op-grip').boundingBox();
  const y = g.y + g.height * 0.1;
  // Part way, then let go: it closes up again.
  await p.mouse.move(g.x + g.width * 0.08, y);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(g.x + g.width * (0.08 + i * 0.04), y); await p.waitForTimeout(30); }
  await p.waitForTimeout(250);
  await shot('2-tearing');
  await p.mouse.up();
  await p.waitForTimeout(500);
  await shot('3-let-go');
  assert(await p.locator('.op-hold').count(), `${tag}: a part-way tear lets go and the pack stays shut`);
  // All the way: it opens.
  await p.mouse.move(g.x + g.width * 0.06, y);
  await p.mouse.down();
  for (let i = 1; i <= 24; i++) { await p.mouse.move(g.x + g.width * (0.06 + i * 0.038), y); await p.waitForTimeout(25); if (i === 16) await shot('4-almost'); }
  await p.mouse.up();
  for (const [ms, n] of [[120, '5-open'], [250, '6-flying'], [300, '7-rising'], [500, '8-dealt']]) { await p.waitForTimeout(ms); await shot(n); }
  await p.waitForSelector('.op-stack', { timeout: 8000 });
  assert(true, `${tag}: a full tear opens the pack and deals the cards`);
  // Tap through: flip, then deal; screenshot each flip.
  for (let i = 0; i < 12 && !(await p.locator('.op-sum').count()); i++) {
    const down = await p.locator('.op-card.op-top.op-tease').count();
    await p.click('.op-stack', { position: { x: 60, y: 80 } }).catch(() => {});
    if (down) { await p.waitForTimeout(470); await shot(`9-flip-${i}`); await p.waitForTimeout(2200); } else await p.waitForTimeout(500);
  }
  await p.waitForSelector('.op-sum', { timeout: 8000 });
  await p.waitForTimeout(1200);
  await shot('10-summary');
  assert(true, `${tag}: the summary shows`);
  assert(!errors.length, `${tag}: no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  try {
    await run(browser, 390, false);
    await run(browser, 360, false);
    await run(browser, 390, true);
  } finally { await browser.close(); }
  console.log('PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
