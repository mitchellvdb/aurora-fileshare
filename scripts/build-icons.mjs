/**
 * Renders the icon set from public/icon.svg:
 *
 *   favicon.ico           16, 32 and 48 px in one file
 *   apple-touch-icon.png  180 px, what iOS uses for a home-screen shortcut
 *   icon-192.png, icon-512.png
 *
 * Why: browsers cope with the SVG alone, but crawlers do not. Googlebot-Image
 * and every link-preview bot ask for /favicon.ico by name, and Google only
 * shows a site's icon in search results when it can fetch a raster favicon
 * in a multiple of 48 px. Without one the result gets a generic globe.
 *
 * The output is committed, like the social cards (build-og.mjs), so the
 * server never needs a browser. Re-run after changing icon.svg:
 *
 *   node scripts/build-icons.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const svg = await readFile('public/icon.svg', 'utf8');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

async function render(size) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style>`
    + svg.replace('<svg ', `<svg width="${size}" height="${size}" `),
  );
  return Buffer.from(await page.screenshot({ omitBackground: true, type: 'png' }));
}

/** An .ico holding PNG images, which every current browser and crawler reads. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2);                       // palette
    e.writeUInt8(0, 3);                       // reserved
    e.writeUInt16LE(1, 4);                    // colour planes
    e.writeUInt16LE(32, 6);                   // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const sizes = [16, 32, 48];
const images = [];
for (const size of sizes) images.push({ size, png: await render(size) });
await writeFile('public/favicon.ico', ico(images));
await writeFile('public/apple-touch-icon.png', await render(180));
await writeFile('public/icon-192.png', await render(192));
await writeFile('public/icon-512.png', await render(512));
await browser.close();
console.log('[icons] favicon.ico (16/32/48), apple-touch-icon.png, icon-192.png, icon-512.png');
