import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

// --- DOM helpers ------------------------------------------------------------

export function $<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// --- Formatting -------------------------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[i]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Smoothed throughput, so the rate readout does not flicker on every chunk. */
export class RateMeter {
  private lastBytes = 0;
  private lastTime = performance.now();
  private smoothed = 0;

  update(totalBytes: number): number {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    if (dt < 0.25) return this.smoothed;
    const instant = (totalBytes - this.lastBytes) / dt;
    this.smoothed = this.smoothed === 0 ? instant : this.smoothed * 0.7 + instant * 0.3;
    this.lastBytes = totalBytes;
    this.lastTime = now;
    return this.smoothed;
  }
}

// --- Signalling socket ------------------------------------------------------

export type ServerHandler = (msg: ServerMessage) => void;

/**
 * The WebSocket to our server, which only ever carries signalling.
 *
 * Losing it must not end a transfer: once two browsers are connected the file
 * flows between them directly and the server is not involved. So a dropped
 * socket is not reported as the share ending. It is reported as "down", the
 * socket is reopened with growing pauses, and "up" tells the page to
 * re-register (sender) or rejoin (recipient) - which is also what keeps a
 * server restart from breaking anything.
 */
export class Signaling {
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<ServerHandler>();
  private readonly downHandlers = new Set<() => void>();
  private readonly upHandlers = new Set<() => void>();
  private keepAlive: number | undefined;
  private closedByUs = false;
  private retry = 0;
  private retryTimer: number | undefined;

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** The socket dropped; a reconnect is already scheduled. */
  onDown(handler: () => void): void {
    this.downHandlers.add(handler);
  }

  /** The socket came back after a drop. Not called for the first connect. */
  onUp(handler: () => void): void {
    this.upHandlers.add(handler);
  }

  private reconnect(): void {
    if (this.closedByUs) return;
    // 1, 2, 4, 8, then every 15 seconds.
    const delay = Math.min(15_000, 1000 * 2 ** this.retry);
    this.retry += 1;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.open().then(() => {
        this.retry = 0;
        for (const handler of this.upHandlers) handler();
      }, () => this.reconnect());
    }, delay);
  }

  connect(): Promise<void> {
    return this.open();
  }

  private open(): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${scheme}//${location.host}/ws`);
      this.ws = ws;
      let opened = false;

      ws.addEventListener('open', () => {
        opened = true;
        // Keeps the channel marked active and holds idle proxies open.
        window.clearInterval(this.keepAlive);
        this.keepAlive = window.setInterval(() => this.send({ t: 'ping' }), 45_000);
        resolvePromise();
      });

      ws.addEventListener('message', (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        for (const handler of this.handlers) handler(msg);
      });

      ws.addEventListener('error', () => {
        if (!opened) rejectPromise(new Error('Could not reach the server.'));
      });

      ws.addEventListener('close', () => {
        // A socket that never opened is the caller's failure to handle.
        if (!opened || this.ws !== ws) return;
        window.clearInterval(this.keepAlive);
        if (this.closedByUs) return;
        for (const handler of this.downHandlers) handler();
        this.reconnect();
      });
    });
  }

  on(handler: ServerHandler): void {
    this.handlers.add(handler);
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUs = true;
    window.clearInterval(this.keepAlive);
    window.clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}

// --- Misc -------------------------------------------------------------------

/**
 * A v4 UUID.
 *
 * crypto.randomUUID() only exists in secure contexts, so it is absent over
 * plain HTTP on anything other than localhost - which is exactly how this app
 * gets reached on a LAN, before any TLS is in front of it. crypto.getRandomValues
 * has no such restriction, so fall back to building the UUID by hand.
 *
 * The format matters beyond aesthetics: the service worker matches download
 * ids against a 36-character UUID pattern.
 */
export function uid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;   // version 4
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;   // variant 1
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i] as number).toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
