// Real end-to-end test: two browser pages, a real WebRTC data channel,
// a real file, and a byte-for-byte integrity check on the result.
import puppeteer from 'puppeteer-core';
import { mkdirSync as _mk } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';

const TMP = new URL('./.tmp/', import.meta.url).pathname;
_mk(TMP, { recursive: true });
const DL = `${TMP}/dl`;
const ORIGIN = 'http://127.0.0.1:8080';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// A 12 MB file of random bytes: big enough to span ~190 chunks and exercise
// the backpressure path, small enough to keep the test quick.
const SIZE = 12 * 1024 * 1024;
const payload = randomBytes(SIZE);
const srcPath = `${TMP}/payload.bin`;
writeFileSync(srcPath, payload);
const expected = sha256(payload);
console.log(`source: ${srcPath} (${SIZE} bytes) sha256=${expected.slice(0, 16)}…\n`);

rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  // --- Sender ---------------------------------------------------------------
  const sender = await browser.newPage();
  const senderErrors = [];
  sender.on('pageerror', (e) => senderErrors.push(String(e)));
  sender.on('console', (m) => { if (m.type() === 'error') senderErrors.push(m.text()); });

  await sender.goto(ORIGIN, { waitUntil: 'networkidle0' });

  const input = await sender.$('#file-input');
  await input.uploadFile(srcPath);
  await sender.waitForFunction(() => !document.querySelector('#start-share').disabled, { timeout: 5000 });
  check('sender lists the chosen file',
    await sender.$eval('#file-list', (el) => el.textContent.includes('payload.bin')));

  await sender.click('#start-share');
  await sender.waitForFunction(
    () => document.querySelector('#share-url')?.value?.startsWith('http'), { timeout: 10000 });

  const shareUrl = await sender.$eval('#share-url', (el) => el.value);
  check('sender receives a share link', /\/d\/[a-z]+-[a-z]+-\d{3}$/.test(shareUrl), shareUrl);
  check('QR code rendered', (await sender.$('#qr svg')) !== null);

  // --- Receiver -------------------------------------------------------------
  const receiver = await browser.newPage();
  const receiverErrors = [];
  receiver.on('pageerror', (e) => receiverErrors.push(String(e)));
  receiver.on('console', (m) => { if (m.type() === 'error') receiverErrors.push(m.text()); });

  const client = await receiver.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: DL, eventsEnabled: true,
  });

  await receiver.goto(shareUrl, { waitUntil: 'networkidle0' });

  // The download button only enables once the data channel is actually open,
  // so waiting on it proves the peer connection came up.
  await receiver.waitForFunction(
    () => { const b = document.querySelector('#file-list button.download'); return b && !b.disabled; },
    { timeout: 20000 });
  check('WebRTC data channel opened between the two pages', true);

  const mode = await receiver.evaluate(() => document.querySelector('#mode-note').hidden ? 'stream' : 'blob');
  console.log(`      (save mode: ${mode})`);

  const status = await receiver.$eval('#status', (el) => el.textContent);
  check('receiver reports a direct connection', /directly/i.test(status), status.trim());

  check('sender sees the recipient',
    /1 person has opened/.test(await sender.$eval('#recipient-count', (el) => el.textContent)));

  // --- Transfer -------------------------------------------------------------
  const started = Date.now();
  await receiver.click('#file-list button.download');
  await receiver.waitForFunction(
    () => document.querySelector('#file-list .file-status')?.textContent === 'Complete',
    { timeout: 120000 });
  const elapsed = (Date.now() - started) / 1000;
  check('transfer reported complete', true, `${elapsed.toFixed(1)}s`);

  // Wait for the browser to finish flushing the file to disk.
  let downloaded = null;
  for (let i = 0; i < 100; i++) {
    const files = readdirSync(DL).filter((f) => !f.endsWith('.crdownload'));
    if (files.length > 0) {
      const candidate = `${DL}/${files[0]}`;
      if (readFileSync(candidate).length === SIZE) { downloaded = candidate; break; }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  check('file landed on disk', downloaded !== null, downloaded ?? readdirSync(DL).join(','));

  if (downloaded) {
    const got = readFileSync(downloaded);
    check('downloaded size matches', got.length === SIZE, `${got.length} vs ${SIZE}`);
    check('sha256 matches the original — bytes are intact', sha256(got) === expected, sha256(got).slice(0, 16) + '…');
    const throughput = SIZE / elapsed / (1024 * 1024);
    console.log(`      (${throughput.toFixed(1)} MB/s over loopback)`);
  }

  // --- Sender progress ------------------------------------------------------
  check('sender shows the transfer finished',
    /Sent payload\.bin/.test(await sender.$eval('#recipients', (el) => el.textContent)));

  check('no uncaught errors on the sender page', senderErrors.length === 0, senderErrors.join(' | '));
  check('no uncaught errors on the receiver page', receiverErrors.length === 0, receiverErrors.join(' | '));

  // --- Sender leaves --------------------------------------------------------
  await sender.close();
  await receiver.waitForFunction(
    () => /disconnect|closed|tab/i.test(document.querySelector('#status')?.textContent ?? ''),
    { timeout: 10000 });
  check('receiver is told when the sender leaves', true);

} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nALL END-TO-END TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
