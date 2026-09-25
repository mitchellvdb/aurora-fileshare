// Transfers that survive a dropped connection.
//
// A drop is forced at an exact byte: the sender's RTCDataChannel.send is
// wrapped so that, once a set number of bytes has gone out, the sender's
// peer connection is closed - the moment a flaky network would have cut it.
// The download must still finish byte-identical, and the sender must not have
// sent the file again from the start: the total it sent is the proof that the
// transfer resumed rather than restarted: after the cut, exactly the bytes
// from the resume point onwards are sent, not one more.
//
// Also covered: a ZIP of several files, the in-memory save mode used over
// plain HTTP, the server being killed and restarted mid-transfer (which also
// makes deploys harmless to running transfers), and the sender closing its
// tab, which must end the wait at once rather than after ten minutes.
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = new URL('./.tmp/resume/', import.meta.url).pathname;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const MB = 1024 * 1024;
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
let server = null;
async function startServer() {
  server = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', ADMIN_PORT: '0' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
async function killServer() {
  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGKILL');
  await exited;
}

function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

function makeFile(name, size) {
  const data = randomBytes(size);
  const path = `${TMP}${name}`;
  writeFileSync(path, data);
  return { name, path, data, sha: sha256(data) };
}

/**
 * Runs in the sender's page before its scripts. Counts binary bytes sent,
 * and closes the owning peer connection once __dropAt is crossed.
 */
function instrumentSender() {
  window.__sent = 0;
  window.__dropAt = Infinity;
  window.__drops = 0;
  window.__sentAtClose = 0;
  window.__begins = [];
  const create = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    const dc = create.apply(this, args);
    dc.__pc = this;
    return dc;
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    send.call(this, data);
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.t === 'begin') window.__begins.push(msg.from);
      } catch { /* not ours */ }
      return;
    }
    window.__sent += data.byteLength ?? data.size ?? 0;
    if (window.__sent >= window.__dropAt) {
      window.__dropAt = Infinity;
      window.__drops += 1;
      const pc = this.__pc;
      setTimeout(() => { window.__sentAtClose = window.__sent; pc.close(); }, 0);
    }
  };
}

/** Records every status line the recipient page shows. */
function instrumentRecipient() {
  window.__statuses = [];
  document.addEventListener('DOMContentLoaded', () => {
    const box = document.querySelector('#status');
    new MutationObserver(() => window.__statuses.push(box.textContent)).observe(
      box, { childList: true, characterData: true, subtree: true });
  });
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

async function share(origin, files) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(instrumentSender);
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await (await page.$('#file-input')).uploadFile(...files.map((f) => f.path));
  await page.waitForFunction(() => !document.querySelector('#start-share').disabled, { timeout: 5000 });
  await page.click('#start-share');
  await page.waitForFunction(
    () => document.querySelector('#share-url')?.value?.startsWith('http'), { timeout: 10000 });
  return { page, url: await page.$eval('#share-url', (el) => el.value) };
}

async function receive(url, dir) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(instrumentRecipient);
  mkdirSync(dir, { recursive: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => { const b = document.querySelector('#file-list button.download'); return b && !b.disabled; },
    { timeout: 20000 });
  return page;
}

async function landed(dir, size, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const f of readdirSync(dir).filter((n) => !n.endsWith('.crdownload'))) {
      const buf = readFileSync(join(dir, f));
      if (buf.length === size) return { name: f, buf };
    }
    await sleep(200);
  }
  return null;
}

const statuses = (page) => page.evaluate(() => window.__statuses.join(' | '));

/** One file, one forced drop, then: intact, and not sent twice? */
async function singleFileCase(label, origin, size, dropAt) {
  const file = makeFile(`${label}.bin`, size);
  const dir = `${TMP}dl-${label}`;
  const { page: sender, url } = await share(origin, [file]);
  const recipient = await receive(url, dir);
  const mode = await recipient.evaluate(() => (document.querySelector('#mode-note').hidden ? 'stream' : 'blob'));
  await sender.evaluate((n) => { window.__dropAt = n; }, dropAt);

  await recipient.click('#file-list button.download');
  const done = await recipient.waitForFunction(
    () => document.querySelector('#file-list .file-status')?.textContent === 'Complete',
    { timeout: 90000 }).then(() => true, () => false);
  const drops = await sender.evaluate(() => window.__drops);
  const { sent, sentAtClose, begins } = await sender.evaluate(
    () => ({ sent: window.__sent, sentAtClose: window.__sentAtClose, begins: window.__begins }));
  const seen = await statuses(recipient);

  check(`${label}: the connection was cut mid-transfer (${mode} mode)`, drops === 1, `drops=${drops}`);
  check(`${label}: the recipient said it would continue`, /Connection lost at/.test(seen) && /Continuing from/.test(seen),
    seen.slice(0, 200));
  check(`${label}: the download completed`, done);
  const got = await landed(dir, size);
  check(`${label}: the file is byte-identical`, got !== null && sha256(got.buf) === file.sha,
    got ? sha256(got.buf).slice(0, 12) : 'not on disk');
  // Whatever was still in the sender's buffer when the line was cut never
  // arrived, so the recipient asks from what it actually has - and after the
  // cut the sender sends exactly the rest, from there.
  const from = begins[1] ?? 0;
  check(`${label}: it resumed from where the recipient was, not from zero`,
    begins.length === 2 && begins[0] === 0 && from > 0, `begins at ${begins.join(', ')}`);
  check(`${label}: after the cut, exactly the missing bytes were sent`, sent - sentAtClose === size - from,
    `${sent - sentAtClose} sent after the cut, ${size - from} were missing`);
  await sender.close(); await recipient.close();
}

