// Crawler logging exists to answer "is anything indexing us yet?" without
// turning the server into something that keeps records on its visitors.
//
// So there are two halves here: that recognised bots are recorded, and - the
// part that actually matters - that ordinary visitors are not, and that no
// address ever reaches the log.
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

const port = await freePort();
const child = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
         PUBLIC_URL: 'https://fileshare.aurorahosting.nl' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d.toString(); });
child.stderr.on('data', (d) => { log += d.toString(); });

const ORIGIN = `http://127.0.0.1:${port}`;
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${ORIGIN}/healthz`, { headers: { 'user-agent': CHROME } })).ok) break; }
    catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }

  const visit = (ua, path = '/') => fetch(ORIGIN + path, { headers: { 'user-agent': ua } });

  // --- Recognised crawlers, across every category --------------------------
  const bots = [
    ['Googlebot', 'search', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', '/faq'],
    ['Bingbot', 'search', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', '/sitemap.xml'],
    ['DuckDuckBot', 'search', 'Mozilla/5.0 (compatible; DuckDuckBot/1.1)', '/'],
    ['Twitterbot', 'social', 'Twitterbot/1.0', '/'],
    ['Slackbot', 'social', 'Slackbot-LinkExpanding 1.0', '/faq'],
    ['GPTBot', 'ai', 'Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)', '/'],
    ['AhrefsBot', 'seo', 'Mozilla/5.0 (compatible; AhrefsBot/7.0)', '/'],
  ];
  for (const [, , ua, path] of bots) await visit(ua, path);

  // --- Ordinary visitors, on several paths ---------------------------------
  await visit(CHROME, '/');
  await visit(CHROME, '/faq');
  await visit(CHROME, '/d/swift-otter-100');
  await visit('curl/8.5.0', '/');
  await visit('', '/');

  await new Promise((r) => setTimeout(r, 300));

  const summary = (await (await fetch(`${ORIGIN}/healthz`, { headers: { 'user-agent': CHROME } })).json()).crawlers;
  const lines = log.split('\n').filter((l) => l.includes('[crawler]'));

  for (const [name, kind, , path] of bots) {
    check(`${name} recorded`, summary[name]?.hits >= 1, JSON.stringify(summary[name] ?? null));
    check(`${name} categorised as ${kind}`, summary[name]?.kind === kind, summary[name]?.kind);
    check(`${name} logged with its path`,
      lines.some((l) => l.includes(name) && l.includes(path)),
      lines.find((l) => l.includes(name)) ?? 'no line');
  }

  // --- The part that matters ------------------------------------------------
  check('a normal browser is never recorded',
    !Object.keys(summary).some((k) => /chrome|safari|mozilla/i.test(k)),
    Object.keys(summary).join(', '));
  check('curl is not recorded', !('curl' in summary));
  check('only the seven known bots appear',
    Object.keys(summary).length === bots.length,
    Object.keys(summary).join(', '));
  check('no log line mentions a normal visitor',
    !lines.some((l) => /Chrome|curl|Safari/i.test(l)));

  const ipLike = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b(?:[0-9a-f]{0,4}:){3,}[0-9a-f]{0,4}\b/i;
  const offending = lines.filter((l) => ipLike.test(l));
  check('no crawler log line contains an address', offending.length === 0, offending.join(' | '));
  check('no log line leaks a user agent string',
    !lines.some((l) => /Mozilla|AppleWebKit|compatible;/i.test(l)));

  // --- Counters accumulate --------------------------------------------------
  const before = summary['Googlebot'].hits;
  await visit('Googlebot/2.1', '/');
  await visit('Googlebot/2.1', '/faq');
  await new Promise((r) => setTimeout(r, 200));
  const after = (await (await fetch(`${ORIGIN}/healthz`, { headers: { 'user-agent': CHROME } })).json())
    .crawlers['Googlebot'];
  check('repeat visits accumulate', after.hits === before + 2, `${before} -> ${after.hits}`);
  check('last path is tracked', after.lastPath === '/faq', after.lastPath);
  check('first seen is preserved', after.firstSeen === summary['Googlebot'].firstSeen);
} finally {
  child.kill('SIGTERM');
}

console.log(failures === 0 ? '\nALL CRAWLER TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
