// The donate button is configured entirely by environment, so each case needs
// its own server. These spawn their own instances rather than using the shared
// one the runner starts.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

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

/** Boots a server with the given env and hands the origin to `fn`. */
async function withServer(env, fn) {
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const origin = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${origin}/healthz`)).ok) { up = true; break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!up) throw new Error('server did not start: ' + logs.join(''));
    return await fn(origin, logs);
  } finally {
    child.kill('SIGTERM');
  }
}

const html = async (origin, path = '/') => (await fetch(origin + path)).text();

// --- 1. Unset: nothing rendered, no dead link -------------------------------
await withServer({ DONATE_URL: '' }, async (origin) => {
  const page = await html(origin);
  check('unset: no donate meta tag', !page.includes('aurora-donate-url'));
  const dl = await html(origin, '/d/swift-otter-100');
  check('unset: download page has none either', !dl.includes('aurora-donate-url'));
});

// --- 2. Configured: injected into both pages --------------------------------
await withServer({
  DONATE_URL: 'https://paypal.me/example',
  DONATE_LABEL: 'Buy me a coffee',
}, async (origin) => {
  const page = await html(origin);
  check('set: meta url present on the upload page',
    page.includes('name="aurora-donate-url" content="https://paypal.me/example"'));
  check('set: label present', page.includes('content="Buy me a coffee"'));
  const dl = await html(origin, '/d/swift-otter-100');
  check('set: present on the download page too', dl.includes('aurora-donate-url'));
});

// --- 3. Dangerous URLs are refused ------------------------------------------
for (const [label, url] of [
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:text/html,<script>alert(1)</script>'],
  ['garbage', 'not a url at all'],
]) {
  await withServer({ DONATE_URL: url }, async (origin) => {
    const page = await html(origin);
    check(`rejects ${label} URL`, !page.includes('aurora-donate-url'));
  });
}

// --- 4. A hostile label cannot break out of the attribute -------------------
await withServer({
  DONATE_URL: 'https://example.com/tip',
  DONATE_LABEL: '"><script>alert(1)</script>',
}, async (origin) => {
  const page = await html(origin);
  check('label is escaped, no raw script tag injected',
    !page.includes('<script>alert(1)</script>'));
  check('label is escaped, quotes encoded', page.includes('&quot;&gt;&lt;script&gt;'));
});

// --- 5. It actually renders, and safely -------------------------------------
await withServer({
  DONATE_URL: 'https://paypal.me/example',
  DONATE_LABEL: 'Buy me a coffee',
}, async (origin) => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    for (const [name, path] of [['upload', '/'], ['download', '/d/swift-otter-100']]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(origin + path, { waitUntil: 'networkidle0' });

      const link = await page.evaluate(() => {
        const a = document.querySelector('#donate-slot a.donate');
        if (!a) return null;
        return {
          href: a.href,
          text: a.textContent.trim(),
          target: a.target,
          rel: a.rel,
          visible: !a.closest('[hidden]'),
          hasIcon: !!a.querySelector('svg'),
        };
      });

      check(`${name}: button rendered`, link !== null);
      if (link) {
        check(`${name}: correct href`, link.href === 'https://paypal.me/example', link.href);
        check(`${name}: shows the label`, link.text === 'Buy me a coffee', link.text);
        check(`${name}: opens in a new tab`, link.target === '_blank');
        check(`${name}: rel blocks opener and referrer`,
          link.rel.includes('noopener') && link.rel.includes('noreferrer'), link.rel);
        check(`${name}: slot is revealed`, link.visible);
        check(`${name}: inline svg icon, no external image`, link.hasIcon);
      }
      check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
      await page.close();
    }

    // With the button off, nothing should be left behind in the DOM.
    await withServer({ DONATE_URL: '' }, async (plainOrigin) => {
      const page = await browser.newPage();
      await page.goto(plainOrigin, { waitUntil: 'networkidle0' });
      const present = await page.evaluate(() =>
        !!document.querySelector('#donate-slot a.donate'));
      const slotHidden = await page.evaluate(() =>
        document.querySelector('#donate-slot')?.hidden ?? false);
      check('unset: no link in the DOM', !present);
      check('unset: slot stays hidden', slotHidden);
      await page.close();
    });
  } finally {
    await browser.close();
  }
});

console.log(failures === 0 ? '\nALL DONATE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
