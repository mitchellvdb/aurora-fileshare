// Search engines only ever see what the server renders, so these assertions run
// against real responses rather than the source files.
//
// The one that matters most is the last group: the FAQ's structured data is
// generated from the page's own markup, and this proves the two agree. Marking
// up answers that differ from the visible page is exactly what gets structured
// data penalised.
import puppeteer from 'puppeteer-core';

const ORIGIN = process.env.TEST_ORIGIN ?? 'http://127.0.0.1:8080';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}
const get = async (p) => (await fetch(ORIGIN + p)).text();

// --- Documentation page exists and is substantial ---------------------------
{
  const res = await fetch(ORIGIN + '/faq');
  check('/faq is served', res.ok, String(res.status));
  const html = await res.text();
  check('/faq.html and /docs also resolve',
    (await fetch(ORIGIN + '/faq.html')).ok && (await fetch(ORIGIN + '/docs')).ok);

  const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  // Thin pages do not rank; this is the page carrying the indexable content.
  check('/faq has substantial prose', words > 600, `${words} words`);
  check('/faq has a descriptive title', /<title>[^<]{25,}<\/title>/.test(html));
  check('/faq has a meta description', /<meta name="description" content="[^"]{60,}"/.test(html));
}

// --- Indexable pages carry canonical and preview metadata -------------------
for (const [label, path, canonical] of [
  ['home', '/', '/'],
  ['faq', '/faq', '/faq'],
]) {
  const html = await get(path);
  check(`${label}: marked indexable`, /<meta name="robots" content="index, follow/.test(html));
  check(`${label}: has a canonical url`,
    new RegExp(`<link rel="canonical" href="https?://[^"]+${canonical === '/' ? '/"' : canonical + '"'}`).test(html),
    (/<link rel="canonical" href="([^"]+)"/.exec(html) ?? [])[1]);
  check(`${label}: open graph title and url`,
    html.includes('property="og:title"') && html.includes('property="og:url"'));
  check(`${label}: twitter card`, html.includes('name="twitter:card"'));
}

// --- Share pages must never be indexed --------------------------------------
{
  const res = await fetch(ORIGIN + '/d/swift-otter-100');
  const html = await res.text();
  check('share page: noindex meta tag', /<meta name="robots" content="noindex/.test(html));
  check('share page: X-Robots-Tag header too',
    (res.headers.get('x-robots-tag') ?? '').includes('noindex'),
    res.headers.get('x-robots-tag') ?? 'absent');
  check('share page: no canonical url', !html.includes('rel="canonical"'));
}

// --- Search engine ownership verification ------------------------------------
{
  const res = await fetch(ORIGIN + '/BingSiteAuth.xml');
  check('bing verification file is served from the root', res.ok, String(res.status));
  const ct = res.headers.get('content-type') ?? '';
  check('bing verification file is served as xml', ct.includes('xml'), ct);
  const body = await res.text();
  check('bing verification file carries a token',
    /<user>[0-9A-Fa-f]{16,}<\/user>/.test(body), body.replace(/\s+/g, ' ').trim().slice(0, 60));
}

// --- robots.txt --------------------------------------------------------------
{
  const robots = await get('/robots.txt');
  check('robots: disallows share pages', /^Disallow: \/d\//m.test(robots));
  check('robots: disallows download endpoints', /^Disallow: \/dl\//m.test(robots));
  check('robots: allows the rest', /^Allow: \//m.test(robots));
  check('robots: points at the sitemap', /^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m.test(robots), robots.trim());
}

// --- sitemap.xml -------------------------------------------------------------
{
  const res = await fetch(ORIGIN + '/sitemap.xml');
  check('sitemap: served as xml',
    (res.headers.get('content-type') ?? '').includes('xml'), res.headers.get('content-type') ?? '');
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check('sitemap: lists the home page', locs.some((l) => /\/$/.test(l)), locs.join(', '));
  check('sitemap: lists the faq', locs.some((l) => l.endsWith('/faq')));
  check('sitemap: never leaks a share url', !locs.some((l) => l.includes('/d/')));
  check('sitemap: every url is absolute https', locs.every((l) => l.startsWith('https://')), locs.join(', '));
}

// --- Structured data ----------------------------------------------------------
function extractLd(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]));
}
{
  const home = extractLd(await get('/'));
  check('home: one structured data block', home.length === 1, String(home.length));
  check('home: describes a WebApplication', home[0]?.['@type'] === 'WebApplication', home[0]?.['@type']);
  check('home: states it is free', home[0]?.offers?.price === '0');

  const faqHtml = await get('/faq');
  const faqLd = extractLd(faqHtml);
  check('faq: one structured data block', faqLd.length === 1);
  check('faq: typed as FAQPage', faqLd[0]?.['@type'] === 'FAQPage');

  const marked = (faqLd[0]?.mainEntity ?? []).map((q) => q.name);
  const onPage = [...faqHtml.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

  check('faq: marks up every question on the page',
    marked.length === onPage.length && marked.length > 8,
    `${marked.length} marked vs ${onPage.length} on page`);
  check('faq: marked questions match the visible ones',
    marked.join('|') === onPage.join('|'),
    marked.filter((q, i) => q !== onPage[i]).join(', '));
  check('faq: every answer has text',
    (faqLd[0]?.mainEntity ?? []).every((q) => (q.acceptedAnswer?.text ?? '').length > 40));
}

// --- The strict CSP must still hold with inline JSON-LD present --------------
{
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    for (const [label, path] of [['home', '/'], ['faq', '/faq']]) {
      const page = await browser.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push(String(e)));
      page.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' || /Content Security Policy/i.test(t)) problems.push(t);
      });
      await page.goto(ORIGIN + path, { waitUntil: 'networkidle0' });
      check(`${label}: renders with no CSP violation or console error`,
        problems.length === 0, problems.join(' | '));

      if (label === 'faq') {
        const headings = await page.$$eval('#faq h3', (els) => els.length);
        check('faq: questions visible in the DOM', headings > 8, String(headings));
        const donate = await page.$('#donate-slot a.donate');
        check('faq: tip button rendered here too', donate !== null);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

console.log(failures === 0 ? '\nALL SEO TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
