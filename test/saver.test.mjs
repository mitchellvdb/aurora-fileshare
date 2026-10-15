// The service worker that streams downloads to disk.
//
// Chrome stops a service worker it considers idle. A download it was serving
// then just ends - seen in practice as a 3 GB file "finished" in Chrome's
// download bar at about 600 MB - while the page, writing into a stream nobody
// reads any more, used to wait forever and pile the rest of the file up in
// memory. Two things are checked here: the page keeps the worker busy while it
// writes, and if the worker goes anyway the page says so promptly and stops.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const ORIGIN = process.env.TEST_ORIGIN ?? 'http://127.0.0.1:8080';
const TMP = new URL('./.tmp/saver/', import.meta.url).pathname;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP + 'dl', { recursive: true });
const MB = 1024 * 1024;
let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

async function transfer(name, size) {
  writeFileSync(TMP + name, Buffer.alloc(size, 9));
  const sender = await browser.newPage();
  await sender.evaluateOnNewDocument(() => {
    window.__cancels = 0;
    const add = RTCDataChannel.prototype.addEventListener;
    RTCDataChannel.prototype.addEventListener = function (type, fn, ...rest) {
      if (type === 'message') {
        const wrapped = (ev) => { if (typeof ev.data === 'string' && ev.data.includes('"cancel"')) window.__cancels++; return fn(ev); };
        return add.call(this, type, wrapped, ...rest);
      }
      return add.call(this, type, fn, ...rest);
    };
  });
  await sender.goto(ORIGIN, { waitUntil: 'networkidle0' });
  await (await sender.$('#file-input')).uploadFile(TMP + name);
  await sender.evaluate(() => document.querySelector('#start-share').click());
  await sender.waitForFunction(() => document.querySelector('#share-url')?.value?.startsWith('http'));
  const recipient = await browser.newPage();
  await recipient.evaluateOnNewDocument(() => {
    window.__pongs = [];
    navigator.serviceWorker?.addEventListener('message', (ev) => {
      if (ev.data?.type === 'pong' && ev.data.id) window.__pongs.push(ev.data.alive);
    });
  });
  const cdp = await recipient.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: TMP + 'dl' });
  await recipient.goto(await sender.$eval('#share-url', (e) => e.value), { waitUntil: 'networkidle0' });
  await recipient.waitForFunction(() => !document.querySelector('button.download')?.disabled);
  await recipient.evaluate(() => document.querySelector('#file-list button.download').click());
  return { sender, recipient };
}
const status = (p) => p.$eval('#file-list .file-status', (e) => e.textContent);

try {
  // --- 1. While writing, the page keeps the worker busy ----------------------
  {
    const { sender, recipient } = await transfer('alive.bin', 400 * MB);
    const done = await recipient.waitForFunction(
      () => document.querySelector('#file-list .file-status')?.textContent === 'Complete',
      { timeout: 180000, polling: 250 }).then(() => true, () => false);
    const pongs = await recipient.evaluate(() => window.__pongs);
    check('a long download completes', done, await status(recipient));
    check('the worker was pinged and answered while it streamed',
      pongs.length >= 2 && pongs.every(Boolean), `${pongs.length} answers`);
    await sender.close(); await recipient.close();
  }

  // --- 2. If the worker is stopped anyway, the page says so and stops ----------
  {
    const { sender, recipient } = await transfer('stopped.bin', 1200 * MB);
    await recipient.waitForFunction(
      () => parseFloat(document.querySelector('#file-list .file-status')?.textContent ?? '') >= 3,
      { timeout: 60000, polling: 100 });
    // What Chrome does to a worker it thinks is idle.
    const cdp = await browser.target().createCDPSession();
    const workers = (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'service_worker');
    for (const w of workers) await cdp.send('Target.closeTarget', { targetId: w.targetId });
    const t0 = Date.now();
    const failed = await recipient.waitForFunction(
      () => /^Failed:/.test(document.querySelector('#file-list .file-status')?.textContent ?? ''),
      { timeout: 60000, polling: 250 }).then(() => true, () => false);
    const secs = (Date.now() - t0) / 1000;
    const text = await status(recipient);
    check('a stopped worker is noticed instead of hanging', failed && secs < 45, `${secs.toFixed(0)}s: ${text}`);
    check('the message says what happened', /stopped saving this file/.test(text), text);
    const cancels = await sender.waitForFunction(() => window.__cancels > 0, { timeout: 10000 })
      .then(() => true, () => false);
    check('the sender is told to stop uploading', cancels);
    await sender.close(); await recipient.close();
  }
} finally {
  await browser.close();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL SAVER TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
