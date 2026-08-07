import { build, context } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';

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

// Page bundles.
const pages = {
  entryPoints: ['src/client/upload.ts', 'src/client/download.ts'],
  outdir: 'public/build',
  splitting: false,
  ...shared,
};

// The service worker must live at the origin root to claim a root scope.
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

if (watch) {
  const contexts = await Promise.all([context(pages), context(worker)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[build] watching client sources');
} else {
  await Promise.all([build(pages), build(worker)]);
  console.log('[build] client bundles written');
}
