// The checksum that decides whether a transfer arrived intact. Checked
// against the standard CRC-32 check value and against the plain one-byte-at-
// a-time algorithm, on every length class the 8-byte loop treats differently.
import { transform } from 'esbuild';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}

const src = readFileSync(new URL('../src/client/crc32.ts', import.meta.url), 'utf8');
const { code } = await transform(src, { loader: 'ts', format: 'esm' });
const { Crc32 } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const plain = (bytes) => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let c = 0xffffffff;
  for (const b of bytes) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const check9 = new Crc32(); check9.update(new TextEncoder().encode('123456789'));
check('CRC-32 of "123456789" is the standard cbf43926', check9.value === 0xcbf43926, check9.value.toString(16));

const data = Uint8Array.from({ length: 70000 }, (_, i) => (i * 2654435761) >>> 24);
const lengths = [0, 1, 7, 8, 9, 15, 16, 17, 1000, 65536, 70000];
const wrong = lengths.filter((n) => { const c = new Crc32(); c.update(data.subarray(0, n)); return c.value !== plain(data.subarray(0, n)); });
check('matches the plain algorithm on every length', wrong.length === 0, wrong.join(','));

// Fed in pieces of any size, the result is the same as in one go - which is
// what makes a checksum carried across a resumed transfer meaningful.
const whole = new Crc32(); whole.update(data);
const parts = new Crc32(); let pos = 0;
for (const step of [1, 3, 8, 13, 4096, 9999]) { parts.update(data.subarray(pos, pos + step)); pos += step; }
parts.update(data.subarray(pos));
check('fed in pieces it equals fed in one go', parts.value === whole.value);

const resumed = new Crc32(parts.state);
check('a saved state carries on where it stopped', resumed.state === parts.state && resumed.value === whole.value);

console.log(failures === 0 ? '\nALL CRC32 TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
