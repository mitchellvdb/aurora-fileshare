import { uid } from './common.js';
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
    swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
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
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
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

  return {
    async write(chunk: ArrayBuffer) {
      // Awaiting the writer is what propagates disk backpressure all the way
      // back to the sender's data channel.
      await writer.write(new Uint8Array(chunk));
    },
    async close() {
      await writer.close();
    },
    async abort(reason: string) {
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
