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

export class Signaling {
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<ServerHandler>();
  private keepAlive: number | undefined;
  private closedByUs = false;

  connect(): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${scheme}//${location.host}/ws`);
      this.ws = ws;

      ws.addEventListener('open', () => {
        // Keeps the channel marked active and holds idle proxies open.
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

      ws.addEventListener('error', () => rejectPromise(new Error('Could not reach the server.')));

      ws.addEventListener('close', () => {
        window.clearInterval(this.keepAlive);
        if (!this.closedByUs) {
          for (const handler of this.handlers) {
            handler({ t: 'closed', reason: 'Connection to the server was lost.' });
          }
        }
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
    this.ws?.close();
  }
}

// --- Misc -------------------------------------------------------------------

export function uid(): string {
  return crypto.randomUUID();
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
