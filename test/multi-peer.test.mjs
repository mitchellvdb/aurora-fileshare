// Password gate, multiple files (incl. a non-ASCII name), two simultaneous recipients.
//
// Files are constructed in-page via DataTransfer rather than puppeteer's
// uploadFile: CDP cannot attach paths containing non-ASCII characters, which
// would otherwise silently drop a file we specifically want to test.
import puppeteer from 'puppeteer-core';
import { mkdirSync as _mk } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TMP = new URL('./.tmp/', import.meta.url).pathname;
_mk(TMP, { recursive: true });
const ORIGIN = process.env.TEST_ORIGIN ?? 'http://127.0.0.1:8080';
const PASSWORD = 'correct horse battery staple';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Chromium throttles background tabs, which stalls puppeteer's hit-testing
 *  click. Dispatching through the DOM still runs the page's real handler. */
const domClick = (page, selector) =>
  page.evaluate((s) => document.querySelector(s).click(), selector);

/** Deterministic bytes, reproducible identically in Node and in the browser. */
function patternBytes(seed, size) {
  const out = Buffer.allocUnsafe(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const specs = [
  { name: 'alpha.bin', size: 3 * 1024 * 1024, seed: 11 },
  { name: 'beta-rapport-åäö.bin', size: 1536 * 1024, seed: 22 },
  { name: 'gamma.bin', size: 512 * 1024, seed: 33 },
];
for (const s of specs) s.hash = sha256(patternBytes(s.seed, s.size));

/**
 * Each receiver gets its own browser context. Browser.setDownloadBehavior is
 * browser-wide unless scoped to a context, so without this the two recipients
 * share one download directory and their identically-named files collide.
 * Separate contexts also mean separate storage, which is closer to two real users.
 */
async function newReceiver(browser, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: dir, browserContextId: context.id, eventsEnabled: true,
  });
  return { page, errors, dir, context };
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
         '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

try {
  const sender = await browser.newPage();
  const senderErrors = [];
  sender.on('pageerror', (e) => senderErrors.push(String(e)));
  sender.on('console', (m) => { if (m.type() === 'error') senderErrors.push(m.text()); });

  await sender.goto(ORIGIN, { waitUntil: 'networkidle0' });

  await sender.evaluate((specs) => {
    const dt = new DataTransfer();
    for (const s of specs) {
      const buf = new Uint8Array(s.size);
      let x = s.seed >>> 0;
      for (let i = 0; i < s.size; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        buf[i] = x >>> 24;
      }
      dt.items.add(new File([buf], s.name, { type: 'application/octet-stream' }));
    }
    const input = document.querySelector('#file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, specs.map(({ name, size, seed }) => ({ name, size, seed })));

  await sender.waitForFunction(() => !document.querySelector('#start-share').disabled, { timeout: 10000 });

  const listed = await sender.$$eval('#file-list .file-name', (els) => els.map((e) => e.textContent));
  check('all three files listed', listed.length === 3, listed.join(', '));
  check('non-ASCII filename preserved on the sender',
    listed.includes('beta-rapport-åäö.bin'));

  await sender.type('#password', PASSWORD);
  await domClick(sender, '#start-share');
  await sender.waitForFunction(
    () => document.querySelector('#share-url')?.value?.startsWith('http'), { timeout: 15000 });
  const shareUrl = await sender.$eval('#share-url', (el) => el.value);
  check('password note shown to sender', !(await sender.$eval('#password-note', (el) => el.hidden)));

  // --- Receiver 1: wrong password first ------------------------------------
  const r1 = await newReceiver(browser, `${TMP}/dl1`);
  await r1.page.goto(shareUrl, { waitUntil: 'networkidle0' });
  await r1.page.waitForFunction(() => !document.querySelector('#password-gate').hidden, { timeout: 15000 });
  check('receiver is stopped at the password gate', true);

  await r1.page.type('#password', 'not the password');
  await domClick(r1.page, '#password-form button[type=submit]');
  await r1.page.waitForFunction(() => !document.querySelector('#error').hidden, { timeout: 10000 });
  check('wrong password rejected in the browser',
    /incorrect/i.test(await r1.page.$eval('#error', (el) => el.textContent)));

  await r1.page.$eval('#password', (el) => { el.value = ''; });
  await r1.page.type('#password', PASSWORD);
  await domClick(r1.page, '#password-form button[type=submit]');
  await r1.page.waitForFunction(
    () => { const b = document.querySelector('#file-list button.download'); return b && !b.disabled; },
    { timeout: 30000 });
  check('correct password unlocks and connects', true);

  const received = await r1.page.$$eval('#file-list .file-name', (els) => els.map((e) => e.textContent));
  check('file names survive the trip intact',
    received.join('|') === specs.map((s) => s.name).join('|'), received.join(', '));

  // --- Receiver 2 on the same share ----------------------------------------
  const r2 = await newReceiver(browser, `${TMP}/dl2`);
  await r2.page.goto(shareUrl, { waitUntil: 'networkidle0' });
  await r2.page.waitForFunction(() => !document.querySelector('#password-gate').hidden, { timeout: 15000 });
  await r2.page.type('#password', PASSWORD);
  await domClick(r2.page, '#password-form button[type=submit]');
  await r2.page.waitForFunction(
    () => { const b = document.querySelector('#file-list button.download'); return b && !b.disabled; },
    { timeout: 30000 });
  check('a second recipient connects to the same share', true);

  await sender.waitForFunction(
    () => /2 people have opened/.test(document.querySelector('#recipient-count').textContent),
    { timeout: 10000 });
  check('sender tracks both recipients', true);
  check('sender shows two recipient rows',
    (await sender.$$eval('#recipients .recipient', (r) => r.length)) === 2);

  // --- Both pull all three files at once ------------------------------------
  const started = Date.now();
  await Promise.all([domClick(r1.page, '#download-all'), domClick(r2.page, '#download-all')]);

  let settled = false;
  for (let t = 0; t < 60 && !settled; t++) {
    await new Promise((res) => setTimeout(res, 2000));
    const snap = [];
    for (const r of [r1, r2]) {
      snap.push(await r.page.$eval('#status', (el) => el.textContent));
    }
    settled = snap.every((s) => /^Saved aurora-files-/.test(s));
    if (!settled && t % 5 === 4) {
      console.log(`      t+${t * 2}s  r1="${snap[0]}"  r2="${snap[1]}"`);
    }
  }
  check('both recipients built the archive', settled,
    settled ? '' : 'timed out waiting for both archives');
  console.log(`      (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  // --- Archive integrity ----------------------------------------------------
  for (const r of [r1, r2]) {
    const tag = r.dir.split('/').pop();

    let archive = null;
    for (let i = 0; i < 120; i++) {
      const names = readdirSync(r.dir).filter((f) => f.endsWith('.zip'));
      if (names.length > 0) {
        // Wait for the browser to finish flushing before reading.
        const path = `${r.dir}/${names[0]}`;
        const a = readFileSync(path).length;
        await new Promise((res) => setTimeout(res, 300));
        if (readFileSync(path).length === a && a > 0) { archive = path; break; }
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    check(`${tag}: a .zip landed on disk`, archive !== null, readdirSync(r.dir).join(', '));
    if (!archive) continue;

    let structOk = true, structDetail = '';
    try {
      execFileSync('unzip', ['-t', archive], { stdio: 'pipe' });
    } catch (e) {
      structOk = false;
      structDetail = ((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).trim().split('\n').slice(-1)[0];
    }
    check(`${tag}: unzip -t accepts the archive`, structOk, structDetail);

    let info = null;
    try {
      info = JSON.parse(execFileSync('python3', ['-c', `
import zipfile, hashlib, json, sys
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "names": z.namelist(),
  "hashes": {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}))
`, archive], { stdio: 'pipe' }).toString());
    } catch (e) {
      check(`${tag}: python zipfile opens the archive`, false, (e.stderr?.toString() ?? '').trim());
      continue;
    }
    check(`${tag}: python zipfile opens the archive`, info.bad === null, String(info.bad));
    check(`${tag}: archive holds all three files`,
      specs.every((sp) => info.names.includes(sp.name)), info.names.join(', '));

    const bad = specs.filter((sp) => info.hashes[sp.name] !== sp.hash).map((sp) => sp.name);
    check(`${tag}: every file in the archive matches by sha256`, bad.length === 0, bad.join(', '));
  }

  check('no uncaught errors anywhere',
    senderErrors.length === 0 && r1.errors.length === 0 && r2.errors.length === 0,
    [...senderErrors, ...r1.errors, ...r2.errors].join(' | '));

} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nALL MULTI-PEER TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
