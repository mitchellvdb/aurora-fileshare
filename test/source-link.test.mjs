// AGPL section 13 asks anyone running this over a network to offer its source
// to the people using it. The footer link is how, so it is worth a test: it
// must appear on every page when configured, and must leave no trace when not.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    env: { ...process.env, ...env, PORT: String(port), HOST: '127.0.0.1' },
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

// Every page carries a footer, share pages included.
const PAGES = ['/', '/faq', '/send-large-files', '/send-50gb-file',
  '/what-free-means', '/d/swift-otter-100'];
const get = async (origin, p) => (await fetch(origin + p)).text();

const REPO = 'https://github.com/example/aurora-fileshare';

// --- Configured -------------------------------------------------------------
await withServer({ SOURCE_URL: REPO }, async (origin) => {
  const missing = [];
  for (const p of PAGES) {
    const h = await get(origin, p);
    if (!h.includes(`<a href="${REPO}">Source</a>`)) missing.push(p);
  }
  check('source link renders on every page', missing.length === 0, missing.join(', '));

  const home = await get(origin, '/');
  check('link is in the initial HTML, not added by script',
    home.indexOf('Source</a>') < home.indexOf('</body>'));
  check('no placeholder survives', !home.includes('<!--source-link-->'));

  // The FAQ's self-hosting answer, and the structured data derived from it.
  const faq = await get(origin, '/faq');
  check('faq points at the repository',
    faq.includes(`<a href="${REPO}">source code is public</a>`));

  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(faq)?.[1] ?? '';
  const answers = JSON.parse(ld).mainEntity
    .map((e) => e.acceptedAnswer.text).join(' ');
  check('structured data carries the resolved sentence',
    answers.includes('source code is public') && answers.includes('AGPL'));
  check('structured data has no placeholder or markup',
    !answers.includes('source-sentence') && !answers.includes('<a href'),
    answers.slice(answers.indexOf('source code') - 40, answers.indexOf('source code') + 60));
});

// --- Unset ------------------------------------------------------------------
await withServer({ SOURCE_URL: '' }, async (origin) => {
  const leaked = [];
  for (const p of PAGES) {
    const h = await get(origin, p);
    if (h.includes('<!--source-link-->') || h.includes('>Source</a>')) leaked.push(p);
  }
  // A visible placeholder comment would be a worse outcome than no link at all.
  check('nothing rendered and no placeholder leaks', leaked.length === 0, leaked.join(', '));

  const faq = await get(origin, '/faq');
  check('faq falls back to the ask-us wording',
    faq.includes('Ask and we will point you at it.')
    && !faq.includes('<!--source-sentence-->'));

  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(faq)?.[1] ?? '';
  const answers = JSON.parse(ld).mainEntity.map((e) => e.acceptedAnswer.text).join(' ');
  check('structured data carries the fallback, not a placeholder',
    answers.includes('Ask and we will point you at it')
    && !answers.includes('source-sentence'));
});

// --- Hostile value ----------------------------------------------------------
await withServer({ SOURCE_URL: 'javascript:alert(1)' }, async (origin) => {
  const h = await get(origin, '/');
  check('rejects a non-http scheme', !h.includes('javascript:'), 'javascript: URL');
});

console.log(failures === 0 ? '\nALL SOURCE-LINK TESTS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
