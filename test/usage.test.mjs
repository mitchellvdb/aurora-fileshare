// Usage counts exist to answer "is anyone using this?" and must not become a
// record of who, what or when.
//
// So besides checking that the numbers add up, this asserts the properties the
// FAQ promises: nothing is logged at the moment of a share, today's running
// count is not exposed, and the one line that is written carries no address,
// share link or file name.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { createHash, randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const child = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d.toString(); });
child.stderr.on('data', (d) => { log += d.toString(); });

const ORIGIN = `http://127.0.0.1:${port}`;
const WS = ORIGIN.replace(/^http/, 'ws') + '/ws';

const open = () => new Promise((res, rej) => {
  const ws = new WebSocket(WS);
  ws.once('open', () => res(ws));
  ws.once('error', rej);
});
const next = (ws) => new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error('timeout waiting for message')), 3000);
  ws.once('message', (raw) => { clearTimeout(timer); res(JSON.parse(raw.toString())); });
});

const FILE_NAME = 'very-private-tax-return.pdf';
// The server only ever sees ids and sizes; the name travels sealed. It still
// goes into the sealed blob here, so the no-leak check below means something.
const files = [{ id: 'f1', size: 987654 }];
const SEALED = Buffer.from(JSON.stringify([{ id: 'f1', name: FILE_NAME }])).toString('base64url');
const AUTH = randomBytes(32);
const auth = AUTH.toString('base64url');
const verifier = createHash('sha256').update(AUTH).digest('base64url');
const slugs = [];
const sockets = [];

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${ORIGIN}/healthz`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }

  // Two shares; the first is received twice, the second once. A failed join
  // must not count as a receive.
  for (let i = 0; i < 2; i++) {
    const up = await open();
    sockets.push(up);
    up.send(JSON.stringify({ t: 'host', files, sealed: SEALED, verifier }));
    slugs.push((await next(up)).slug);
  }
  for (const slug of [slugs[0], slugs[0], slugs[1], 'swift-otter-999']) {
    const down = await open();
    sockets.push(down);
    down.send(JSON.stringify({ t: 'join', slug, auth }));
    await next(down);
  }
  await new Promise((r) => setTimeout(r, 200));

  check('nothing is logged at the moment of a share or receive',
    !log.includes('[usage]'), log.split('\n').find((l) => l.includes('[usage]')) ?? '');

  const health = await (await fetch(`${ORIGIN}/healthz`)).json();
  check('/healthz has a usage list', Array.isArray(health.usage), JSON.stringify(health.usage));
  check('/healthz does not expose today\'s running count',
    !health.usage.some((d) => d.date === new Date().toISOString().slice(0, 10)),
    JSON.stringify(health.usage));

  // A restart writes the partial day, so that is the line to inspect.
  for (const ws of sockets) ws.close();
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));

  const lines = log.split('\n').filter((l) => l.includes('[usage]'));
  check('shutdown writes exactly one usage line', lines.length === 1, lines.join(' | '));
  check('it counts 2 shares and 3 receives',
    /: 2 shares, 3 receives \(partial, until restart\)$/.test(lines[0] ?? ''), lines[0]);

  const ipLike = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b(?:[0-9a-f]{0,4}:){3,}[0-9a-f]{0,4}\b/i;
  check('the usage line contains no address', !lines.some((l) => ipLike.test(l)), lines.join(' | '));
  check('the usage line contains no share link',
    !lines.some((l) => slugs.some((s) => l.includes(s))), lines.join(' | '));
  check('the usage line contains no file name or size',
    !lines.some((l) => l.includes(FILE_NAME) || l.includes('987654')), lines.join(' | '));
} finally {
  child.kill('SIGTERM');
}

// --- Day roll-over, with a clock we control ---------------------------------
{
  const RealDate = Date;
  let fake = RealDate.parse('2026-09-24T23:59:00Z');
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fake])); }
    static now() { return fake; }
  };

  const logged = [];
  const realLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  const usage = await import(pathToFileURL(join(ROOT, 'dist/server/usage.js')).href);

  usage.recordShare();
  usage.recordReceive();
  usage.recordReceive();
  const sameDay = usage.usageSummary();
  fake = RealDate.parse('2026-09-25T00:01:00Z');
  const nextDay = usage.usageSummary();
  usage.recordShare();

  console.log = realLog;
  globalThis.Date = RealDate;

  check('an unfinished day is not reported', sameDay.length === 0, JSON.stringify(sameDay));
  check('a finished day is reported with its totals',
    nextDay.length === 1 && nextDay[0].date === '2026-09-24'
      && nextDay[0].shares === 1 && nextDay[0].receives === 2,
    JSON.stringify(nextDay));
  check('the finished day is logged once, after midnight',
    logged.length === 1 && logged[0] === '[usage] 2026-09-24: 1 shares, 2 receives',
    logged.join(' | '));
}

console.log(failures === 0 ? '\nALL USAGE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
