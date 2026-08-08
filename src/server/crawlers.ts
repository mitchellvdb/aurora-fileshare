/**
 * Crawler visibility.
 *
 * Search consoles report crawl activity days late, which makes "has anything
 * even looked at the site yet?" surprisingly hard to answer. This records when
 * a known crawler arrives and what it asked for.
 *
 * Deliberately narrow: only recognised bots are recorded, and only the bot's
 * name, the path and the status. No IP address, no user agent string, nothing
 * about ordinary visitors. The FAQ tells people their address is never written
 * down, and that has to stay true.
 */

export type CrawlerKind = 'search' | 'social' | 'ai' | 'seo';

interface CrawlerSignature {
  name: string;
  kind: CrawlerKind;
  pattern: RegExp;
}

/** Ordered: the first match wins, so put the specific ones first. */
const SIGNATURES: CrawlerSignature[] = [
  // Search engines - the ones that matter for being found.
  { name: 'Googlebot', kind: 'search', pattern: /Googlebot(?!-)/i },
  { name: 'Googlebot-Image', kind: 'search', pattern: /Googlebot-Image/i },
  { name: 'Bingbot', kind: 'search', pattern: /bingbot/i },
  { name: 'DuckDuckBot', kind: 'search', pattern: /DuckDuckBot/i },
  { name: 'YandexBot', kind: 'search', pattern: /YandexBot/i },
  { name: 'Baiduspider', kind: 'search', pattern: /Baiduspider/i },
  { name: 'Applebot', kind: 'search', pattern: /Applebot(?!-Extended)/i },
  { name: 'Qwantbot', kind: 'search', pattern: /Qwantbot/i },
  { name: 'MojeekBot', kind: 'search', pattern: /MojeekBot/i },

  // Link preview fetchers - these fire when someone pastes a share link.
  { name: 'facebookexternalhit', kind: 'social', pattern: /facebookexternalhit|meta-externalhit/i },
  { name: 'Twitterbot', kind: 'social', pattern: /Twitterbot/i },
  { name: 'LinkedInBot', kind: 'social', pattern: /LinkedInBot/i },
  { name: 'Slackbot', kind: 'social', pattern: /Slackbot/i },
  { name: 'Discordbot', kind: 'social', pattern: /Discordbot/i },
  { name: 'TelegramBot', kind: 'social', pattern: /TelegramBot/i },
  { name: 'WhatsApp', kind: 'social', pattern: /WhatsApp/i },
  { name: 'Mastodon', kind: 'social', pattern: /Mastodon/i },

  // AI crawlers. Cloudflare's managed robots.txt already tells these to stay
  // away, so anything showing up here is ignoring it.
  { name: 'GPTBot', kind: 'ai', pattern: /GPTBot/i },
  { name: 'ClaudeBot', kind: 'ai', pattern: /ClaudeBot|anthropic-ai/i },
  { name: 'CCBot', kind: 'ai', pattern: /CCBot/i },
  { name: 'PerplexityBot', kind: 'ai', pattern: /PerplexityBot/i },
  { name: 'Google-Extended', kind: 'ai', pattern: /Google-Extended/i },
  { name: 'Applebot-Extended', kind: 'ai', pattern: /Applebot-Extended/i },
  { name: 'Bytespider', kind: 'ai', pattern: /Bytespider/i },
  { name: 'Amazonbot', kind: 'ai', pattern: /Amazonbot/i },

  // Commercial SEO scrapers - noise, but useful to be able to see.
  { name: 'AhrefsBot', kind: 'seo', pattern: /AhrefsBot/i },
  { name: 'SemrushBot', kind: 'seo', pattern: /SemrushBot/i },
  { name: 'MJ12bot', kind: 'seo', pattern: /MJ12bot/i },
  { name: 'DotBot', kind: 'seo', pattern: /DotBot/i },
];

export interface CrawlerIdentity {
  name: string;
  kind: CrawlerKind;
}

export function identifyCrawler(userAgent: string | undefined): CrawlerIdentity | null {
  if (!userAgent) return null;
  for (const sig of SIGNATURES) {
    if (sig.pattern.test(userAgent)) return { name: sig.name, kind: sig.kind };
  }
  return null;
}

interface CrawlerStats {
  kind: CrawlerKind;
  hits: number;
  firstSeen: string;
  lastSeen: string;
  lastPath: string;
}

const stats = new Map<string, CrawlerStats>();

/**
 * Records a crawler visit. Takes only what it needs - there is deliberately no
 * parameter for an address, so none can be logged by accident later.
 */
export function recordCrawlerVisit(
  crawler: CrawlerIdentity,
  method: string,
  path: string,
  status: number,
): void {
  const now = new Date().toISOString();
  const existing = stats.get(crawler.name);

  if (existing) {
    existing.hits += 1;
    existing.lastSeen = now;
    existing.lastPath = path;
  } else {
    stats.set(crawler.name, {
      kind: crawler.kind, hits: 1, firstSeen: now, lastSeen: now, lastPath: path,
    });
  }

  console.log(`[crawler] ${crawler.name} (${crawler.kind}) ${method} ${path} -> ${status}`);
}

export function crawlerSummary(): Record<string, CrawlerStats> {
  return Object.fromEntries([...stats].sort((a, b) => b[1].hits - a[1].hits));
}
