// Everything else reaches the server on 127.0.0.1, which browsers treat as a
// secure context. Real LAN access does not get that: over plain HTTP to a
// routable address, crypto.randomUUID and service workers are both unavailable.
//
// That difference is not cosmetic - it broke the page outright once, because
// crypto.randomUUID() throws when it is missing. This suite pins the fallbacks
// by driving a complete transfer over the machine's own LAN address.
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const TMP = new URL('./.tmp/insecure/', import.meta.url).pathname;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const domClick = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

const port = new URL(process.env.TEST_ORIGIN ?? 'http://127.0.0.1:8080').port;
const lan = lanAddress();
if (!lan) {
  console.log('SKIP  no non-loopback IPv4 address on this host');
  process.exit(0);
}
const ORIGIN = `http://${lan}:${port}`;
console.log(`origin: ${ORIGIN} (insecure context)\n`);

const SIZE = 2 * 1024 * 1024;
const seed = 1234;
const payload = Buffer.allocUnsafe(SIZE);
let x = seed >>> 0;
for (let i = 0; i < SIZE; i++) { x = (x * 1664525 + 1013904223) >>> 0; payload[i] = x >>> 24; }
const expected = sha256(payload);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  headless: true,
  protocolTimeout: 120000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
         '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

try {
  const senderErrors = [];
  const sender = await browser.newPage();
  sender.on('pageerror', (e) => senderErrors.push(String(e)));
  sender.on('console', (m) => { if (m.type() === 'error') senderErrors.push(m.text()); });
  await sender.goto(ORIGIN, { waitUntil: 'networkidle0' });

  check('page is genuinely an insecure context',
    !(await sender.evaluate(() => window.isSecureContext)));
  check('crypto.randomUUID is indeed unavailable here',
    await sender.evaluate(() => typeof crypto.randomUUID !== 'function'));

  await sender.evaluate((size, sd) => {
    const buf = new Uint8Array(size);
    let y = sd >>> 0;
    for (let i = 0; i < size; i++) { y = (y * 1664525 + 1013904223) >>> 0; buf[i] = y >>> 24; }
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'lan-payload.bin', { type: 'application/octet-stream' }));
    const input = document.querySelector('#file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, SIZE, seed);

  await sender.waitForFunction(
    () => !document.querySelector('#start-share').disabled, { timeout: 10000 });
  check('sender accepted the file without a crypto error', true);

  await domClick(sender, '#start-share');
  await sender.waitForFunction(
    () => document.querySelector('#share-url')?.value?.startsWith('http'), { timeout: 15000 });
  const shareUrl = await sender.$eval('#share-url', (el) => el.value);
  check('a share link was issued over plain HTTP', /\/d\/[a-z]+-[a-z]+-\d{3}#[A-Za-z0-9_-]{22}$/.test(shareUrl), shareUrl);

  const context = await browser.createBrowserContext();
  const receiver = await context.newPage();
  const receiverErrors = [];
  receiver.on('pageerror', (e) => receiverErrors.push(String(e)));
  receiver.on('console', (m) => { if (m.type() === 'error') receiverErrors.push(m.text()); });
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: TMP, browserContextId: context.id, eventsEnabled: true });

  await receiver.goto(shareUrl, { waitUntil: 'networkidle0' });
  await receiver.waitForFunction(
    () => { const b = document.querySelector('#file-list button.download'); return b && !b.disabled; },
    { timeout: 30000 });
  check('WebRTC connected over the LAN address', true);

  check('falls back to the in-memory save path and says so',
    !(await receiver.$eval('#mode-note', (el) => el.hidden)));

  await domClick(receiver, '#file-list button.download');
  await receiver.waitForFunction(
    () => document.querySelector('#file-list .file-status')?.textContent === 'Complete',
    { timeout: 120000 });

  let got = null;
  for (let i = 0; i < 120; i++) {
    const names = readdirSync(TMP).filter((f) => !f.endsWith('.crdownload'));
    if (names.includes('lan-payload.bin')) {
      const buf = readFileSync(`${TMP}/lan-payload.bin`);
      if (buf.length === SIZE) { got = buf; break; }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('file saved via the fallback path', got !== null, readdirSync(TMP).join(', '));
  if (got) check('sha256 matches over an insecure context', sha256(got) === expected);

  check('no uncaught errors on either page',
    senderErrors.length === 0 && receiverErrors.length === 0,
    [...senderErrors, ...receiverErrors].join(' | '));
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nALL INSECURE-CONTEXT TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
