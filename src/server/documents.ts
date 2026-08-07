import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';

/**
 * The two HTML documents are rendered once at startup with the runtime config
 * baked in as meta tags, then served from memory.
 *
 * A meta tag rather than an inline script keeps the strict CSP intact - there
 * is no 'unsafe-inline' to grant - and baking it in beats a second round trip
 * for a config fetch, which would also make the button pop in after paint.
 */

interface Document {
  html: Buffer;
  etag: string;
}

const documents = new Map<string, Document>();

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function metaTags(): string {
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

function applyManifest(html: string, manifest: Record<string, string>): string {
  let out = html;
  for (const [logical, hashed] of Object.entries(manifest)) {
    const from = logical === 'styles.css' ? '/styles.css' : `/build/${logical}`;
    out = out.split(from).join(hashed);
  }
  return out;
}

export async function loadDocuments(publicRoot: string): Promise<void> {
  const injected = metaTags();
  const manifest = await assetManifest(publicRoot);

  for (const name of ['index.html', 'download.html']) {
    const source = await readFile(join(publicRoot, name), 'utf8');
    const withAssets = applyManifest(source, manifest);
    const html = injected
      ? withAssets.replace('</head>', `${injected}</head>`)
      : withAssets;
    const buffer = Buffer.from(html, 'utf8');
    documents.set(name, {
      html: buffer,
      etag: `W/"${createHash('sha1').update(buffer).digest('hex').slice(0, 16)}"`,
    });
  }

  console.log(injected
    ? `[aurora-fileshare] donate button enabled -> ${safeUrl(config.donateUrl)}`
    : '[aurora-fileshare] donate button disabled (DONATE_URL not set)');
}

export function serveDocument(
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const doc = documents.get(name);
  if (!doc) return false;

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
