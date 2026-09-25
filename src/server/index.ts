import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { ClientMessage, FileStub } from '../shared/protocol.js';
import { MAX_FILES, SEALED_MAX } from '../shared/protocol.js';
import { config } from './config.js';
import { ChannelRegistry, newPeer, parseVerifier, send, type Peer } from './channels.js';
import { RateLimiter } from './rate-limit.js';
import { isValidSlug } from './slug.js';
import { crawlerSummary, identifyCrawler, recordCrawlerVisit } from './crawlers.js';
import { flushUsage, recordReceive, recordShare, usageSummary } from './usage.js';
import { securityHeaders, serveFile } from './static.js';
import {
  loadDocuments, serveDocument, serveRobots, serveSitemap,
} from './documents.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, '../../public');

const registry = new ChannelRegistry();
const hostLimiter = new RateLimiter(config.hostRateLimit);
const joinFailures = new RateLimiter(config.joinFailLimit);

/** Failed joins one connection may make before it is dropped. */
const MAX_FAILED_JOINS_PER_CONNECTION = 5;

function clientIp(req: { socket: { remoteAddress?: string }; headers: Record<string, unknown> }): string {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      return fwd.split(',')[0]!.trim();
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// --- HTTP -------------------------------------------------------------------

const server = createServer(async (req, res) => {
  securityHeaders(res);

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  // Only recognised crawlers are recorded, and only once the status is known.
  // Ordinary visitors are never logged - see crawlers.ts.
  const crawler = identifyCrawler(req.headers['user-agent']);
  if (crawler) {
    res.on('finish', () => {
      recordCrawlerVisit(crawler, req.method ?? 'GET', path, res.statusCode);
    });
  }

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      // How many shares are live is deliberately not here: to someone guessing
      // links it says when guessing is worth it. It is on the operator port.
      uptime: process.uptime(),
      crawlers: crawlerSummary(),
      usage: usageSummary(),
    }));
    return;
  }

  // A download link is just a pretty URL over the same single-page app; the
  // slug is read from the path by the client.
  if (path === '/' || path === '/index.html') {
    if (serveDocument('index.html', req, res)) return;
  }
  // The guides are plain documents; one lookup covers all of them.
  for (const slug of ['send-large-files', 'send-50gb-file', 'what-free-means']) {
    if (path === `/${slug}` || path === `/${slug}.html`) {
      if (serveDocument(`${slug}.html`, req, res)) return;
    }
  }
  if (path === '/terms' || path === '/terms.html') {
    if (serveDocument('terms.html', req, res)) return;
  }
  if (path === '/faq' || path === '/faq.html' || path === '/docs') {
    if (serveDocument('faq.html', req, res)) return;
  }
  if (/^\/d\/[^/]+$/.test(path)) {
    if (serveDocument('download.html', req, res)) return;
  }

  // Generated rather than static: both depend on PUBLIC_URL.
  if (path === '/robots.txt') {
    serveRobots(res);
    return;
  }
  if (path === '/sitemap.xml') {
    if (serveSitemap(res)) return;
  }

  if (await serveFile(PUBLIC_ROOT, path, req, res)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

// --- WebSocket signalling ---------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

/**
 * The server sees ids and sizes only; names and types are inside the sealed
 * manifest, which the recipient's browser checks and cleans up itself.
 */
function validateFiles(input: unknown): FileStub[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_FILES) return null;
  const files: FileStub[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) return null;
    const f = raw as Record<string, unknown>;
    if (typeof f['id'] !== 'string' || f['id'].length > 64) return null;
    if (typeof f['size'] !== 'number' || !Number.isFinite(f['size']) || f['size'] < 0) return null;
    if (config.maxFileSize > 0 && f['size'] > config.maxFileSize) return null;
    files.push({ id: f['id'], size: f['size'] });
  }
  return files;
}

function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SEALED_MAX
    && /^[A-Za-z0-9_-]+$/.test(value);
}

