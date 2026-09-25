import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { CloseCode, FileStub, PeerId, ServerMessage } from '../shared/protocol.js';
import { config } from './config.js';
import { generateSlug } from './slug.js';

export interface Peer {
  id: PeerId;
  ws: WebSocket;
  slug: string | null;
  isUploader: boolean;
  /** Failed join attempts on this connection; see index.ts. */
  failedJoins: number;
}

/** Wrong passwords a share tolerates before it closes itself. */
export const MAX_BAD_PASSWORDS = 10;

interface StoredPassword {
  salt: Buffer;
  hash: Buffer;
}

export interface Channel {
  slug: string;
  uploader: Peer;
  files: FileStub[];
  /** The encrypted manifest. Opaque here; only the browsers hold the key. */
  sealed: string;
  /** SHA-256 of the join token. The token itself is never stored. */
  verifier: Buffer;
  password: StoredPassword | null;
  badPasswords: number;
  createdAt: number;
  lastActivity: number;
  downloaders: Map<PeerId, Peer>;
}

/** Decodes base64url, or null for anything else. */
function decode(text: unknown, bytes: number): Buffer | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const buf = Buffer.from(text, 'base64url');
  return buf.length === bytes ? buf : null;
}

export function parseVerifier(text: unknown): Buffer | null {
  return decode(text, 32);
}

function tokenMatches(verifier: Buffer, auth: unknown): boolean {
  const token = decode(auth, 32);
  if (!token) return false;
  return timingSafeEqual(verifier, createHash('sha256').update(token).digest());
}

function hashPassword(password: string, salt = randomBytes(16)): StoredPassword {
  return { salt, hash: scryptSync(password, salt, 32) };
}

function passwordMatches(stored: StoredPassword, attempt: string): boolean {
  const candidate = scryptSync(attempt, stored.salt, 32);
  return timingSafeEqual(stored.hash, candidate);
}

export function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(msg));
}

export class ChannelRegistry {
  private readonly channels = new Map<string, Channel>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  get size(): number {
    return this.channels.size;
  }

  isFull(): boolean {
    return this.channels.size >= config.maxChannels;
  }

  create(
    uploader: Peer, files: FileStub[], sealed: string, verifier: Buffer, password?: string,
    wanted?: string,
  ): Channel {
    // A sender coming back after a dropped connection asks for its old slug so
    // the link it already handed out keeps working. Only if it is free: a live
    // share is never taken over.
    let slug = wanted && !this.channels.has(wanted) ? wanted : generateSlug();
    // Retry on the astronomically unlikely slug collision rather than trusting luck.
    for (let i = 0; this.channels.has(slug) && i < 10; i++) slug = generateSlug();

    const now = Date.now();
    const channel: Channel = {
      slug,
      uploader,
      files,
      sealed,
      verifier,
      password: password ? hashPassword(password) : null,
      badPasswords: 0,
      createdAt: now,
      lastActivity: now,
      downloaders: new Map(),
    };
    this.channels.set(slug, channel);
    uploader.slug = slug;
    uploader.isUploader = true;
    return channel;
  }

  get(slug: string): Channel | undefined {
    return this.channels.get(slug);
  }

  /**
   * Returns the channel, or an error code describing why the join failed.
   *
   * A wrong token answers exactly like a missing share, so probing cannot tell
   * a live slug from a dead one. The password is only looked at once the token
   * checks out: nobody without the link gets to try passwords at all, and
   * nobody gets to make the server run scrypt for free.
   */
  join(slug: string, auth: unknown, peer: Peer, password?: string):
    | { ok: true; channel: Channel }
    | { ok: false; code: 'not-found' | 'password-required' | 'bad-password' | 'locked' } {
    const channel = this.channels.get(slug);
    if (!channel || !tokenMatches(channel.verifier, auth)) return { ok: false, code: 'not-found' };

    if (channel.password) {
      if (password === undefined || password === '') {
        return { ok: false, code: 'password-required' };
      }
      if (!passwordMatches(channel.password, password)) {
        channel.badPasswords += 1;
        if (channel.badPasswords >= MAX_BAD_PASSWORDS) {
          this.end(slug, 'locked', `Someone entered a wrong password ${MAX_BAD_PASSWORDS} times, so this `
            + 'share was closed to protect it. Create a new one if you still want to send.');
          return { ok: false, code: 'locked' };
        }
        return { ok: false, code: 'bad-password' };
      }
    }

    channel.downloaders.set(peer.id, peer);
    channel.lastActivity = Date.now();
    peer.slug = slug;
    peer.isUploader = false;
    return { ok: true, channel };
  }

  /** Look up a peer in the same channel, so signalling can never cross channels. */
  peerInChannel(channel: Channel, peerId: PeerId): Peer | undefined {
    if (channel.uploader.id === peerId) return channel.uploader;
    return channel.downloaders.get(peerId);
  }

  touch(slug: string): void {
    const channel = this.channels.get(slug);
    if (channel) channel.lastActivity = Date.now();
  }

  /** Remove a peer. If it was the uploader, the whole channel dies with it. */
  remove(peer: Peer): void {
    if (!peer.slug) return;
    const channel = this.channels.get(peer.slug);
    if (!channel) return;

    if (peer.isUploader) {
      // All we know is that the sender's connection to us is gone. Their tab
      // may still be open, and a transfer between the browsers still running,
      // so recipients are told it is the server link that went - not that the
      // share is over. They can join again once the sender is back.
      for (const downloader of channel.downloaders.values()) {
        downloader.slug = null;
        send(downloader.ws, {
          t: 'closed', code: 'sender-left',
          reason: 'The sender lost their connection to the server.',
        });
      }
      this.channels.delete(peer.slug);
    } else {
      channel.downloaders.delete(peer.id);
      send(channel.uploader.ws, { t: 'peer-leave', peerId: peer.id });
      channel.lastActivity = Date.now();
    }
  }

  /**
   * Ends a share on the operator's say-so, after a report. Both ends are told,
   * and the recipient's page aborts any transfer in progress when it hears it.
   */
  close(slug: string): boolean {
    return this.end(slug, 'operator', 'This share was closed by the operator.');
  }

  /** Ends a share for good, telling everyone in it why. */
  private end(slug: string, code: CloseCode, reason: string): boolean {
    const channel = this.channels.get(slug);
    if (!channel) return false;
    send(channel.uploader.ws, { t: 'closed', code, reason });
    for (const d of channel.downloaders.values()) {
      d.slug = null;
      send(d.ws, { t: 'closed', code, reason });
    }
    channel.uploader.slug = null;
    this.channels.delete(slug);
    return true;
  }

  private sweep(): void {
    const cutoff = Date.now() - config.channelTtlMs;
    for (const [slug, channel] of this.channels) {
      if (channel.lastActivity < cutoff) this.end(slug, 'expired', 'This share expired.');
    }
  }
}

export function newPeer(ws: WebSocket): Peer {
  return { id: randomUUID(), ws, slug: null, isUploader: false, failedJoins: 0 };
}
