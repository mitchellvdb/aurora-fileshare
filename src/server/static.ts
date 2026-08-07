import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Content-Security-Policy is strict on purpose: this page handles other
 * people's files, so no inline script, no third-party origins, and connections
 * limited to our own host (plus STUN/TURN, which is not subject to connect-src).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss: blob:",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}

export async function serveFile(
  root: string,
  relPath: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // Resolve inside root and reject anything that escapes it.
  const target = resolve(join(root, normalize(relPath)));
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const ext = extname(target).toLowerCase();
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return true;
  }

  // Hashed bundle assets are immutable; everything else must revalidate so a
  // deploy takes effect immediately (critically, the service worker).
  const immutable = relPath.startsWith('/build/') && /\.[0-9a-f]{8}\./.test(relPath);
  res.setHeader('Cache-Control', immutable
    ? 'public, max-age=31536000, immutable'
    : 'no-cache');
  res.setHeader('ETag', etag);
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', info.size);

  if (req.method === 'HEAD') {
    res.writeHead(200).end();
    return true;
  }

  res.writeHead(200);
  createReadStream(target).pipe(res);
  return true;
}
