// Builds the pack-opening preview: the real app with a pretend server in the page (web/preview/mock.ts), so the opening
// can be tried anywhere, with no account and no server. One HTML page with the script and styles inside it, plus the
// photos of the teams in play and the WebGL pack's pictures beside it, ready to publish as a claude.ai artifact:
//   node tools/open_preview.cjs <out dir>
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'web', 'preview', 'out'));
const BUILD = path.join(OUT, '.build');
fs.rmSync(OUT, { recursive: true, force: true });

const viteDir = path.dirname(require.resolve('vite/package.json', { paths: [path.join(ROOT, 'web')] }));
execFileSync(process.execPath, [path.join(viteDir, 'bin', 'vite.js'), 'build', '-c', path.join(ROOT, 'web', 'preview', 'vite.config.ts'), '--logLevel', 'warn'],
  { stdio: 'inherit', env: { ...process.env, PREVIEW_OUT: BUILD } });

const html = fs.readFileSync(path.join(BUILD, 'index.html'), 'utf8');
const file = (re) => fs.readFileSync(path.join(BUILD, html.match(re)[1]), 'utf8');
const js = file(/<script type="module" crossorigin src="\.\/([^"]+)"/).replace(/<\/script/gi, '<\\/script');
const css = file(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)"/).replace(/<\/style/gi, '<\\/style');
// The page as the artifact wants it: no document skeleton of its own (it gets one when published).
const page = `<title>FRC Packs Opening Preview</title>
<style>${css}</style>
<div id="app"></div>
<script>document.body.classList.add("s-page");</script>
<script type="module">${js}</script>
`;
fs.writeFileSync(path.join(OUT, 'index.html'), page);
fs.rmSync(BUILD, { recursive: true, force: true });

// The photos of the teams in play (the same rule as mock.ts's CAST), the extra binder cards, and the pack pictures.
const CAST = { common: 14, uncommon: 10, rare: 8, legendary: 6, mythic: 5 };
const extraSeedTeams = require('../web/preview/extra-seed-teams.json');
const recipe = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'packs', 'cmp26.json'), 'utf8'));
const seen = { common: 0, uncommon: 0, rare: 0, legendary: 0, mythic: 0 };
fs.mkdirSync(path.join(OUT, 'photos'));
for (const t of recipe.teams) {
  const inPool = t.photo && seen[t.tier] < CAST[t.tier];
  if (inPool) seen[t.tier]++;
  if (!inPool && !extraSeedTeams.includes(t.num)) continue;
  if (t.photo) fs.copyFileSync(path.join(ROOT, 'data', 'photos', `${t.num}.webp`), path.join(OUT, 'photos', `${t.num}.webp`));
  if (t.avatar) {
    fs.mkdirSync(path.join(OUT, 'photos', 'avatars'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'photos', 'avatars', `${t.num}.png`), path.join(OUT, 'photos', 'avatars', `${t.num}.png`));
  }
}
fs.cpSync(path.join(ROOT, 'web', 'public', 'gl'), path.join(OUT, 'gl'), { recursive: true });

const kb = (f) => (fs.statSync(f).size / 1024).toFixed(0);
console.log(`${path.join(OUT, 'index.html')}  ${kb(path.join(OUT, 'index.html'))} KB, ${fs.readdirSync(path.join(OUT, 'photos')).filter((f) => f.endsWith('.webp')).length} photos, ${fs.readdirSync(path.join(OUT, 'gl')).length} pack pictures`);
