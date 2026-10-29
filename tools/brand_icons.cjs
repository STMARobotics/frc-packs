// The FRC Packs mark (Seam): a pack with its top lifted off along one teal seam, a teal spark on the front. Writes the
// favicon and every app icon into web/public from the one drawing below (the site's header uses the same shapes in
// web/src/site/ui.tsx, Logo):
//   node tools/brand_icons.cjs
// favicon.svg (the mark on its navy tile), icon-192.png and icon-512.png (the tile, for "any"), icon-maskable-512.png
// (full-bleed navy with the mark inside Android's safe circle), apple-touch-icon.png (180, full-bleed: iOS rounds it),
// badge-96.png (white on transparent: Android draws notification badges from the shape alone).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const NAVY = '#0b0e17', NAVY2 = '#14306a', INK = '#eef1f8', TEAL = '#3cffdc';
const OUT = path.join(__dirname, '..', 'web', 'public');

/** A four-point spark centred on (cx, cy), `r` tip to centre. */
function spark(cx, cy, r, w = 0.3) {
  const k = r * w, f = (n) => n.toFixed(2);
  return `M${cx} ${cy - r} C${f(cx + k / 3)} ${f(cy - k)} ${f(cx + k)} ${f(cy - k / 3)} ${cx + r} ${cy} ` +
    `C${f(cx + k)} ${f(cy + k / 3)} ${f(cx + k / 3)} ${f(cy + k)} ${cx} ${cy + r} ` +
    `C${f(cx - k / 3)} ${f(cy + k)} ${f(cx - k)} ${f(cy + k / 3)} ${cx - r} ${cy} ` +
    `C${f(cx - k)} ${f(cy - k / 3)} ${f(cx - k / 3)} ${f(cy - k)} ${cx} ${cy - r} Z`;
}
/** The mark on a 64x64 grid: `ink` is the pack, `seam` the line and the spark. */
const mark = (ink, seam = TEAL) =>
  `<rect x="17" y="23" width="30" height="35" rx="5" fill="${ink}"/>` +
  `<rect x="17" y="19.5" width="30" height="2.8" rx="1.4" fill="${seam}"/>` +
  `<rect x="17" y="8.5" width="30" height="7" rx="3" fill="${ink}" transform="rotate(-10 17 15.5)"/>` +
  `<path d="${spark(32, 40.5, 7.5)}" fill="${seam}"/>`;
const bg = `<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${NAVY2}"/><stop offset="1" stop-color="${NAVY}"/></linearGradient></defs>`;
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bg}<rect width="64" height="64" rx="14" fill="url(#b)"/>${mark(INK)}</svg>`;
const bleed = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bg}<rect width="64" height="64" fill="url(#b)"/><g transform="translate(32 33) scale(${scale}) translate(-32 -33)">${mark(INK)}</g></svg>`;
// A badge is only a shape: the whole mark in white, with the spark cut out of the pack so it still shows.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m"><rect width="64" height="64" fill="#000"/>${mark('#fff', '#fff')}<path d="${spark(32, 40.5, 7.5)}" fill="#000"/></mask></defs><rect width="64" height="64" fill="#fff" mask="url(#m)"/></svg>`;

const PNGS = [
  ['icon-192.png', tile, 192], ['icon-512.png', tile, 512], ['icon-maskable-512.png', bleed(0.78), 512],
  ['apple-touch-icon.png', bleed(0.86), 180], ['badge-96.png', badge, 96],
];

(async () => {
  fs.writeFileSync(path.join(OUT, 'favicon.svg'), tile);
  const browser = await chromium.launch();
  const p = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, svg, size] of PNGS) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await p.screenshot({ path: path.join(OUT, name), omitBackground: true });
  }
  await browser.close();
  console.log('wrote favicon.svg and', PNGS.map((x) => x[0]).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
