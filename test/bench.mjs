/**
 * Send-path microbenchmark. Not part of the suite (no .test.mjs suffix).
 *
 * Wires two RTCPeerConnections together inside one page and pushes a Blob down
 * the channel, comparing the old serialised-read/64 KiB strategy against the
 * pipelined-read/256 KiB one. The receiver only counts bytes, so this measures
 * the sender and the data channel and nothing else - no disk write, no service
 * worker, and only one browser process instead of two.
 *
 *   node test/bench.mjs [payloadMB]
 */
import puppeteer from 'puppeteer-core';

const MB = Number(process.argv[2] ?? 96);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR', String(e)));
await page.goto('about:blank');

const results = await page.evaluate(async (payloadMB) => {
  const SIZE = payloadMB * 1024 * 1024;
  const HIGH = 8 * 1024 * 1024;
  const LOW = 2 * 1024 * 1024;

  // One buffer reused as the file body; sliced like a real File would be.
  const body = new Uint8Array(SIZE);
  crypto.getRandomValues(body.subarray(0, 65536));
  for (let i = 65536; i < SIZE; i += 65536) body.copyWithin(i, 0, Math.min(65536, SIZE - i));
  const blob = new Blob([body]);

  async function connect() {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const dc = a.createDataChannel('bench', { ordered: true });
    dc.binaryType = 'arraybuffer';
    const remote = new Promise((r) => { b.ondatachannel = (e) => { e.channel.binaryType = 'arraybuffer'; r(e.channel); }; });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    const rx = await remote;
    if (dc.readyState !== 'open') await new Promise((r) => (dc.onopen = r));
    return { a, b, dc, rx, maxMessage: a.sctp?.maxMessageSize ?? 0 };
  }

  function drain(dc) {
    return new Promise((r) => {
      const done = () => { dc.removeEventListener('bufferedamountlow', done); r(); };
      dc.addEventListener('bufferedamountlow', done);
    });
  }

  /** Counts bytes on the receiving side and resolves when all have landed. */
  function sink(rx, total) {
    let got = 0;
    let minBuffered = Infinity;
    return {
      done: new Promise((r) => {
        rx.addEventListener('message', (ev) => {
          got += ev.data.byteLength;
          if (got >= total) r();
        });
      }),
      sampled: () => minBuffered,
    };
  }

  /** Old strategy: one disk read per message, fully serialised. */
  async function serialised(dc, chunkSize) {
    let offset = 0;
    let starved = 0, samples = 0;
    while (offset < SIZE) {
      if (dc.bufferedAmount > HIGH) await drain(dc);
      const chunk = await blob.slice(offset, offset + chunkSize).arrayBuffer();
      samples++; if (dc.bufferedAmount < chunkSize * 2) starved++;
      dc.send(chunk);
      offset += chunk.byteLength;
    }
    return { starved, samples };
  }

  /** New strategy: 4 MiB block reads, next read already in flight. */
  async function pipelined(dc, chunkSize) {
    const BLOCK = 4 * 1024 * 1024;
    const read = (start) => blob.slice(start, Math.min(start + BLOCK, SIZE)).arrayBuffer();
    let offset = 0, starved = 0, samples = 0;
    let inFlight = read(0);
    while (inFlight) {
      const block = new Uint8Array(await inFlight);
      const base = offset;
      const next = base + block.byteLength;
      inFlight = next < SIZE ? read(next) : null;
      for (let p = 0; p < block.byteLength; p += chunkSize) {
        if (dc.bufferedAmount > HIGH) await drain(dc);
        const end = Math.min(p + chunkSize, block.byteLength);
        samples++; if (dc.bufferedAmount < chunkSize * 2) starved++;
        dc.send(block.subarray(p, end));
        offset = base + end;
      }
    }
    return { starved, samples };
  }

  async function run(label, strategy, chunkSize) {
    const { a, b, dc, rx, maxMessage } = await connect();
    dc.bufferedAmountLowThreshold = LOW;
    const s = sink(rx, SIZE);
    const t0 = performance.now();
    const stats = await strategy(dc, chunkSize);
    await s.done;
    const secs = (performance.now() - t0) / 1000;
    a.close(); b.close();
    return {
      label, secs: +secs.toFixed(2),
      mbps: +(SIZE / secs / (1024 * 1024)).toFixed(1),
      starvedPct: Math.round((stats.starved / stats.samples) * 100),
      maxMessage,
    };
  }

  const out = [];
  out.push(await run('old: serialised read, 64 KiB', serialised, 64 * 1024));
  out.push(await run('new: pipelined read, 64 KiB', pipelined, 64 * 1024));
  out.push(await run('old: serialised read, 256 KiB', serialised, 256 * 1024));
  out.push(await run('new: pipelined read, 256 KiB', pipelined, 256 * 1024));
  return out;
}, MB);

console.log(`\nSend path, ${MB} MB, loopback in one page (no disk write, no service worker)\n`);
console.log('  strategy                        time     rate    send buffer starved');
console.log('  ' + '-'.repeat(66));
for (const r of results) {
  console.log(`  ${r.label.padEnd(30)} ${String(r.secs + 's').padStart(6)}  ${String(r.mbps + ' MB/s').padStart(10)}   ${String(r.starvedPct + '%').padStart(6)}`);
}
console.log(`\n  negotiated max message size: ${results[0].maxMessage} bytes\n`);

await browser.close();
