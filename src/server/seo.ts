/**
 * Search-engine surface: canonical URLs, social previews, structured data,
 * sitemap and robots.
 *
 * A peer-to-peer transfer tool is two thin pages of UI, which is very little for
 * a crawler to work with. The documentation page carries the actual indexable
 * content, and its FAQ is mirrored into schema.org structured data so search
 * engines can read the questions directly.
 */

export interface PageSeo {
  path: string;
  title: string;
  description: string;
  /** Share pages must never be indexed - the slug is the only access control. */
  noindex?: boolean;
}

export const PAGES: Record<string, PageSeo> = {
  'index.html': {
    path: '/',
    title: 'Aurora FileShare — peer-to-peer file transfers in your browser',
    description:
      'Send files straight from your browser to theirs. No upload, no account, '
      + 'no size limit, and nothing stored on a server.',
  },
  'faq.html': {
    path: '/faq',
    title: 'How it works & FAQ — Aurora FileShare',
    description:
      'How Aurora FileShare sends files peer to peer without uploading them: '
      + 'size limits, privacy, passwords, expiry, browser support and troubleshooting.',
  },
  'send-large-files.html': {
    path: '/send-large-files',
    title: 'Send large files without an account — Aurora FileShare',
    description:
      'Why transfer services impose size limits and account walls, what a free '
      + 'tier usually means, and how a browser-to-browser transfer avoids both.',
  },
  'download.html': {
    path: '/d/',
    title: 'Incoming files — Aurora FileShare',
    description: 'Someone is sending you files directly from their browser.',
    noindex: true,
  },
};

/** Indexable pages, in the order they should appear in the sitemap. */
export const INDEXABLE = Object.values(PAGES).filter((p) => !p.noindex);

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * JSON-LD sits in an inline script tag, so any '<' in the data has to be
 * escaped or a '</script>' inside a string would end the block early.
 */
function jsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function metaTagsFor(page: PageSeo, publicUrl: string, imageUrl = ''): string {
  const canonical = publicUrl ? new URL(page.path, publicUrl).toString() : '';
  const tags: string[] = [];

  if (page.noindex) {
    tags.push('<meta name="robots" content="noindex, nofollow">');
  } else {
    tags.push('<meta name="robots" content="index, follow, max-image-preview:large">');
    if (canonical) tags.push(`<link rel="canonical" href="${escapeAttribute(canonical)}">`);
  }

  // Open Graph and Twitter drive the preview card when the link is pasted into
  // a chat - which, for a tool people share by link, is most of its exposure.
  tags.push(
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Aurora FileShare">',
    `<meta property="og:title" content="${escapeAttribute(page.title)}">`,
    `<meta property="og:description" content="${escapeAttribute(page.description)}">`,
    // summary_large_image only renders large if an image is actually supplied;
    // without one the card silently degrades to a cramped text stub.
    `<meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeAttribute(page.title)}">`,
    `<meta name="twitter:description" content="${escapeAttribute(page.description)}">`,
  );
  if (canonical) tags.push(`<meta property="og:url" content="${escapeAttribute(canonical)}">`);

  // Crawlers fetch this server-side, so it needs an absolute URL and is not
  // subject to the page's own img-src policy.
  if (imageUrl && publicUrl) {
    const absolute = new URL(imageUrl, publicUrl).toString();
    tags.push(
      `<meta property="og:image" content="${escapeAttribute(absolute)}">`,
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      `<meta property="og:image:alt" content="${escapeAttribute(page.title)}">`,
      `<meta name="twitter:image" content="${escapeAttribute(absolute)}">`,
    );
  }

  return tags.join('');
}

/** Strips tags and collapses whitespace, for turning markup into plain text. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FaqEntry {
  question: string;
  answer: string;
}

/**
 * Reads the questions straight out of the rendered FAQ markup, so the
 * structured data cannot drift away from what the page actually says.
 */
export function extractFaq(html: string): FaqEntry[] {
  const section = /<article[^>]*id="faq"[^>]*>([\s\S]*?)<\/article>/.exec(html);
  if (!section) return [];

  const entries: FaqEntry[] = [];
  const blocks = section[1]!.split(/<h3[^>]*>/).slice(1);

  for (const block of blocks) {
    const end = block.indexOf('</h3>');
    if (end === -1) continue;
    const question = textOf(block.slice(0, end));
    const answer = [...block.slice(end).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => textOf(m[1]!))
      .filter(Boolean)
      .join(' ');
    if (question && answer) entries.push({ question, answer });
  }
  return entries;
}

export function faqJsonLd(entries: FaqEntry[]): string {
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries.map((e) => ({
      '@type': 'Question',
      name: e.question,
      acceptedAnswer: { '@type': 'Answer', text: e.answer },
    })),
  });
}

export function appJsonLd(publicUrl: string): string {
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Aurora FileShare',
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Any browser',
    url: publicUrl || undefined,
    description: PAGES['index.html']!.description,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    featureList: [
      'Peer-to-peer file transfer',
      'No file size limit',
      'End-to-end encrypted (DTLS)',
      'Optional password protection',
      'Multiple files as a streaming ZIP',
      'No account required',
    ],
  });
}

export function sitemapXml(publicUrl: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const urls = INDEXABLE.map((page) => {
    const loc = new URL(page.path, publicUrl).toString();
    const priority = page.path === '/' ? '1.0' : '0.8';
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n`
      + `    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(publicUrl: string): string {
  const lines = [
    'User-agent: *',
    // Share slugs are the only thing protecting a share; keep them out of any index.
    'Disallow: /d/',
    'Disallow: /dl/',
    'Allow: /',
    '',
  ];
  if (publicUrl) lines.push(`Sitemap: ${new URL('/sitemap.xml', publicUrl).toString()}`, '');
  return lines.join('\n');
}
