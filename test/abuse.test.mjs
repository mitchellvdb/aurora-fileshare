// Terms, contact address and closing a reported share.
//
// The contact address is a legal point of contact, so it must be on every
// page when configured and leave no placeholder behind when not. The close
// command must end both sides of a share - and must be reachable only from
// the machine itself, never through the public port the tunnel forwards.
import { spawn, execFile } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
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

async function withServer(env, fn) {
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, ADMIN_PORT: '0', PUBLIC_URL: 'https://fileshare.aurorahosting.nl',
           ...env, PORT: String(port), HOST: '0.0.0.0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { log: '' };
  child.stdout.on('data', (d) => { out.log += d.toString(); });
  child.stderr.on('data', (d) => { out.log += d.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return await fn(origin, out);
  } finally {
    child.kill('SIGTERM');
  }
}

const PAGES = ['/', '/faq', '/terms', '/send-large-files', '/send-50gb-file',
  '/what-free-means', '/d/swift-otter-100'];
const get = async (origin, p) => (await fetch(origin + p)).text();
const EMAIL = 'abuse@aurorahosting.nl';

function wsOpen(origin) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws');
    ws.once('open', () => res(ws));
    ws.once('error', rej);
  });
}
function next(ws) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout waiting for message')), 3000);
    ws.once('message', (raw) => { clearTimeout(timer); res(JSON.parse(raw.toString())); });
  });
}
const AUTH = randomBytes(32);
const auth = AUTH.toString('base64url');
const verifier = createHash('sha256').update(AUTH).digest('base64url');
const SEALED = randomBytes(64).toString('base64url');
async function host(origin) {
  const up = await wsOpen(origin);
  up.send(JSON.stringify({ t: 'host', files: [{ id: 'f1', size: 1 }], sealed: SEALED, verifier }));
  return { up, slug: (await next(up)).slug };
}
function closeCmd(arg, adminPort) {
  return new Promise((resolve) => {
    execFile(join(ROOT, 'deploy/fileshare-close'), [arg], { env: { ...process.env, ADMIN_PORT: String(adminPort) } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}
function canConnect(hostAddr, port) {
  return new Promise((resolve) => {
    const s = connect({ host: hostAddr, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

// --- Configured -------------------------------------------------------------
const adminPort = await freePort();
await withServer({ CONTACT_EMAIL: EMAIL, ADMIN_PORT: String(adminPort) }, async (origin, out) => {
  const noContact = [];
  const noTerms = [];
  for (const p of PAGES) {
    const h = await get(origin, p);
    if (!h.includes(`<a href="mailto:${EMAIL}">Contact</a>`)) noContact.push(p);
    if (!h.includes('<a href="/terms">Terms</a>')) noTerms.push(p);
  }
  check('every footer has the contact link', noContact.length === 0, noContact.join(', '));
  check('every footer links to the terms', noTerms.length === 0, noTerms.join(', '));

  const terms = await fetch(`${origin}/terms`);
  const termsHtml = await terms.text();
  check('/terms is served', terms.status === 200, String(terms.status));
  check('the terms name the address', termsHtml.includes(`<a href="mailto:${EMAIL}">${EMAIL}</a>`));
  check('the terms have their own title', termsHtml.includes('<title>Terms of use'));

  const faq = await get(origin, '/faq');
  check('the FAQ answers how to report misuse',
    faq.includes('How do I report misuse?') && faq.includes(`mailto:${EMAIL}`));
  const ld = faq.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
  check('the FAQ structured data has the new answer, with the address',
    ld.includes('How do I report misuse?') && ld.includes(EMAIL));
  check('no placeholder survives anywhere', !/<!--contact-/.test(faq + termsHtml));

  const sitemap = await get(origin, '/sitemap.xml');
  check('the terms are in the sitemap', sitemap.includes('/terms'));

  // Close a share with both ends connected, using the real command and the
  // link as someone would paste it.
  const { up, slug } = await host(origin);
  const down = await wsOpen(origin);
  down.send(JSON.stringify({ t: 'join', slug, auth }));
  await next(down);
  await next(up); // peer-join
  const upClosed = next(up);
  const downClosed = next(down);
  const r = await closeCmd(`https://fileshare.aurorahosting.nl/d/${slug}?x=1`, adminPort);
  check('fileshare-close accepts a pasted link', r.code === 0 && r.out.includes(`closed: ${slug}`), r.out.trim());
  const [u, d] = await Promise.all([upClosed, downClosed]);
  check('the sender is told', u.t === 'closed' && /operator/.test(u.reason), JSON.stringify(u));
  check('the recipient is told', d.t === 'closed' && /operator/.test(d.reason), JSON.stringify(d));

  const late = await wsOpen(origin);
  late.send(JSON.stringify({ t: 'join', slug, auth }));
  const gone = await next(late);
  check('the link no longer works', gone.t === 'error' && gone.code === 'not-found', JSON.stringify(gone));

  const again = await closeCmd(slug, adminPort);
  check('closing it twice says there is nothing to close', again.code === 1, again.out.trim());

  await new Promise((res) => setTimeout(res, 100));
  const adminLines = out.log.split('\n').filter((l) => l.includes('[admin]'));
  check('the close is logged once', adminLines.length === 1, adminLines.join(' | '));
  check('the log does not record which share', !adminLines.some((l) => l.includes(slug)));

  // The public port must not offer the command.
  const other = await host(origin);
  const pub = await fetch(`${origin}/close/${other.slug}`, { method: 'POST' });
  const probe = await wsOpen(origin);
  probe.send(JSON.stringify({ t: 'join', slug: other.slug, auth }));
  const stillThere = await next(probe);
  check('the public port cannot close a share',
    pub.status === 404 && stillThere.t === 'joined', `${pub.status} ${stillThere.t}`);

  // The admin listener is on loopback only, even though HOST is 0.0.0.0.
  const lan = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lan) {
    check('the public port answers on the LAN address', await canConnect(lan, Number(new URL(origin).port)));
    check('the admin port does not answer on the LAN address', !(await canConnect(lan, adminPort)), lan);
  } else {
    console.log('SKIP  no non-loopback address to probe from');
  }
  check('the admin port does answer on loopback', await canConnect('127.0.0.1', adminPort));

  for (const ws of [up, down, late, other.up, probe]) ws.close();
});

// --- Not configured ---------------------------------------------------------
await withServer({ CONTACT_EMAIL: '' }, async (origin, out) => {
  let all = '';
  for (const p of PAGES) all += await get(origin, p);
  check('unset: no mailto anywhere', !all.includes('mailto:'));
  check('unset: no placeholder left behind', !all.includes('<!--contact-'));
  check('unset: the terms still lead somewhere',
    (await get(origin, '/terms')).includes('to\n      <a href="https://aurorahosting.nl">Aurora Hosting</a>'));
  check('unset: the startup log says so', out.log.includes('CONTACT_EMAIL unset'));
});

// --- Misconfigured ----------------------------------------------------------
await withServer({ CONTACT_EMAIL: 'javascript:alert(1)' }, async (origin, out) => {
  const h = await get(origin, '/terms');
  check('a malformed address is ignored', !h.includes('javascript:') && !h.includes('mailto:'));
  check('and the log says why', out.log.includes('does not look like an address'));
});

console.log(failures === 0 ? '\nALL ABUSE/TERMS TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
