import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';
import { baseCsp } from './static.js';
import {
  appJsonLd, extractFaq, faqJsonLd, metaTagsFor, PAGES, robotsTxt, sitemapXml,
} from './seo.js';

/**
 * HTML documents are rendered once at startup - runtime config, SEO metadata,
 * structured data and hashed asset URLs all baked in - then served from memory.
 *
 * Doing it here rather than in the client avoids an inline script, which the
 * strict CSP would otherwise force us to loosen, and means the page is complete
 * on first paint instead of assembling itself afterwards.
 */

interface Document {
  html: Buffer;
  etag: string;
  /** Per-document policy, carrying hashes for any inline JSON-LD. */
  csp: string;
}

const documents = new Map<string, Document>();
let generatedSitemap = '';
let generatedRobots = '';

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Only http(s) links may reach the page. A misconfigured javascript: or data:
 * URL would otherwise become a clickable link on every visitor's screen.
 */
function safeUrl(raw: string): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`[aurora-fileshare] DONATE_URL is not a valid URL, ignoring: ${raw}`);
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.warn(`[aurora-fileshare] DONATE_URL must be http(s), ignoring: ${parsed.protocol}`);
    return null;
  }
  return parsed.toString();
}

function donateMeta(): string {
  const donateUrl = safeUrl(config.donateUrl);
  if (!donateUrl) return '';
  const label = config.donateLabel || 'Buy me a coffee';
  return `<meta name="aurora-donate-url" content="${escapeAttribute(donateUrl)}">`
    + `<meta name="aurora-donate-label" content="${escapeAttribute(label)}">`;
}

/**
 * Rewrites asset references to their content-hashed build output, so a deploy
 * can never leave a browser running last version's JavaScript against this
 * version's HTML.
 */
async function assetManifest(publicRoot: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(publicRoot, 'build/manifest.json'), 'utf8'));
  } catch {
    console.warn('[aurora-fileshare] no build manifest; serving unhashed asset names');
    return {};
  }
}

/** Social preview cards, written by scripts/build-og.mjs. */
async function ogManifest(publicRoot: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(publicRoot, 'og/manifest.json'), 'utf8'));
  } catch {
    console.warn('[aurora-fileshare] no social cards built; previews will be text only');
    return {};
  }
}

function applyManifest(html: string, manifest: Record<string, string>): string {
  let out = html;
  for (const [logical, hashed] of Object.entries(manifest)) {
    const from = logical === 'styles.css' ? '/styles.css' : `/build/${logical}`;
    out = out.split(from).join(hashed);
  }
  return out;
}

function scriptHash(content: string): string {
  return `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`;
}

export async function loadDocuments(publicRoot: string): Promise<void> {
  const manifest = await assetManifest(publicRoot);
  const cards = await ogManifest(publicRoot);
  const donate = donateMeta();
  const publicUrl = config.publicUrl;

  // The FAQ's structured data is derived from the page's own markup, so the two
  // cannot disagree about what the answers say.
  const faqSource = await readFile(join(publicRoot, 'faq.html'), 'utf8');
  const faqEntries = extractFaq(faqSource);

  for (const [name, page] of Object.entries(PAGES)) {
    const source = await readFile(join(publicRoot, name), 'utf8');
    // Share pages get their own card: that link is the one people actually
    // paste into a chat, so it is the most-seen preview on the site.
    const card = cards[page.noindex ? 'share' : 'default'] ?? '';
    const head: string[] = [metaTagsFor(page, publicUrl, card), donate];
    const hashes: string[] = [];

    const structured = name === 'faq.html'
      ? (faqEntries.length > 0 ? faqJsonLd(faqEntries) : '')
      : name === 'index.html' ? appJsonLd(publicUrl) : '';

    if (structured) {
      head.push(`<script type="application/ld+json">${structured}</script>`);
      hashes.push(scriptHash(structured));
    }

    const html = applyManifest(source, manifest)
      .replace('</head>', `${head.filter(Boolean).join('')}</head>`);
    const buffer = Buffer.from(html, 'utf8');

    documents.set(name, {
      html: buffer,
      etag: `W/"${createHash('sha1').update(buffer).digest('hex').slice(0, 16)}"`,
      csp: baseCsp(hashes),
    });
  }

  generatedSitemap = publicUrl ? sitemapXml(publicUrl) : '';
  generatedRobots = robotsTxt(publicUrl);

  console.log(`[aurora-fileshare] documents rendered (${faqEntries.length} FAQ entries)`);
  console.log(donate
    ? `[aurora-fileshare] donate button enabled -> ${safeUrl(config.donateUrl)}`
    : '[aurora-fileshare] donate button disabled (DONATE_URL not set)');
  if (!publicUrl) {
    console.warn('[aurora-fileshare] PUBLIC_URL unset: no canonical URLs or sitemap');
  }
}

export function serveDocument(
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const doc = documents.get(name);
  if (!doc) return false;

  res.setHeader('Content-Security-Policy', doc.csp);

  // A share page must stay out of search results even if a crawler reaches it
  // without having read robots.txt - the slug is the only thing gating access.
  if (PAGES[name]?.noindex) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }

  if (req.headers['if-none-match'] === doc.etag) {
    res.writeHead(304).end();
    return true;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', doc.etag);
  res.setHeader('Content-Length', doc.html.length);

  if (req.method === 'HEAD') {
    res.writeHead(200).end();
    return true;
  }
  res.writeHead(200).end(doc.html);
  return true;
}

export function serveSitemap(res: ServerResponse): boolean {
  if (!generatedSitemap) return false;
  res.writeHead(200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(generatedSitemap);
  return true;
}

export function serveRobots(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(generatedRobots);
}
