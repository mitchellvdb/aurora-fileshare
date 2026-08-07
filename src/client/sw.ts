/// <reference lib="webworker" />

// `self` is already declared by the webworker lib; alias it rather than
// redeclaring it, which TypeScript rejects.
const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * Download plumbing.
 *
 * The page hands us the readable half of a TransformStream (transferred, so it
 * genuinely moves across). We park it under an id, and when the page then
 * navigates a hidden iframe to /dl/<id> we answer that request with the stream
 * plus a Content-Disposition header. The browser writes it straight to disk,
 * so a 40 GB file never has to fit in a Blob in memory.
 */

interface PendingDownload {
  stream: ReadableStream<Uint8Array>;
  name: string;
  size: number;
  mime: string;
  createdAt: number;
}

const pending = new Map<string, PendingDownload>();

/** An id nobody fetches would leak its stream, so drop stale ones. */
const STALE_MS = 60_000;

function sweep(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, entry] of pending) {
    if (entry.createdAt < cutoff) {
      void entry.stream.cancel().catch(() => undefined);
      pending.delete(id);
    }
  }
}

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as
    | { type: 'register'; id: string; name: string; size: number; mime: string; stream: ReadableStream<Uint8Array> }
    | { type: 'ping' }
    | undefined;
  if (!data) return;

  if (data.type === 'ping') {
    event.source?.postMessage({ type: 'pong' });
    return;
  }

  if (data.type === 'register') {
    sweep();
    pending.set(data.id, {
      stream: data.stream,
      name: data.name,
      size: data.size,
      mime: data.mime || 'application/octet-stream',
      createdAt: Date.now(),
    });
    event.source?.postMessage({ type: 'registered', id: data.id });
  }
});

/** RFC 6266 / 5987: an ASCII fallback plus a UTF-8 encoded form. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

sw.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;

  const match = /^\/dl\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (!match) return;

  const id = match[1] as string;
  const entry = pending.get(id);

  if (!entry) {
    event.respondWith(new Response(
      'This download is no longer available. Return to the share page and try again.',
      { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    ));
    return;
  }

  // One-shot: a stream can only be consumed once.
  pending.delete(id);

  const headers = new Headers({
    'Content-Type': entry.mime,
    'Content-Disposition': contentDisposition(entry.name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  // Giving the browser a length turns the download UI into a real progress bar.
  if (entry.size > 0) headers.set('Content-Length', String(entry.size));

  event.respondWith(new Response(entry.stream, { headers }));
});
