// A deploy must never leave a browser running the previous bundle against the
// current HTML. That happened in production: the origin sent no-cache, but the
// CDN in front applied its own 4 hour browser TTL, so the new HTML shipped with
// a meta tag the stale JavaScript did not know how to use.
//
// Content-hashed filenames make the question moot - new content, new URL - but
// only if the HTML actually points at the hashed names and the caching rules
// stay the right way round. That is what this pins down.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ORIGIN = process.env.TEST_ORIGIN ?? 'http://127.0.0.1:8080';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}

const HASHED = /\/build\/[a-z]+\.[A-Za-z0-9]{8}\.(js|css)$/;

for (const [label, path] of [['upload', '/'], ['download', '/d/swift-otter-100']]) {
  const html = await (await fetch(ORIGIN + path)).text();
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);

  check(`${label}: references at least one script and stylesheet`, refs.length >= 2, refs.join(', '));
  check(`${label}: every asset reference is content-hashed`,
    refs.every((r) => HASHED.test(r)), refs.join(', '));
  check(`${label}: no unhashed bundle slipped through`,
    !html.includes('/build/upload.js') && !html.includes('/build/download.js')
    && !html.includes('"/styles.css"'));

  for (const ref of refs) {
    const res = await fetch(ORIGIN + ref);
    const cc = res.headers.get('cache-control') ?? '';
    check(`${label}: ${ref.split('/').pop()} is served`, res.ok, String(res.status));
    check(`${label}: ${ref.split('/').pop()} is immutable`,
      cc.includes('immutable') && /max-age=\d{7,}/.test(cc), cc);
  }
}

// Documents must never be pinned, or a deploy cannot take effect.
for (const [label, path] of [
  ['index.html', '/'],
  ['download.html', '/d/swift-otter-100'],
]) {
  const res = await fetch(ORIGIN + path);
  const cc = res.headers.get('cache-control') ?? '';
  check(`${label} revalidates rather than caching`, cc.includes('no-cache'), cc);
}

// The worker is the same story, but only the origin's header is ours to set -
// a CDN in front may rewrite it, which is exactly why the registration also
// tells the browser to bypass its HTTP cache when checking for updates.
{
  const res = await fetch(ORIGIN + '/sw.js');
  const cc = res.headers.get('cache-control') ?? '';
  const viaCdn = res.headers.has('cf-cache-status');
  if (viaCdn) {
    console.log(`      (behind a CDN; it rewrote sw.js caching to "${cc}")`);
  } else {
    check('sw.js revalidates at the origin', cc.includes('no-cache'), cc);
  }

  const bundle = await (await fetch(ORIGIN + JSON.parse(
    readFileSync(join(ROOT, 'public/build/manifest.json'), 'utf8'))['download.js'])).text();
  check('worker registration bypasses the HTTP cache for updates',
    /updateViaCache\s*:\s*["']none["']/.test(bundle));
}

// The manifest must agree with what the server actually serves.
const manifest = JSON.parse(readFileSync(join(ROOT, 'public/build/manifest.json'), 'utf8'));
const html = await (await fetch(ORIGIN + '/')).text();
check('manifest matches the served upload bundle',
  html.includes(manifest['upload.js']), manifest['upload.js']);
check('manifest matches the served stylesheet',
  html.includes(manifest['styles.css']), manifest['styles.css']);

// A hash must actually track content, or nothing above helps.
check('bundle names carry an 8 character hash',
  /\.[A-Za-z0-9]{8}\.js$/.test(manifest['upload.js']), manifest['upload.js']);
check('upload and download hash differently',
  manifest['upload.js'].split('.')[1] !== manifest['download.js'].split('.')[1]);

console.log(failures === 0 ? '\nALL ASSET TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
