// What the server gets to see, checked from the outside.
//
// Two real browsers, every WebSocket frame captured from both. The claim under
// test: the server relays ciphertext. It never sees a file name, never sees
// the DTLS fingerprints (so it cannot put itself in the middle), and never
// sees either side's network candidates. Also covered: a link without its
// secret, and "ask me first" - both allowing and declining.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const TMP = new URL('./.tmp/e2e/', import.meta.url).pathname;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const ORIGIN = process.env.TEST_ORIGIN ?? 'http://127.0.0.1:8080';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}

const SECRET_NAME = 'geheim-belastingaangifte-2026.pdf';
const filePath = `${TMP}${SECRET_NAME}`;
writeFileSync(filePath, randomBytes(64 * 1024));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

/** A page whose WebSocket traffic, both ways, lands in `frames`. */
async function tappedPage() {
  const page = await browser.newPage();
  const frames = [];
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameSent', (e) => frames.push(e.response.payloadData));
  cdp.on('Network.webSocketFrameReceived', (e) => frames.push(e.response.payloadData));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { page, frames, errors };
}

async function startShare(page, { approve = false } = {}) {
  // A real click in a background tab never completes in headless Chromium.
  await page.bringToFront();
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
  await (await page.$('#file-input')).uploadFile(filePath);
  await page.waitForFunction(() => !document.querySelector('#start-share').disabled, { timeout: 5000 });
  if (approve) await page.click('#approve');
  await page.click('#start-share');
  await page.waitForFunction(
    () => document.querySelector('#share-url')?.value?.startsWith('http'), { timeout: 10000 });
  return page.$eval('#share-url', (el) => el.value);
}

const text = (page, sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
const waitText = (page, sel, re, timeout = 15000) => page.waitForFunction(
  (s, src) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ''),
  { timeout }, sel, re.source).then(() => true, () => false);

try {
  // --- 1. An ordinary share: nothing readable crosses the server ------------
  {
    const s = await tappedPage();
    const r = await tappedPage();
    const url = await startShare(s.page);
    check('the link carries a 128-bit secret after #',
      /\/d\/[a-z]+-[a-z]+-\d{3}#[A-Za-z0-9_-]{22}$/.test(url), url);

    await r.page.goto(url, { waitUntil: 'networkidle0' });
    check('the recipient sees the file name',
      await waitText(r.page, '#file-list', new RegExp(SECRET_NAME.replace(/\./g, '\\.'))));
    const connected = await r.page.waitForFunction(
      () => !document.querySelector('button.download')?.disabled, { timeout: 20000 }).then(() => true, () => false);
    check('and gets a direct connection', connected);

    const all = [...s.frames, ...r.frames];
    const joined = all.join('\n');
    check('frames were captured at all', all.length >= 6, String(all.length));
    check('no frame contains the file name', !joined.includes('belastingaangifte'));
    check('no frame contains a DTLS fingerprint', !joined.includes('fingerprint'));
    check('no frame contains an ICE candidate', !/candidate:|typ host|typ srflx/.test(joined));
    check('no frame contains the secret', !joined.includes(url.split('#')[1]));
    check('no page errors', s.errors.length + r.errors.length === 0, [...s.errors, ...r.errors].join(' | '));
    await s.page.close(); await r.page.close();
  }

  // --- 2. A link without its secret ---------------------------------------
  {
    const s = await tappedPage();
    const url = await startShare(s.page);
    const r = await tappedPage();
    await r.page.goto(url.split('#')[0], { waitUntil: 'networkidle0' });
    check('a link cut off before # says it is incomplete', /incomplete/.test(await text(r.page, '#error')));
    check('and does not even contact the server', r.frames.length === 0, String(r.frames.length));
    await s.page.close(); await r.page.close();
  }

  // --- 3. Ask me first: allow ----------------------------------------------
  {
    const s = await tappedPage();
    const url = await startShare(s.page, { approve: true });
    const r = await tappedPage();
    await r.page.goto(url, { waitUntil: 'networkidle0' });
    check('the recipient is told to wait', await waitText(r.page, '#status', /Waiting for the sender/));
    const early = await r.page.content();
    check('and sees no file names while waiting', !early.includes('belastingaangifte'));
    check('the sender is asked', await waitText(s.page, '#recipients', /Someone opened the link/));

    await s.page.evaluate(() => [...document.querySelectorAll('.approve-actions button')]
      .find((b) => b.textContent === 'Allow').click());
    check('after Allow the recipient sees the files',
      await waitText(r.page, '#file-list', /belastingaangifte/));
    const connected = await r.page.waitForFunction(
      () => !document.querySelector('button.download')?.disabled, { timeout: 20000 }).then(() => true, () => false);
    check('and connects', connected);
    check('the names still never crossed the server in the clear',
      ![...s.frames, ...r.frames].join('\n').includes('belastingaangifte'));

    // --- 4. ...and decline, on the same share -----------------------------
    const r2 = await tappedPage();
    await r2.page.goto(url, { waitUntil: 'networkidle0' });
    await waitText(s.page, '#recipients', /Someone opened the link/);
    await s.page.evaluate(() => [...document.querySelectorAll('.approve-actions button')]
      .find((b) => b.textContent === 'Decline').click());
    check('after Decline the recipient is told', await waitText(r2.page, '#status', /declined/));
    check('and never saw a file name', !(await r2.page.content()).includes('belastingaangifte'));
    await s.page.close(); await r.page.close(); await r2.page.close();
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nALL E2E TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
