/**
 * Renders the social preview cards, in the style of the October 2026 redesign.
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

const display = await fontData('bricolage-grotesque');
const sans = await fontData('instrument-sans');
const mono = await fontData('jetbrains-mono');
const logo = (await readFile('public/icon.svg')).toString('base64');

// The October 2026 redesign: the site's own background, type and motifs,
// frozen into one frame. `mark` is the phrase underlined in the headline.
const CARDS = [
  {
    name: 'default',
    kicker: 'Peer to peer · no upload',
    headline: 'Files go straight from your browser to theirs.',
    mark: 'straight',
    sub: 'Encrypted, direct, and nothing stored on a server.',
    from: 'You',
    to: 'Them',
  },
  {
    name: 'share',
    kicker: 'Someone sent you files',
    headline: 'Files are on their way to you.',
    mark: 'on their way',
    sub: 'Straight from their browser to yours. No upload, no account.',
    // Whoever sees this card is the one receiving.
    from: 'Sender',
    to: 'You',
  },
];

// A fixed scatter of particles, the same on every build.
const DOTS = [[8, 18, 3], [17, 74, 2], [29, 9, 2], [38, 88, 3], [52, 14, 2], [61, 70, 2],
  [69, 31, 3], [77, 86, 2], [86, 12, 3], [93, 52, 2], [46, 46, 2], [12, 52, 2], [97, 82, 3]]
  .map(([x, y, r]) => `<i class="pt" style="left:${x}%;top:${y}%;width:${r}px;height:${r}px"></i>`).join('');

function markup({ kicker, headline, mark, sub, from, to }) {
  const h1 = headline.replace(mark, `<span class="under">${mark}</span>`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'Bricolage Grotesque';font-weight:200 800;src:url(data:font/woff2;base64,${display}) format('woff2')}
@font-face{font-family:'Instrument Sans';font-weight:400 700;src:url(data:font/woff2;base64,${sans}) format('woff2')}
@font-face{font-family:'JetBrains Mono';font-weight:100 800;src:url(data:font/woff2;base64,${mono}) format('woff2')}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#060912;color:#e8eefc;font-family:'Instrument Sans',sans-serif;
  position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.grid{position:absolute;inset:0;
  background-image:linear-gradient(rgba(255,255,255,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.055) 1px,transparent 1px);
  background-size:64px 64px;-webkit-mask-image:linear-gradient(180deg,#000 0,transparent 560px)}
.blob{position:absolute;border-radius:50%;filter:blur(90px)}
.a{width:760px;height:520px;left:-220px;top:-200px;background:#4de8b0;opacity:.30}
.b{width:680px;height:560px;right:-200px;top:-80px;background:#9a86ff;opacity:.34}
.c{width:560px;height:360px;right:120px;bottom:-300px;background:#4de8b0;opacity:.16}
.ribbon{position:absolute;left:-20%;width:140%;height:260px;top:120px;transform:skewY(-6deg);
  background:linear-gradient(90deg,transparent 0%,#4de8b0 30%,#9a86ff 65%,transparent 100%);filter:blur(70px);opacity:.22}
.pt{position:absolute;border-radius:50%;background:#fff;opacity:.55}
.inner{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:60px 76px 56px}
.brand{display:flex;align-items:center;gap:16px;font:700 28px 'Bricolage Grotesque',sans-serif;letter-spacing:-.01em}
.brand img{width:44px;height:44px;border-radius:13px}
.badge{display:inline-flex;align-items:center;gap:12px;padding:10px 18px;margin-bottom:28px;
  border:1px solid rgba(255,255,255,.14);border-radius:99px;background:rgba(255,255,255,.06);
  font:400 17px 'JetBrains Mono',monospace;letter-spacing:.06em;text-transform:uppercase;color:#a3b0cf}
.badge i{width:10px;height:10px;border-radius:50%;background:#4de8b0;box-shadow:0 0 0 6px rgba(77,232,176,.18)}
h1{font:700 76px/1.02 'Bricolage Grotesque',sans-serif;letter-spacing:-.035em;max-width:15.5ch}
.under{color:#4de8b0;background:linear-gradient(#4de8b0,#4de8b0) 0 94%/100% 7px no-repeat;border-radius:4px}
.sub{font-size:27px;line-height:1.45;color:#a3b0cf;margin-top:24px;max-width:44ch}
.foot{display:flex;align-items:center;justify-content:space-between;gap:24px}
.url{font:400 20px 'JetBrains Mono',monospace;color:#a3b0cf}
.lane{display:flex;align-items:center;gap:12px}
.node{padding:9px 14px;border-radius:11px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);
  font:500 16px 'JetBrains Mono',monospace;color:#e8eefc}
.track{position:relative;width:230px;height:2px;background:rgba(77,232,176,.45)}
.track b{position:absolute;top:-5px;width:12px;height:12px;border-radius:3px;background:#4de8b0;box-shadow:0 0 14px rgba(77,232,176,.8)}
</style></head><body>
<div class="grid"></div><div class="ribbon"></div><div class="blob a"></div><div class="blob b"></div><div class="blob c"></div>${DOTS}
<div class="inner">
  <div class="brand"><img src="data:image/svg+xml;base64,${logo}" alt="">Aurora FileShare</div>
  <div>
    <div class="badge"><i></i>${kicker}</div>
    <h1>${h1}</h1>
    <div class="sub">${sub}</div>
  </div>
  <div class="foot">
    <span class="url">fileshare.aurorahosting.nl</span>
    <span class="lane"><span class="node">${from}</span><span class="track"><b style="left:14%"></b><b style="left:46%"></b><b style="left:78%"></b></span><span class="node">${to}</span></span>
  </div>
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
