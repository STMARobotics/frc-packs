// Renders sheet.html to sheet.png (desktop width) and sheet-phone.png (390 wide): node prototype/brand/render.cjs
const { chromium } = require('playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const b = await chromium.launch();
  for (const [w, name] of [[1040, 'sheet.png'], [390, 'sheet-phone.png']]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 });
    await p.goto(pathToFileURL(path.join(__dirname, 'sheet.html')).href);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(800);
    await p.screenshot({ path: path.join(__dirname, name), fullPage: true });
  }
  await b.close();
})();
