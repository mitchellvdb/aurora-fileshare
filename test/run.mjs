/**
 * Boots the server on a scratch port, runs every *.test.mjs against it, and
 * reports. Browser tests need chromium; set CHROME_PATH to override.
 *
 * A UTF-8 locale is forced for the child processes: chromium falls back to the
 * name "download" for non-ASCII filenames when it runs under LANG=C, which
 * would fail the filename assertions for reasons that have nothing to do with
 * the application.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// Pick a free port rather than a fixed one: if something else already holds
// the port, the spawned server fails to bind and the suite silently tests
// whatever is listening instead - which is worse than failing outright.
const PORT = process.env.TEST_PORT ?? String(await freePort());
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';

const ORIGIN = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  CHROME_PATH: CHROME, TEST_ORIGIN: ORIGIN,
  // The SEO suite needs canonical URLs and a sitemap, and the donate button
  // needs a link, so give the shared server representative values.
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'https://fileshare.aurorahosting.nl',
  DONATE_URL: process.env.DONATE_URL ?? 'https://paypal.me/mvdbosch',
  // Every suite starts servers of its own; they must not fight over the
  // operator port. The suite that tests it picks a free one.
  ADMIN_PORT: process.env.ADMIN_PORT ?? '0',
};

if (!existsSync(join(ROOT, 'dist/server/index.js'))) {
  console.error('Build first: npm run build');
  process.exit(1);
}

const server = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: ROOT, env: { ...env, PORT }, stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${ORIGIN}/healthz`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(HERE, file)], { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code) => resolve(code === 0));
});

let failed = 0;
try {
  console.log(`server: ${ORIGIN}`);
  if (!await waitForServer()) {
    console.error('Server did not come up:\n' + serverLog.join(''));
    process.exit(1);
  }

  const hasChrome = existsSync(CHROME);
  // ONLY=transfer runs a single suite - useful when benchmarking one path.
  const only = process.env.ONLY;
  const files = readdirSync(HERE)
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => !only || f.includes(only))
    .sort();

  for (const file of files) {
    const needsBrowser = file !== 'signaling.test.mjs';
    if (needsBrowser && !hasChrome) {
      console.log(`\n---- ${file} SKIPPED (no chromium at ${CHROME}) ----`);
      continue;
    }
    console.log(`\n---- ${file} ----`);
    if (!await run(file)) failed++;
  }
} finally {
  server.kill('SIGTERM');
}

console.log(failed === 0 ? '\n==> ALL SUITES PASSED' : `\n==> ${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
