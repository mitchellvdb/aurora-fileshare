/**
 * Renders the social preview cards.
 *
 * A link pasted into a chat is how this tool actually spreads - every transfer
 * produces a URL somebody sends to somebody else - so the card is not
 * decoration, it is the product's main impression. Built from the same tokens
 * as the site and rendered with the real fonts, embedded as data URIs so the
 * headless browser cannot fail to load them.
 *
 *   node scripts/build-og.mjs
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const FONT_DIR = 'public/fonts';
const OUT_DIR = 'public/og';

async function fontData(prefix) {
  const files = await readdir(FONT_DIR);
  const match = files.find((f) => f.startsWith(prefix) && f.endsWith('.woff2'));
  if (!match) throw new Error(`No font matching ${prefix}`);
  return (await readFile(`${FONT_DIR}/${match}`)).toString('base64');
}

const archivo = await fontData('archivo');
const mono = await fontData('jetbrains-mono');

const CARDS = [
  {
    name: 'default',
    kicker: 'Peer to peer · no upload',
    headline: 'Files go straight from your browser to theirs.',
    sub: 'Encrypted, direct, and nothing stored on a server.',
  },
  {
    name: 'share',
    kicker: 'Someone sent you files',
    headline: 'Files are on their way to you.',
    sub: 'Straight from their browser to yours. No upload, no account.',
  },
];

function markup({ kicker, headline, sub }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Archivo;font-weight:100 900;src:url(data:font/woff2;base64,${archivo}) format('woff2')}
@font-face{font-family:'JetBrains Mono';font-weight:100 800;src:url(data:font/woff2;base64,${mono}) format('woff2')}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#060a12;color:#e6eef1;font-family:Archivo,sans-serif;
  position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.aurora{position:absolute;inset:-20% -10% auto -10%;height:820px;
  background:
    radial-gradient(760px 380px at 26% 40%,rgba(67,224,160,.34),transparent 64%),
    radial-gradient(680px 340px at 68% 20%,rgba(53,200,216,.26),transparent 62%),
    radial-gradient(1000px 520px at 50% 4%,rgba(94,116,255,.18),transparent 70%)}
.fade{position:absolute;inset:0;background:linear-gradient(180deg,transparent 48%,#060a12 100%)}
.inner{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;
  padding:72px 80px;justify-content:space-between}
.brand{display:flex;align-items:center;gap:14px;font-size:26px;font-weight:600;letter-spacing:-.01em}
.dot{width:14px;height:14px;border-radius:50%;background:#43e0a0;box-shadow:0 0 18px 3px rgba(67,224,160,.75)}
.kicker{font-family:'JetBrains Mono',monospace;font-size:19px;letter-spacing:.14em;
  text-transform:uppercase;color:#43e0a0;margin-bottom:26px}
h1{font-size:70px;line-height:1.04;letter-spacing:-.035em;font-weight:600;max-width:17ch}
.sub{font-size:27px;line-height:1.5;color:#93a4ae;margin-top:26px;max-width:40ch}
.foot{font-family:'JetBrains Mono',monospace;font-size:21px;color:#7d8d97}
</style></head><body>
<div class="aurora"></div><div class="fade"></div>
<div class="inner">
  <div class="brand"><span class="dot"></span>Aurora FileShare</div>
  <div>
    <div class="kicker">${kicker}</div>
    <h1>${headline}</h1>
    <div class="sub">${sub}</div>
  </div>
  <div class="foot">fileshare.aurorahosting.nl</div>
</div></body></html>`;
}

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });

const manifest = {};
for (const card of CARDS) {
  await page.setContent(markup(card), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ type: 'png' });
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 8);
  const file = `og-${card.name}.${hash}.png`;
  await writeFile(`${OUT_DIR}/${file}`, buf);
  manifest[card.name] = `/og/${file}`;
  console.log(`  ${file}  ${(buf.length / 1024).toFixed(0)} KB`);
}
await writeFile(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
await browser.close();
console.log('[og] cards written');
