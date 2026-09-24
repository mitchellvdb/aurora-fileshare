// Limits on guessing, from the outside.
//
// Every link carries a 128-bit secret, so guessing one is hopeless on paper.
// These limits make sure it is not even cheap to try: a connection is dropped
// after a handful of misses, an address is cut off after a few more, and a
// share closes itself when someone keeps getting its password wrong. And the
// public health check no longer says how many shares are live - to someone
// guessing, that number says when guessing pays.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

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

async function withServer(env, fn) {
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, ADMIN_PORT: '0', ...env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return await fn(origin);
  } finally {
    child.kill('SIGTERM');
  }
}

function tokens() {
  const auth = randomBytes(32);
  return {
    auth: auth.toString('base64url'),
    verifier: createHash('sha256').update(auth).digest('base64url'),
  };
}
const SEALED = randomBytes(96).toString('base64url');

const wsOpen = (origin) => new Promise((res, rej) => {
  const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws');
  ws.once('open', () => res(ws));
  ws.once('error', rej);
});
const next = (ws) => new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error('timeout waiting for message')), 3000);
  ws.once('message', (raw) => { clearTimeout(timer); res(JSON.parse(raw.toString())); });
});
const closedSoon = (ws) => new Promise((res) => {
  if (ws.readyState === WebSocket.CLOSED) return res(true);
  const timer = setTimeout(() => res(false), 2000);
  ws.once('close', () => { clearTimeout(timer); res(true); });
});
async function host(origin, tk, extra = {}) {
  const up = await wsOpen(origin);
  up.send(JSON.stringify({ t: 'host', files: [{ id: 'f', size: 1 }], sealed: SEALED, verifier: tk.verifier, ...extra }));
  return { up, slug: (await next(up)).slug };
}
const tryJoin = async (ws, slug, auth, extra = {}) => {
  ws.send(JSON.stringify({ t: 'join', slug, auth, ...extra }));
  return next(ws);
};

// --- One connection cannot loop through guesses ------------------------------
await withServer({ JOIN_FAIL_LIMIT: '1000' }, async (origin) => {
  const tk = tokens();
  const { up, slug } = await host(origin, tk);
  const ws = await wsOpen(origin);
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push((await tryJoin(ws, `swift-otter-${100 + i}`, tk.auth)).code);
  check('the first five misses are answered normally', answers.every((c) => c === 'not-found'), answers.join(','));
  const sixth = await tryJoin(ws, slug, tk.auth);
  check('the sixth attempt is refused, even with the right link', sixth.code === 'rate-limited', JSON.stringify(sixth));
  check('and the connection is dropped', await closedSoon(ws));

  const fresh = await wsOpen(origin);
  check('a fresh connection with the real link still gets in', (await tryJoin(fresh, slug, tk.auth)).t === 'joined');
  up.close(); fresh.close();
});

// --- New connections do not reset the count for an address -------------------
await withServer({ JOIN_FAIL_LIMIT: '8' }, async (origin) => {
  const tk = tokens();
  const { up, slug } = await host(origin, tk);
  let misses = 0;
  for (let c = 0; c < 2; c++) {
    const ws = await wsOpen(origin);
    for (let i = 0; i < 4; i++) {
      if ((await tryJoin(ws, `lucky-fox-${200 + c * 10 + i}`, tk.auth)).code === 'not-found') misses++;
    }
    ws.close();
  }
  check('eight misses spread over two connections are answered', misses === 8, String(misses));
  const ws = await wsOpen(origin);
  const blocked = await tryJoin(ws, slug, tk.auth);
  check('the address is then cut off, whatever it asks for', blocked.code === 'rate-limited', JSON.stringify(blocked));
  up.close(); ws.close();
});

// --- A share closes itself after ten wrong passwords -------------------------
await withServer({ JOIN_FAIL_LIMIT: '1000' }, async (origin) => {
  const tk = tokens();
  const { up, slug } = await host(origin, tk, { password: 'correct horse' });
  const upClosed = new Promise((res) => {
    up.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.t === 'closed') res(m); });
  });
  const codes = [];
  // Four per connection, to stay under the per-connection cap.
  for (let c = 0; c < 3; c++) {
    const ws = await wsOpen(origin);
    for (let i = 0; i < 4 && codes.length < 10; i++) {
      codes.push((await tryJoin(ws, slug, tk.auth, { password: `guess ${codes.length}` })).code);
    }
    ws.close();
  }
  check('nine wrong passwords are refused one by one',
    codes.slice(0, 9).every((c) => c === 'bad-password'), codes.join(','));
  check('the tenth closes the share', codes[9] === 'locked', codes[9]);
  const m = await Promise.race([upClosed, new Promise((r) => setTimeout(() => r(null), 2000))]);
  check('the sender is told why', m && /wrong password/.test(m.reason), JSON.stringify(m));

  const late = await wsOpen(origin);
  const after = await tryJoin(late, slug, tk.auth, { password: 'correct horse' });
  check('even the right password is too late now', after.code === 'not-found', JSON.stringify(after));
  late.close();
});

// --- The live-share count moved off the public port ---------------------------
const adminPort = await freePort();
await withServer({ ADMIN_PORT: String(adminPort) }, async (origin) => {
  const tk = tokens();
  const { up } = await host(origin, tk);
  const health = await (await fetch(`${origin}/healthz`)).json();
  check('/healthz no longer says how many shares are live', !('channels' in health), JSON.stringify(Object.keys(health)));
  check('/healthz still says it is up', health.ok === true && typeof health.uptime === 'number');
  const status = await (await fetch(`http://127.0.0.1:${adminPort}/status`)).json();
  check('the operator port does', status.channels === 1, JSON.stringify(status));
  up.close();
});

console.log(failures === 0 ? '\nALL SECURITY TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
