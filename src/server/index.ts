import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { ClientMessage, FileMeta } from '../shared/protocol.js';
import { MAX_FILES } from '../shared/protocol.js';
import { config } from './config.js';
import { ChannelRegistry, newPeer, send, type Peer } from './channels.js';
import { RateLimiter } from './rate-limit.js';
import { isValidSlug } from './slug.js';
import { securityHeaders, serveFile } from './static.js';
import {
  loadDocuments, serveDocument, serveRobots, serveSitemap,
} from './documents.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, '../../public');

const registry = new ChannelRegistry();
const hostLimiter = new RateLimiter(config.hostRateLimit);

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

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, channels: registry.size, uptime: process.uptime() }));
    return;
  }

  // A download link is just a pretty URL over the same single-page app; the
  // slug is read from the path by the client.
  if (path === '/' || path === '/index.html') {
    if (serveDocument('index.html', req, res)) return;
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

function validateFiles(input: unknown): FileMeta[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_FILES) return null;
  const files: FileMeta[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) return null;
    const f = raw as Record<string, unknown>;
    if (typeof f['id'] !== 'string' || f['id'].length > 64) return null;
    if (typeof f['name'] !== 'string' || f['name'].length === 0 || f['name'].length > 512) return null;
    if (typeof f['size'] !== 'number' || !Number.isFinite(f['size']) || f['size'] < 0) return null;
    if (config.maxFileSize > 0 && f['size'] > config.maxFileSize) return null;
    files.push({
      id: f['id'],
      // Strip path separators so a crafted name cannot influence the save path.
      name: f['name'].replace(/[/\\]/g, '_'),
      size: f['size'],
      type: typeof f['type'] === 'string' ? f['type'].slice(0, 128) : '',
    });
  }
  return files;
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
        if (!files) {
          send(ws, { t: 'error', code: 'bad-request', message: 'Invalid file list.' });
          return;
        }
        const password = typeof msg.password === 'string' && msg.password.length > 0
          ? msg.password.slice(0, 256)
          : undefined;
        const channel = registry.create(peer, files, password);
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
        if (!isValidSlug(msg.slug)) {
          send(ws, { t: 'error', code: 'not-found', message: 'That link does not look right.' });
          return;
        }
        const result = registry.join(msg.slug, peer, msg.password);
        if (!result.ok) {
          const message = result.code === 'not-found'
            ? 'This share has expired or the sender closed their tab.'
            : result.code === 'password-required'
              ? 'This share is password protected.'
              : 'Incorrect password.';
          send(ws, { t: 'error', code: result.code, message });
          return;
        }
        const { channel } = result;
        send(ws, {
          t: 'joined',
          peerId: peer.id,
          uploader: channel.uploader.id,
          files: channel.files,
          iceServers: config.iceServers as never,
        });
        send(channel.uploader.ws, { t: 'peer-join', peerId: peer.id });
        return;
      }

      case 'signal': {
        if (!peer.slug || typeof msg.to !== 'string') return;
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

await loadDocuments(PUBLIC_ROOT);

server.listen(config.port, config.host, () => {
  console.log(`[aurora-fileshare] listening on http://${config.host}:${config.port}`);
  console.log(`[aurora-fileshare] ICE: ${JSON.stringify(config.iceServers)}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[aurora-fileshare] ${signal} received, shutting down`);
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
