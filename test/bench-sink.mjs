/**
 * Receive-path microbenchmark. Not part of the suite.
 *
 * WebRTC is out of the picture here: this pushes bytes straight into the same
 * sinks the downloader uses and times them, so we can see what the save path
 * costs on its own. Three variants:
 *
 *   discard  - write into a stream nobody transfers. The ceiling: what the
 *              stream machinery alone can do.
 *   sw       - the real path. Transfer the readable half to the service worker
 *              and let the browser write it to disk via a download.
 *   blob     - the fallback path, buffering everything in memory.
 *
 * The gap between "discard" and "sw" is what the service worker hop costs.
 *
 *   node test/bench-sink.mjs [payloadMB]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const MB = Number(process.argv[2] ?? 256);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DL = join(HERE, '.tmp/bench-dl');
rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

const port = await new Promise((res, rej) => {
  const p = createServer();
  p.on('error', rej);
  p.listen(0, '127.0.0.1', () => { const { port } = p.address(); p.close(() => res(port)); });
});
const ORIGIN = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
});
for (let i = 0; i < 50; i++) {
  try { await fetch(`${ORIGIN}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const context = browser.defaultBrowserContext();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', String(e)));
  // Downloads are a browser-wide setting unless scoped to this context.
  await browser.target().createCDPSession().then((s) => s.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: DL, browserContextId: context.id,
  }));

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => {
        const t = setTimeout(r, 5000);
        navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); r(); }, { once: true });
      });
    }
  });

  const results = await page.evaluate(async (payloadMB) => {
    const CHUNK = 256 * 1024;
    const TOTAL = payloadMB * 1024 * 1024;
    const COUNT = Math.floor(TOTAL / CHUNK);
    const HIGH = 8 * 1024 * 1024;
    const source = new Uint8Array(CHUNK);
    crypto.getRandomValues(source.subarray(0, 4096));

    const strategy = () => new ByteLengthQueuingStrategy({ highWaterMark: HIGH });

    /** Feeds COUNT chunks into a writer and times it. */
    async function pump(writer) {
      const t0 = performance.now();
      for (let i = 0; i < COUNT; i++) await writer.write(new Uint8Array(source));
      await writer.close();
      return (performance.now() - t0) / 1000;
    }

    async function discard() {
      const { readable, writable } = new TransformStream(undefined, strategy(), strategy());
      const drain = readable.pipeTo(new WritableStream({ write() {} }));
      const secs = await pump(writable.getWriter());
      await drain;
      return secs;
    }

    async function viaServiceWorker() {
      const id = crypto.randomUUID();
      const { readable, writable } = new TransformStream(undefined, strategy(), strategy());
      const ack = new Promise((r) => {
        const on = (ev) => {
          if (ev.data?.type === 'registered' && ev.data.id === id) {
            navigator.serviceWorker.removeEventListener('message', on); r();
          }
        };
        navigator.serviceWorker.addEventListener('message', on);
      });
      navigator.serviceWorker.controller.postMessage(
        { type: 'register', id, name: 'bench.bin', size: TOTAL, mime: 'application/octet-stream', stream: readable },
        [readable],
      );
      await ack;
      const frame = document.createElement('iframe');
      frame.hidden = true;
      document.body.append(frame);
      frame.src = `/dl/${id}`;
      return await pump(writable.getWriter());
    }

    async function blob() {
      const parts = [];
      const t0 = performance.now();
      for (let i = 0; i < COUNT; i++) parts.push(new Uint8Array(source).buffer);
      const b = new Blob(parts);
      await b.slice(0, 1).arrayBuffer();
      return (performance.now() - t0) / 1000;
    }

    const rate = (s) => +(TOTAL / s / (1024 * 1024)).toFixed(1);
    const out = [];
    out.push({ label: 'discard (stream machinery only)', secs: +(await discard()).toFixed(2) });
    out.push({ label: 'service worker -> disk (real path)', secs: +(await viaServiceWorker()).toFixed(2) });
    out.push({ label: 'blob (in-memory fallback)', secs: +(await blob()).toFixed(2) });
    return out.map((r) => ({ ...r, mbps: rate(r.secs) }));
  }, MB);

  console.log(`\nReceive path, ${MB} MB of 256 KiB chunks, no WebRTC involved\n`);
  console.log('  sink                                  time        rate');
  console.log('  ' + '-'.repeat(52));
  for (const r of results) {
    console.log(`  ${r.label.padEnd(36)} ${String(r.secs + 's').padStart(6)}  ${String(r.mbps + ' MB/s').padStart(10)}`);
  }
  console.log();
} finally {
  await browser.close();
  server.kill();
}
