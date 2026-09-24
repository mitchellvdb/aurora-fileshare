import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { FileMeta, PeerId, ServerMessage } from '../shared/protocol.js';
import { config } from './config.js';
import { generateSlug } from './slug.js';

export interface Peer {
  id: PeerId;
  ws: WebSocket;
  slug: string | null;
  isUploader: boolean;
}

interface StoredPassword {
  salt: Buffer;
  hash: Buffer;
}

export interface Channel {
  slug: string;
  uploader: Peer;
  files: FileMeta[];
  password: StoredPassword | null;
  createdAt: number;
  lastActivity: number;
  downloaders: Map<PeerId, Peer>;
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

  create(uploader: Peer, files: FileMeta[], password?: string): Channel {
    // Retry on the astronomically unlikely slug collision rather than trusting luck.
    let slug = generateSlug();
    for (let i = 0; this.channels.has(slug) && i < 10; i++) slug = generateSlug();

    const now = Date.now();
    const channel: Channel = {
      slug,
      uploader,
      files,
      password: password ? hashPassword(password) : null,
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

  /** Returns the channel, or an error code describing why the join failed. */
  join(slug: string, peer: Peer, password?: string):
    | { ok: true; channel: Channel }
    | { ok: false; code: 'not-found' | 'password-required' | 'bad-password' } {
    const channel = this.channels.get(slug);
    if (!channel) return { ok: false, code: 'not-found' };

    if (channel.password) {
      if (password === undefined || password === '') {
        return { ok: false, code: 'password-required' };
      }
      if (!passwordMatches(channel.password, password)) {
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
      for (const downloader of channel.downloaders.values()) {
        send(downloader.ws, { t: 'closed', reason: 'The sender closed their tab.' });
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
    const channel = this.channels.get(slug);
    if (!channel) return false;
    const reason = 'This share was closed by the operator.';
    send(channel.uploader.ws, { t: 'closed', reason });
    for (const d of channel.downloaders.values()) send(d.ws, { t: 'closed', reason });
    this.channels.delete(slug);
    return true;
  }

  private sweep(): void {
    const cutoff = Date.now() - config.channelTtlMs;
    for (const [slug, channel] of this.channels) {
      if (channel.lastActivity < cutoff) {
        send(channel.uploader.ws, { t: 'closed', reason: 'This share expired.' });
        for (const d of channel.downloaders.values()) {
          send(d.ws, { t: 'closed', reason: 'This share expired.' });
        }
        this.channels.delete(slug);
      }
    }
  }
}

export function newPeer(ws: WebSocket): Peer {
  return { id: randomUUID(), ws, slug: null, isUploader: false };
}
