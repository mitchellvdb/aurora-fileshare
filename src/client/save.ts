import { uid } from './common.js';
import { RECEIVE_HIGH_WATER } from '../shared/protocol.js';
import type { ReceiveSink } from './transfer.js';

/**
 * Two ways to get bytes onto the user's disk:
 *
 *   stream - hand a ReadableStream to our service worker and let the browser
 *            write it out incrementally. Works for files larger than RAM.
 *   blob   - buffer everything and hand over an object URL at the end. Simple,
 *            universal, but the whole file has to fit in memory.
 *
 * We use "stream" whenever the page is a secure context (service workers need
 * one) and the browser can transfer streams across postMessage; otherwise we
 * quietly fall back.
 */
export type SaveMode = 'stream' | 'blob';

/** How often a streaming download pings its service worker, and how long a silence means it is gone. */
const SAVER_PING_MS = 5_000;
const SAVER_SILENCE_MS = 25_000;
const SAVER_STOPPED =
  'The browser stopped saving this file part way (its download helper was shut down). '
  + 'Please download it again.';

let swRegistration: ServiceWorkerRegistration | null = null;
let downloadFrame: HTMLIFrameElement | null = null;

function supportsTransferableStreams(): boolean {
  try {
    const ts = new TransformStream();
    const channel = new MessageChannel();
    channel.port1.postMessage(ts.readable, [ts.readable as unknown as Transferable]);
    channel.port1.close();
    channel.port2.close();
    return true;
  } catch {
    return false;
  }
}

export async function initSaver(): Promise<SaveMode> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return 'blob';
  if (!supportsTransferableStreams()) return 'blob';

  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      // Bypass the HTTP cache when checking for a new worker. The origin sends
      // no-cache, but a CDN in front can pin sw.js to its own TTL (Cloudflare
      // defaults to four hours), which would strand users on an old worker.
      updateViaCache: 'none',
    });
    await navigator.serviceWorker.ready;
    // A freshly installed worker does not control this page until it claims it.
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 3000);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          clearTimeout(timer);
          resolvePromise();
        }, { once: true });
      });
    }
    return navigator.serviceWorker.controller ? 'stream' : 'blob';
  } catch {
    return 'blob';
  }
}

function triggerDownload(url: string): void {
  // An iframe keeps the current page alive; a top-level navigation would tear
  // down the WebRTC connection mid-transfer.
  if (!downloadFrame) {
    downloadFrame = document.createElement('iframe');
    downloadFrame.hidden = true;
    downloadFrame.setAttribute('aria-hidden', 'true');
    document.body.append(downloadFrame);
  }
  downloadFrame.src = url;
}

function saveBlobParts(parts: BlobPart[], name: string, mime: string): void {
  const blob = new Blob(parts, { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start reading before we revoke.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function createStreamSink(name: string, size: number, mime: string): Promise<ReceiveSink> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) throw new Error('No service worker controller.');

  const id = uid();
  // Both halves need a real window. A stream defaults to holding one chunk,
  // and this one is transferred to the service worker, so that default makes
  // every chunk wait for a page-to-worker round trip before the next can be
  // accepted - which caps throughput at one chunk per round trip no matter how
  // fast the network is. Sizing the queues in bytes lets chunks keep arriving
  // while the worker drains them, and still bounds what we hold in memory.
  const backpressure = () => new ByteLengthQueuingStrategy({ highWaterMark: RECEIVE_HIGH_WATER });
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    backpressure(),
    backpressure(),
  );
  const writer = writable.getWriter();

  const acknowledged = new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('Service worker did not respond.')), 5000);
    const onMessage = (ev: MessageEvent) => {
      if ((ev.data as { type?: string; id?: string })?.type === 'registered'
        && (ev.data as { id?: string }).id === id) {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', onMessage);
        resolvePromise();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
  });

  controller.postMessage(
    { type: 'register', id, name, size, mime, stream: readable },
    [readable as unknown as Transferable],
  );
  await acknowledged;

  triggerDownload(`/dl/${id}`);

  // Keep the worker alive, and notice if it went anyway. Chrome stops a
  // service worker it thinks is idle; the download it was serving then just
  // ends (a 3 GB file "finished" at about 600 MB), while every further write
  // here would wait forever. A ping every few seconds counts as activity and
  // asks about this download by id - a restarted worker no longer knows it.
  let dead: Error | null = null;
  let markDead: (e: Error) => void = () => undefined;
  const died = new Promise<never>((_, reject) => {
    markDead = (e) => { if (!dead) { dead = e; reject(e); } };
  });
  died.catch(() => undefined);
  let lastAlive = Date.now();
  const onPong = (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; id?: string; alive?: boolean };
    if (msg?.type !== 'pong') return;
    // A worker from before this change answers without an id. It is alive and
    // still the one serving the stream (it gets replaced on the next visit),
    // so count it rather than mistake the silence for a stopped download.
    if (msg.id === undefined) { lastAlive = Date.now(); return; }
    if (msg.id !== id) return;
    if (msg.alive) lastAlive = Date.now();
    else markDead(new Error(SAVER_STOPPED));
  };
  navigator.serviceWorker.addEventListener('message', onPong);
  const keepAlive = window.setInterval(() => {
    if (Date.now() - lastAlive > SAVER_SILENCE_MS) {
      markDead(new Error(SAVER_STOPPED));
      return;
    }
    navigator.serviceWorker.controller?.postMessage({ type: 'ping', id });
  }, SAVER_PING_MS);
  const stop = () => {
    window.clearInterval(keepAlive);
    navigator.serviceWorker.removeEventListener('message', onPong);
  };

  return {
    async write(chunk: ArrayBuffer) {
      if (dead) throw dead;
      // Awaiting the writer is what propagates disk backpressure all the way
      // back to the sender's data channel - and racing it against the worker
      // dying is what stops a dead download from hanging the page.
      await Promise.race([writer.write(new Uint8Array(chunk)), died]);
    },
    async close() {
      stop();
      if (dead) throw dead;
      await Promise.race([writer.close(), died]);
    },
    async abort(reason: string) {
      stop();
      await writer.abort(new Error(reason)).catch(() => undefined);
    },
  };
}

function createBlobSink(name: string, mime: string): ReceiveSink {
  const parts: BlobPart[] = [];
  let aborted = false;
  return {
    write(chunk: ArrayBuffer) {
      if (!aborted) parts.push(chunk);
    },
    close() {
      if (!aborted) saveBlobParts(parts, name, mime);
      parts.length = 0;
    },
    abort() {
      aborted = true;
      parts.length = 0;
    },
  };
}

export async function createSink(
  mode: SaveMode,
  name: string,
  size: number,
  mime: string,
): Promise<ReceiveSink> {
  if (mode === 'stream') {
    try {
      return await createStreamSink(name, size, mime);
    } catch {
      // Never fail a download just because the worker misbehaved.
      return createBlobSink(name, mime);
    }
  }
  return createBlobSink(name, mime);
}

export function unregisterSaver(): void {
  void swRegistration?.unregister().catch(() => undefined);
}