wss.on('connection', (ws: WebSocket, req) => {
  const peer: Peer = newPeer(ws);
  const ip = clientIp(req as never);

  let alive = true;
  ws.on('pong', () => { alive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return; // Signalling is JSON only; file bytes never come here.

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { t: 'error', code: 'bad-request', message: 'Malformed message.' });
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'host': {
        if (peer.slug) return; // already hosting
        if (!hostLimiter.allow(ip)) {
          send(ws, { t: 'error', code: 'rate-limited', message: 'Too many shares from this address. Wait a minute.' });
          return;
        }
        if (registry.isFull()) {
          send(ws, { t: 'error', code: 'server-full', message: 'The server is at capacity. Try again shortly.' });
          return;
        }
        const files = validateFiles(msg.files);
        const verifier = parseVerifier(msg.verifier);
        if (!files || !verifier || !isSealed(msg.sealed)) {
          send(ws, { t: 'error', code: 'bad-request', message: 'Invalid file list.' });
          return;
        }
        const password = typeof msg.password === 'string' && msg.password.length > 0
          ? msg.password.slice(0, 256)
          : undefined;
        const wanted = isValidSlug(msg.slug) ? msg.slug : undefined;
        const channel = registry.create(peer, files, msg.sealed, verifier, password, wanted);
        // A share re-registered after a dropped connection is not a new share.
        if (!wanted) recordShare();
        send(ws, {
          t: 'hosted',
          slug: channel.slug,
          peerId: peer.id,
          iceServers: config.iceServers as never,
        });
        return;
      }

      case 'join': {
        if (peer.slug) return;
        // Guessing is capped twice: per connection, so one socket cannot loop
        // through slugs, and per address, so opening new sockets does not help.
        if (peer.failedJoins >= MAX_FAILED_JOINS_PER_CONNECTION || joinFailures.exhausted(ip)) {
          send(ws, { t: 'error', code: 'rate-limited', message: 'Too many attempts. Wait a minute and reload.' });
          ws.close();
          return;
        }
        const result = isValidSlug(msg.slug)
          ? registry.join(msg.slug, msg.auth, peer, msg.password)
          : { ok: false as const, code: 'not-found' as const };
        if (!result.ok) {
          // Being asked for a password is the normal flow, not a failure.
          if (result.code !== 'password-required') {
            peer.failedJoins += 1;
            joinFailures.allow(ip);
          }
          const message = result.code === 'not-found'
            ? 'This share has expired, the sender closed their tab, or the link is incomplete.'
            : result.code === 'password-required'
              ? 'This share is password protected.'
              : result.code === 'locked'
                ? 'Too many wrong passwords. The share was closed.'
                : 'Incorrect password.';
          send(ws, { t: 'error', code: result.code, message });
          return;
        }
        const { channel } = result;
        if (msg.again !== true) recordReceive();
        send(ws, {
          t: 'joined',
          peerId: peer.id,
          uploader: channel.uploader.id,
          files: channel.files,
          sealed: channel.sealed,
          iceServers: config.iceServers as never,
        });
        send(channel.uploader.ws, { t: 'peer-join', peerId: peer.id });
        return;
      }

      case 'signal': {
        if (!peer.slug || typeof msg.to !== 'string' || !isSealed(msg.data)) return;
        const channel = registry.get(peer.slug);
        if (!channel) return;
        // Only relay between peers of the same channel.
        const target = registry.peerInChannel(channel, msg.to);
        if (!target) return;
        registry.touch(peer.slug);
        send(target.ws, { t: 'signal', from: peer.id, data: msg.data });
        return;
      }

      case 'ping': {
        if (peer.slug) registry.touch(peer.slug);
        send(ws, { t: 'pong' });
        return;
      }
    }
  });

  ws.on('close', () => registry.remove(peer));
  ws.on('error', () => registry.remove(peer));

  // Drop half-open connections so dead uploaders release their slug.
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      clearInterval(heartbeat);
      return;
    }
    alive = false;
    ws.ping();
  }, 30_000);
  ws.on('close', () => clearInterval(heartbeat));
});

// --- Operator commands -------------------------------------------------------
//
// A second listener, on loopback only, so a reported share can be ended without
// restarting the service (which would end every share). It is deliberately not
// on the public port: the tunnel forwards that one to the world. Used by
// deploy/fileshare-close.

const admin = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ channels: registry.size }));
    return;
  }
  const match = /^\/close\/([^/]+)$/.exec(req.url ?? '');
  if (req.method !== 'POST' || !match) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n');
    return;
  }
  const slug = decodeURIComponent(match[1]!);
  const closed = isValidSlug(slug) && registry.close(slug);
  // No slug in the log: the operator has it already, and the log should not
  // become a list of links.
  if (closed) console.log('[admin] a share was closed on request');
  res.writeHead(closed ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' })
    .end(closed ? 'closed\n' : 'no live share with that link\n');
});
// A clash on this port must not take the file sharing down with it.
admin.on('error', (err) => console.warn(`[aurora-fileshare] admin port unavailable: ${err.message}`));
if (config.adminPort > 0) {
  admin.listen(config.adminPort, '127.0.0.1', () => {
    console.log(`[aurora-fileshare] operator commands on http://127.0.0.1:${config.adminPort}`);
  });
}

await loadDocuments(PUBLIC_ROOT);

server.listen(config.port, config.host, () => {
  console.log(`[aurora-fileshare] listening on http://${config.host}:${config.port}`);
  console.log(`[aurora-fileshare] ICE: ${JSON.stringify(config.iceServers)}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[aurora-fileshare] ${signal} received, shutting down`);
    flushUsage();
    wss.close();
    admin.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
