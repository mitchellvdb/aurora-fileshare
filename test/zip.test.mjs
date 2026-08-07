// Validates the ZIP writer's output against real extractors: unzip -t for
// structural integrity, Python's zipfile for a second opinion, and SHA-256 on
// the extracted bytes. Both the classic and ZIP64 layouts are exercised.
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const TMP = new URL('./.tmp/zip/', import.meta.url).pathname;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// The module is browser code; bundle it so Node can import it directly.
const bundlePath = `${TMP}/zip.mjs`;
await build({
  entryPoints: ['src/client/zip.ts'],
  outfile: bundlePath,
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent',
});
const { planZip, ZipWriter } = await import(bundlePath);

/** Collects everything the writer emits, standing in for the download sink. */
function bufferSink() {
  const parts = [];
  return {
    parts,
    sink: {
      write: (chunk) => { parts.push(Buffer.from(new Uint8Array(chunk))); },
      close: () => {},
      abort: () => {},
    },
  };
}

async function buildArchive(files, { forceZip64 = false } = {}) {
  const plan = planZip(files.map((f) => ({ name: f.name, size: f.bytes.length })));
  if (forceZip64 && !plan.zip64) {
    // Rebuild the plan as ZIP64 so the wide layout is covered without needing
    // an actual 4 GB file.
    const wide = planZip(files.map((f) => ({ name: f.name, size: f.bytes.length })));
    wide.zip64 = true;
    recomputePlan(wide);
    return runWriter(wide, files);
  }
  return runWriter(plan, files);
}

/** Mirrors planZip's offset/size arithmetic for the forced-ZIP64 case. */
function recomputePlan(plan) {
  const localExtra = 20, centralExtra = 28, descriptor = 24;
  let offset = 0;
  for (const e of plan.entries) {
    e.offset = offset;
    offset += 30 + e.nameBytes.length + localExtra + e.size + descriptor;
  }
  const central = plan.entries.reduce((s, e) => s + 46 + e.nameBytes.length + centralExtra, 0);
  plan.totalSize = offset + central + 56 + 20 + 22;
}

async function runWriter(plan, files) {
  const { parts, sink } = bufferSink();
  const zip = new ZipWriter(plan, sink);
  for (const file of files) {
    const entry = zip.nextEntry();
    // Feed in chunks, the way the data channel actually delivers.
    for (let off = 0; off < file.bytes.length; off += 64 * 1024) {
      const slice = file.bytes.subarray(off, Math.min(off + 64 * 1024, file.bytes.length));
      await entry.write(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
    }
    await entry.close();
  }
  await zip.finish();
  return { archive: Buffer.concat(parts), plan };
}

const files = [
  { name: 'alpha.bin', bytes: randomBytes(700 * 1024) },
  { name: 'rapport-åäö.txt', bytes: Buffer.from('grens\nwaarden\nåäö\n'.repeat(500), 'utf8') },
  { name: 'empty.bin', bytes: Buffer.alloc(0) },
  { name: 'alpha.bin', bytes: randomBytes(1024) },   // duplicate name on purpose
];

for (const [label, opts] of [['classic', {}], ['zip64', { forceZip64: true }]]) {
  console.log(`\n--- ${label} ---`);
  const { archive, plan } = await buildArchive(files, opts);

  check(`${label}: zip64 flag as expected`, plan.zip64 === (label === 'zip64'));
  check(`${label}: written size matches the plan`, archive.length === plan.totalSize,
    `${archive.length} vs ${plan.totalSize}`);

  const zipPath = `${TMP}/${label}.zip`;
  writeFileSync(zipPath, archive);

  let ok = true, detail = '';
  try {
    execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' });
  } catch (e) {
    ok = false; detail = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
  }
  check(`${label}: unzip -t reports no errors`, ok, detail.trim().split('\n').slice(-2).join(' '));

  // Python's zipfile is a completely independent implementation.
  let pyOut = '';
  try {
    pyOut = execFileSync('python3', ['-c', `
import zipfile, hashlib, json, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
out = {"bad": bad, "names": z.namelist(),
       "hashes": {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}
print(json.dumps(out))
`, zipPath], { stdio: 'pipe' }).toString();
  } catch (e) {
    pyOut = ''; detail = (e.stderr?.toString() ?? '');
  }
  check(`${label}: python zipfile opens it`, pyOut.length > 0, detail);

  if (pyOut) {
    const info = JSON.parse(pyOut);
    check(`${label}: no corrupt member`, info.bad === null, String(info.bad));
    check(`${label}: four entries with the duplicate renamed`,
      info.names.length === 4 && info.names.includes('alpha (1).bin'), info.names.join(', '));
    check(`${label}: non-ASCII entry name preserved`,
      info.names.includes('rapport-åäö.txt'), info.names.join(', '));

    const expected = {
      'alpha.bin': sha256(files[0].bytes),
      'rapport-åäö.txt': sha256(files[1].bytes),
      'empty.bin': sha256(files[2].bytes),
      'alpha (1).bin': sha256(files[3].bytes),
    };
    const mismatches = Object.entries(expected)
      .filter(([n, h]) => info.hashes[n] !== h).map(([n]) => n);
    check(`${label}: every member's contents match by sha256`,
      mismatches.length === 0, mismatches.join(', '));
  }
}

console.log(failures === 0 ? '\nALL ZIP TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
