// A new beta tester's first session on a big Android phone (Galaxy S26 Ultra size), against a local server with
// DEV_TOOLS=1. Walks every main flow, counts the taps and waits, and saves a screenshot per step:
//   node test/ux-audit.cjs [http://127.0.0.1:3000] [screenshot dir]
// Not a pass/fail test: it prints a step log for the friction audit.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const OUT = process.argv[3] || path.join(__dirname, 'audit');
fs.mkdirSync(OUT, { recursive: true });

const S26 = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 3.5,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S948U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

const log = [];
let taps = 0, n = 0, t0 = Date.now();
function note(step, extra = '') { log.push({ step, taps, secs: ((Date.now() - t0) / 1000).toFixed(1), extra }); console.log(`${String(taps).padStart(3)} taps  ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${step}${extra ? '  — ' + extra : ''}`); }

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext(S26);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => { n++; await p.waitForTimeout(400); await p.screenshot({ path: path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`) }); };
  const tap = async (sel, opts = {}) => { await p.locator(sel).first().click({ timeout: 6000, ...opts }); taps++; await p.waitForTimeout(350); };
  const visible = async (sel) => p.locator(sel).first().isVisible().catch(() => false);
  const step = async (name, fn) => { try { await fn(); } catch (e) { note(name, 'FAILED: ' + e.message.split('\n')[0]); await shot(name + '-failed'); } };

  // 1. Sign up.
  await p.goto(BASE + '/');
  await p.waitForSelector('#auth:not([hidden])');
  t0 = Date.now();
  await shot('sign-in');
  note('landing: sign-in screen');
  const code = await p.evaluate(async () => (await (await fetch('/api/dev/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).code);
  await step('join with invite', async () => {
    await tap('#authJoinTab');
    if (await visible('#betaAgree')) { await shot('beta-terms'); await tap('#betaAgree'); }
    await shot('join-form');
    const f = p.locator('#joinForm');
    const fields = await f.locator('input:visible').count();
    const name = 'aud' + Date.now().toString(36).slice(-5);
    const inputs = f.locator('input:visible');
    for (let i = 0; i < fields; i++) {
      const nm = await inputs.nth(i).getAttribute('name');
      const v = nm === 'code' ? code : /pass/.test(nm || '') ? 'password123' : nm === 'username' ? name : 'Audit';
      await inputs.nth(i).fill(v); taps++;
    }
    await f.locator('button[type=submit]').click(); taps++;
    await p.waitForTimeout(2500);
    note('signed up', `${fields} fields`);
  });
  await shot('first-screen');

  // 2. First-run tips, team pick and whatever pops up.
  await step('first-run popups', async () => {
    for (let i = 0; i < 8; i++) {
      if (await visible('#teamPick:not([hidden]) #teamSkip')) { await shot('team-pick'); await tap('#teamSkip'); continue; }
      if (await visible('#coach:not([hidden])')) { await shot('coach-' + i); const skip = await visible('#coachSkip'); if (skip && i > 2) await tap('#coachSkip'); else await tap('#coach button:visible'); continue; }
      if (await visible('#modal:not([hidden]) .cta')) { await shot('modal-' + i); await tap('#modal:not([hidden]) .cta.ghost, #modal:not([hidden]) .cta'); continue; }
      break;
    }
    note('popups cleared');
  });
  await shot('home');

  // 3. Claim, open a pack, see the cards.
  await step('claim', async () => { if (await visible('#claim:not([disabled])')) { await tap('#claim'); note('claimed free packs'); } });
  const swipe = async (sel, fx0, fy0, fx1, fy1) => {
    const box = await p.locator(sel).first().boundingBox();
    const x0 = box.x + box.width * fx0, y0 = box.y + box.height * fy0, x1 = box.x + box.width * fx1, y1 = box.y + box.height * fy1;
    await p.mouse.move(x0, y0);
    await p.mouse.down();
    for (let i = 1; i <= 10; i++) { await p.mouse.move(x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10); await p.waitForTimeout(16); }
    await p.mouse.up();
    taps++;
    await p.waitForTimeout(500);
  };
  await step('open a pack', async () => {
    const start = taps, tStart = Date.now();
    await tap('#collection .ptype, #collection button');
    await p.waitForTimeout(800);
    if (await visible('#selectView:not([hidden]) #ring')) {
      await shot('wheel');
      const box = await p.locator('#ring').boundingBox();
      await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2); taps++;
      await p.waitForTimeout(900);
    }
    await shot('inspect');
    // Cut the top of the pack.
    await swipe('#inspect', 0.08, 0.1, 0.92, 0.1);
    await p.waitForTimeout(2500);
    await shot('after-cut');
    let flips = 0;
    for (let i = 0; i < 12 && !(await visible('#summary:not([hidden])')); i++) {
      if (!(await visible('#stack'))) { await p.waitForTimeout(800); continue; }
      await swipe('#stack', 0.5, 0.5, 1.4, 0.45);
      flips++;
      await p.waitForTimeout(900);
      if (i === 0) await shot('first-card');
    }
    await shot('summary');
    note('pack opened', `${taps - start} taps/swipes and ${((Date.now() - tStart) / 1000).toFixed(0)}s from home to the summary (${flips} on the cards)`);
  });

  // 4. Binder and a card.
  await step('binder', async () => {
    await tap('#tabBinder');
    await shot('binder');
    await p.waitForTimeout(800);
    await p.locator('#grid .slot').first().click({ force: true }); taps++;
    await p.waitForTimeout(800);
    await shot('card-view');
    note('opened a card from the binder');
    await p.keyboard.press('Escape');
  });

  // 5. Trade, social, settings, feedback.
  await step('trade', async () => { await tap('#tabTrade'); await shot('trade'); note('trade tab'); });
  await step('social', async () => { await tap('#tabSocial'); await shot('social'); note('social tab'); });
  await step('feedback', async () => {
    const start = taps;
    await p.keyboard.press('Escape');
    await tap('#tabOpen');
    await tap('#gear');
    await shot('settings');
    await tap('#feedbackBtn');
    await shot('feedback-form');
    note('feedback form reached', `${taps - start} taps from anywhere`);
    await p.fill('.feedback input[name=title]', 'Audit: test bug report');
    await p.fill('.feedback textarea[name=details]', 'Sent by the UX audit script.');
    await tap('.feedback button[type=submit]');
    note('bug report sent');
    await p.keyboard.press('Escape');
  });

  // 6. The daily reminder (pretend the last one was yesterday).
  await step('daily reminder', async () => {
    await p.evaluate(() => localStorage.setItem('frcpacks.bugNudge', new Date(Date.now() - 86400000).toDateString()));
    await p.reload();
    await p.waitForSelector('.bug-nudge', { timeout: 15000 });
    await shot('bug-reminder');
    note('daily reminder shows');
    await tap('.bug-nudge .bn-x');
    await p.reload();
    await p.waitForTimeout(8000);
    note('reminder after closing', (await visible('.bug-nudge')) ? 'STILL SHOWS' : 'stays closed until tomorrow');
  });

  fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify({ log, errors }, null, 1));
  console.log('page errors:', errors.length ? errors : 'none');
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
