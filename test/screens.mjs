/**
 * Regenerates the screenshots in docs/screenshots/ used by the README.
 *
 * Captures the viewport rather than the full page: a full-page capture in
 * headless Chromium composites the footer over the header on tall documents,
 * which looks like a rendering bug in the product when it is an artefact of
 * the screenshot.
 *
 *   npm run build && node test/screens.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs/screenshots');
mkdirSync(OUT, { recursive: true });

const port = await new Promise((r) => {
  const p = createServer();
  p.listen(0, '127.0.0.1', () => { const { port } = p.address(); p.close(() => r(port)); });
});
const origin = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    DONATE_URL: 'https://paypal.me/mvdbosch',
    SOURCE_URL: 'https://github.com/mitchellvdb/aurora-fileshare',
  },
  stdio: 'ignore',
});
for (let i = 0; i < 60; i++) {
  try { await fetch(`${origin}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--force-device-scale-factor=1'],
});

const VIEW = { width: 1280, height: 900 };
const errors = [];
const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

async function shoot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await settle();
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ${name}.png`);
}

/** Puts two files on the picker without touching the OS file dialog. */
const pickFiles = () => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(2_400_000)], 'holiday-photos.zip', { type: 'application/zip' }));
  dt.items.add(new File([new Uint8Array(96_000)], 'packing-list.txt', { type: 'text/plain' }));
  const input = document.querySelector('#file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

try {
  const sender = await browser.newPage();
  await sender.setViewport(VIEW);
  sender.on('pageerror', (e) => errors.push(String(e)));
  sender.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await sender.goto(origin, { waitUntil: 'networkidle0' });
  await shoot(sender, '01-idle');

  await sender.evaluate(pickFiles);
  await sender.waitForFunction(() => !document.querySelector('#start-share').disabled);
  await shoot(sender, '02-files-chosen');

  await sender.evaluate(() => document.querySelector('#start-share').click());
  await sender.waitForFunction(
    () => document.querySelector('#share-url')?.value?.startsWith('http'), { timeout: 15000 });
  await shoot(sender, '03-share-link');

  // A second browser opens the link, so the transfer is real.
  const url = await sender.$eval('#share-url', (el) => el.value);
  const receiver = await browser.newPage();
  await receiver.setViewport(VIEW);
  receiver.on('pageerror', (e) => errors.push(String(e)));
  await receiver.goto(url, { waitUntil: 'networkidle0' });
  await receiver.waitForFunction(
    () => { const b = document.querySelector('#file-list button.download'); return b && !b.disabled; },
    { timeout: 20000 });
  await receiver.evaluate(() => document.querySelector('#file-list button.download').click());
  await settle(1200);
  await shoot(receiver, '04-receiving');

  // The sender's transfer card sits below the fold at the standard height, and
  // it is the part worth showing. Scrolling to it slices the card above in
  // half, so take this one frame taller instead and keep every edge intact.
  await sender.setViewport({ ...VIEW, height: 1180 });
  await sender.evaluate(() => window.scrollTo(0, 0));
  await shoot(sender, '05-sending');

  await receiver.close();

  const faq = await browser.newPage();
  await faq.setViewport(VIEW);
  await faq.goto(`${origin}/faq`, { waitUntil: 'networkidle0' });
  await shoot(faq, '06-docs');

  console.log(errors.length ? `\npage errors: ${errors.join(' | ')}` : '\nno page errors');
} finally {
  await browser.close();
  server.kill();
}
