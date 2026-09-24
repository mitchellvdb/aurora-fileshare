import type { RTCIceServerConfig } from '../shared/protocol.js';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * ICE servers handed to both peers at join time. STUN alone is enough for the
 * large majority of NAT pairs; when both ends sit behind symmetric NAT a TURN
 * relay is the only thing that works, so TURN_URL is left as a drop-in.
 *
 * Note that TURN cannot be tunnelled through Cloudflare Tunnel - it needs a
 * directly reachable UDP port - so enabling it means exposing coturn some
 * other way.
 */
function iceServers(): RTCIceServerConfig[] {
  const servers: RTCIceServerConfig[] = [
    { urls: env('STUN_URLS', 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302').split(',') },
  ];
  const turnUrl = process.env['TURN_URL'];
  if (turnUrl) {
    servers.push({
      urls: turnUrl.split(','),
      username: env('TURN_USERNAME', ''),
      credential: env('TURN_CREDENTIAL', ''),
    });
  }
  return servers;
}

export const config = {
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 8080),

  /** How long an idle channel survives before the server forgets it. */
  channelTtlMs: envInt('CHANNEL_TTL_MINUTES', 240) * 60_000,

  /** Ceiling on concurrently hosted channels, to bound memory. */
  maxChannels: envInt('MAX_CHANNELS', 5000),

  /** New channels allowed per IP per minute. */
  hostRateLimit: envInt('HOST_RATE_LIMIT', 20),

  /**
   * Failed joins allowed per IP per minute. With a 128-bit secret in every
   * link guessing is hopeless anyway; this keeps it from even being cheap.
   */
  joinFailLimit: envInt('JOIN_FAIL_LIMIT', 20),

  /** Advisory only - the server never sees the bytes, this just gates the UI. */
  maxFileSize: envInt('MAX_FILE_SIZE_GB', 0) * 1024 ** 3,

  /** Set when behind a reverse proxy / tunnel so we read X-Forwarded-For. */
  trustProxy: env('TRUST_PROXY', 'true') === 'true',

  publicUrl: process.env['PUBLIC_URL'] ?? '',

  /**
   * Optional "buy me a coffee" link. Any donation host works - PayPal.me,
   * Buy Me a Coffee, Ko-fi, Stripe. Left empty the button never renders, so
   * there is no half-configured dead link to click.
   */
  // Where the source lives. AGPL section 13 asks anyone running this over a
  // network to offer its source to the people using it; a footer link is how.
  sourceUrl: (process.env['SOURCE_URL'] ?? '').trim(),
  donateUrl: (process.env['DONATE_URL'] ?? '').trim(),

  /**
   * Where people report misuse, and the point of contact the EU Digital
   * Services Act asks every intermediary service to publish. Shown in the
   * footer, the FAQ and the terms.
   */
  contactEmail: (process.env['CONTACT_EMAIL'] ?? '').trim(),

  /**
   * Local-only port for operator commands (closing a reported share). Bound to
   * 127.0.0.1, never to HOST, so the tunnel cannot reach it. 0 disables it.
   */
  adminPort: envInt('ADMIN_PORT', 8081),
  donateLabel: (process.env['DONATE_LABEL'] ?? 'Buy me a coffee').trim(),

  iceServers: iceServers(),
} as const;
