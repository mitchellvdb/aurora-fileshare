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
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = process.env.TEST_PORT ?? '8080';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';

const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CHROME_PATH: CHROME };

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
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
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
  if (!await waitForServer()) {
    console.error('Server did not come up:\n' + serverLog.join(''));
    process.exit(1);
  }

  const hasChrome = existsSync(CHROME);
  const files = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort();

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