try {
  await startServer();
  const LOCAL = `http://127.0.0.1:${port}`;

  // --- 1. One large file, streamed to disk ------------------------------------
  await singleFileCase('stream', LOCAL, 48 * MB, 20 * MB);

  // --- 2. A ZIP of two files, cut inside the second ------------------------------
  {
    const a = makeFile('first.bin', 16 * MB);
    // Big enough that the cut lands well past the sender's 12 MB send buffer,
    // so part of the second file has certainly arrived when it comes.
    const b = makeFile('second.bin', 24 * MB);
    const dir = `${TMP}dl-zip`;
    const { page: sender, url } = await share(LOCAL, [a, b]);
    const recipient = await receive(url, dir);
    await sender.evaluate((n) => { window.__dropAt = n; }, 36 * MB);
    await recipient.click('#download-all');
    const done = await recipient.waitForFunction(
      () => /Saved aurora-files-.*\.zip/.test(document.querySelector('#status')?.textContent ?? ''),
      { timeout: 90000 }).then(() => true, () => false);
    const drops = await sender.evaluate(() => window.__drops);
    const { sent, sentAtClose, begins } = await sender.evaluate(
      () => ({ sent: window.__sent, sentAtClose: window.__sentAtClose, begins: window.__begins }));
    check('zip: cut inside the second file', drops === 1, `drops=${drops}`);
    check('zip: the archive completed', done, await recipient.$eval('#status', (el) => el.textContent));
    const got = await (async () => {
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        const z = readdirSync(dir).find((n) => n.endsWith('.zip'));
        if (z) {
          try { execFileSync('unzip', ['-t', join(dir, z)], { stdio: 'pipe' }); return join(dir, z); } catch { /* still writing */ }
        }
        await sleep(300);
      }
      return null;
    })();
    check('zip: unzip -t passes', got !== null);
    if (got) {
      const one = execFileSync('unzip', ['-p', got, 'first.bin'], { maxBuffer: 64 * MB });
      const two = execFileSync('unzip', ['-p', got, 'second.bin'], { maxBuffer: 64 * MB });
      check('zip: both files are byte-identical', sha256(one) === a.sha && sha256(two) === b.sha);
    }
    const from = begins[2] ?? 0;
    check('zip: the second file resumed part way, the first was not sent again',
      begins.length === 3 && begins[0] === 0 && begins[1] === 0 && from > 0, `begins at ${begins.join(', ')}`);
    check('zip: after the cut, exactly the missing bytes were sent', sent - sentAtClose === 24 * MB - from,
      `${sent - sentAtClose} sent after the cut, ${24 * MB - from} were missing`);
    await sender.close(); await recipient.close();
  }

  // --- 3. Plain HTTP on the LAN: the in-memory save mode ---------------------
  const lan = lanAddress();
  if (lan) await singleFileCase('blob', `http://${lan}:${port}`, 32 * MB, 20 * MB);
  else console.log('SKIP  no LAN address for the in-memory case');

  // --- 4. The server is killed mid-transfer, and comes back -------------------
  {
    const size = 400 * MB;
    const file = makeFile('big.bin', size);
    const dir = `${TMP}dl-restart`;
    const { page: sender, url } = await share(LOCAL, [file]);
    const recipient = await receive(url, dir);
    await recipient.click('#file-list button.download');
    // Wait until it is properly under way, then pull the server out.
    const until = Date.now() + 20000;
    while (Date.now() < until && (await sender.evaluate(() => window.__sent)) < 40 * MB) await sleep(20);
    const at = await sender.evaluate(() => window.__sent);
    await killServer();
    const killedMid = at < size;
    await sleep(1500);
    await startServer();

    const done = await recipient.waitForFunction(
      () => document.querySelector('#file-list .file-status')?.textContent === 'Complete',
      { timeout: 120000 }).then(() => true, () => false);
    check('restart: the server died mid-transfer', killedMid,
      `killed at ${(at / MB).toFixed(0)} of ${(size / MB).toFixed(0)} MB`);
    check('restart: the transfer still completed', done);
    const got = await landed(dir, size, 60000);
    check('restart: the file is byte-identical', got !== null && sha256(got.buf) === file.sha);
    check('restart: the direct connection never dropped',
      !/Connection lost/.test(await statuses(recipient)));

    // The sender registers the same link again, so a newcomer still gets in.
    const reregistered = await sender.waitForFunction(
      () => document.querySelector('#server-note')?.hidden === true, { timeout: 30000 }).then(() => true, () => false);
    check('restart: the sender registered the share again', reregistered);
    check('restart: under the same link', (await sender.$eval('#share-url', (el) => el.value)) === url);
    const late = await receive(url, `${TMP}dl-late`).then(() => true, () => false);
    check('restart: someone opening the link afterwards still connects', late);
    await sender.close(); await recipient.close();
  }

  // --- 5. The sender closes the tab: stop waiting --------------------------------
  {
    const file = makeFile('bye.bin', 1 * MB);
    const { page: sender, url } = await share(LOCAL, [file]);
    const recipient = await receive(url, `${TMP}dl-bye`);
    const t0 = Date.now();
    await sender.close({ runBeforeUnload: false });
    const told = await recipient.waitForFunction(
      () => /closed their tab/.test(document.querySelector('#status')?.textContent ?? ''),
      { timeout: 15000 }).then(() => true, () => false);
    check('bye: the recipient is told the share ended', told,
      await recipient.$eval('#status', (el) => el.textContent));
    check('bye: within seconds, not after the ten-minute wait', Date.now() - t0 < 15000,
      `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await recipient.close();
  }
} finally {
  await browser.close();
  server?.kill('SIGKILL');
  rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL RESUME TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
