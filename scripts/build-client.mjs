import { execFileSync } from 'node:child_process';
import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const watch = process.argv.includes('--watch');
const dev = watch || process.env.NODE_ENV === 'development';

await rm('public/build', { recursive: true, force: true });
await mkdir('public/build', { recursive: true });

const shared = {
  bundle: true,
  format: 'esm',
  target: ['chrome111', 'firefox115', 'safari16.4'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  logLevel: 'info',
};

/**
 * Page bundles carry a content hash in the filename.
 *
 * Without it, a deploy leaves browsers holding the previous bundle until their
 * cache expires - and a CDN in front can override our no-cache header with its
 * own TTL, which is exactly what happened in production. Hashed names sidestep
 * the question entirely: new content means a new URL, so there is no stale copy
 * to serve, and the files can then be cached forever.
 */
const pages = {
  entryPoints: ['src/client/upload.ts', 'src/client/download.ts', 'src/client/faq.ts'],
  outdir: 'public/build',
  entryNames: dev ? '[name]' : '[name].[hash]',
  metafile: true,
  splitting: false,
  ...shared,
};

// The service worker must keep a stable path to hold its scope, so it is never
// hashed. It is served with no-cache and revalidates on every load.
const worker = {
  entryPoints: ['src/client/sw.ts'],
  outfile: 'public/sw.js',
  format: 'iife',
  bundle: true,
  target: shared.target,
  minify: shared.minify,
  sourcemap: shared.sourcemap,
  logLevel: 'info',
};

/** Maps logical asset names to their built (possibly hashed) URLs. */
async function writeManifest(result) {
  const manifest = {};

  for (const [outPath, meta] of Object.entries(result.metafile?.outputs ?? {})) {
    if (!outPath.endsWith('.js')) continue;
    const entry = meta.entryPoint;
    if (!entry) continue;
    const logical = basename(entry).replace(/\.ts$/, '.js');
    manifest[logical] = '/' + outPath.replace(/^public\//, '');
  }

  // The stylesheet is not bundled, so hash it by hand for the same reason.
  const css = await readFile('public/styles.css');
  if (dev) {
    manifest['styles.css'] = '/styles.css';
  } else {
    const hash = createHash('sha256').update(css).digest('hex').slice(0, 8);
    const name = `styles.${hash}.css`;
    await writeFile(`public/build/${name}`, css);
    manifest['styles.css'] = `/build/${name}`;
  }

  await writeFile('public/build/manifest.json', JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * When each page last changed, for the sitemap. Taken from git, because the
 * server has no repository and a file's mtime on the server is just whenever
 * it was last deployed. A sitemap that claims every page changed today - as it
 * did when the server used today's date - teaches Google to ignore the field.
 */
async function writeLastmod() {
  const dates = {};
  for (const name of (await readdir('public')).filter((f) => f.endsWith('.html'))) {
    let date = '';
    try {
      date = execFileSync('git', ['log', '-1', '--format=%cs', '--', `public/${name}`], { encoding: 'utf8' }).trim();
    } catch { /* not a git checkout */ }
    // Uncommitted or untracked: it is changing right now.
    if (!date) date = new Date().toISOString().slice(0, 10);
    dates[name] = date;
  }
  await writeFile('public/build/lastmod.json', JSON.stringify(dates, null, 2));
}

if (watch) {
  const contexts = await Promise.all([context(pages), context(worker)]);
  await Promise.all(contexts.map((c) => c.watch()));
  // Watch mode uses unhashed names, so one manifest up front is enough.
  await writeManifest(await build({ ...pages, write: false }));
  console.log('[build] watching client sources');
} else {
  const [result] = await Promise.all([build(pages), build(worker)]);
  const manifest = await writeManifest(result);
  await writeLastmod();
  console.log('[build] client bundles written');
  for (const [k, v] of Object.entries(manifest)) console.log(`         ${k} -> ${v}`);
}
