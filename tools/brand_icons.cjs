// The FRC Packs mark (Seam): a pack with its top torn open along one teal seam; the lid, the seam and the pack's top
// edge rise to the right like the tear. Writes the favicon and every app icon into web/public from the one drawing below
// (the site's header uses the same shapes in web/src/site/ui.tsx, Logo):
//   node tools/brand_icons.cjs
// favicon.svg (the simple mark on its navy tile: it's drawn at 16px), icon-192.png and icon-512.png (the tile, for
// "any"), icon-maskable-512.png (full-bleed navy with the mark inside Android's safe circle), apple-touch-icon.png (180,
// full-bleed: iOS rounds it), badge-96.png (white on transparent: Android draws notification badges from the shape alone).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const NAVY = '#0b0e17', NAVY2 = '#14306a', INK = '#eef1f8', TEAL = '#3cffdc';
const OUT = path.join(__dirname, '..', 'web', 'public');

/** The mark on a 64x64 grid: `ink` is the pack, `seam` the tear. `simple` leaves out the band near the bottom, which
    blurs into the pack at favicon sizes. */
const mark = (ink, seam = TEAL, simple = false) =>
  `<path d="M19 15.6 L45 6.9 Q47 6.3 47 8.4 L47 12.3 L17 22.3 L17 17.5 Q17 16.1 19 15.6 Z" fill="${ink}"/>` +
  `<path d="M17 24.6 L47 14.6 L47 19.8 L17 26 Z" fill="${seam}"/>` +
  (simple
    ? `<path d="M17 28.6 L47 22.4 L47 52 Q47 56 43 56 L21 56 Q17 56 17 52 Z" fill="${ink}"/>`
    : `<path d="M17 28.6 L47 22.4 L47 47.6 L17 47.6 Z" fill="${ink}"/><path d="M17 50.2 H47 V52 Q47 56 43 56 H21 Q17 56 17 52 Z" fill="${ink}"/>`);
const bg = `<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${NAVY2}"/><stop offset="1" stop-color="${NAVY}"/></linearGradient></defs>`;
const tile = (simple = false) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bg}<rect width="64" height="64" rx="14" fill="url(#b)"/>${mark(INK, TEAL, simple)}</svg>`;
const bleed = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bg}<rect width="64" height="64" fill="url(#b)"/><g transform="translate(32 33) scale(${scale}) translate(-32 -33)">${mark(INK)}</g></svg>`;
// A badge is only a shape: the whole mark in white; its gaps keep the tear readable.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${mark('#fff', '#fff')}</svg>`;

const PNGS = [
  ['icon-192.png', tile(), 192], ['icon-512.png', tile(), 512], ['icon-maskable-512.png', bleed(0.78), 512],
  ['apple-touch-icon.png', bleed(0.86), 180], ['badge-96.png', badge, 96],
];

(async () => {
  fs.writeFileSync(path.join(OUT, 'favicon.svg'), tile(true));
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const p = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, svg, size] of PNGS) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await p.screenshot({ path: path.join(OUT, name), omitBackground: true });
  }
  await browser.close();
  console.log('wrote favicon.svg and', PNGS.map((x) => x[0]).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
