import { uid } from './common.js';
import type { SendStats } from './diagnostics.js';
import {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  PROGRESS_INTERVAL_MS,
  READ_BLOCK_SIZE,
  type RTCIceServerConfig,
  type TransferMessage,
} from '../shared/protocol.js';

/**
 * Rate-limits a callback. Progress fires once per message, which at full speed
 * is thousands of times a second; every one of those drives a style write and a
 * layout in the UI, which competes with the transfer for the main thread. The
 * caller reports every message, we forward a sample.
 */
function throttle<T>(intervalMs: number, fn: (value: T) => void): (value: T) => void {
  let last = 0;
  return (value: T) => {
    const now = performance.now();
    if (now - last < intervalMs) return;
    last = now;
    fn(value);
  };
}

/**
 * Wraps RTCPeerConnection with the bookkeeping every WebRTC app ends up
 * needing: queueing ICE candidates that arrive before the remote description,
 * and funnelling all signalling through one callback.
 */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteReady = false;

  constructor(
    iceServers: RTCIceServerConfig[],
    private readonly sendSignal: (data: unknown) => void,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: iceServers as RTCIceServer[],
      // Trickle everything; we are not trying to be clever about candidate pools.
      iceCandidatePoolSize: 0,
    });

    this.pc.addEventListener('icecandidate', (ev) => {
      if (ev.candidate) this.sendSignal({ candidate: ev.candidate.toJSON() });
    });
  }

  async handleSignal(data: unknown): Promise<void> {
    if (typeof data !== 'object' || data === null) return;
    const payload = data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

    if (payload.sdp) {
      await this.pc.setRemoteDescription(payload.sdp);
      this.remoteReady = true;
      for (const candidate of this.pendingCandidates.splice(0)) {
        await this.pc.addIceCandidate(candidate).catch(() => undefined);
      }
      if (payload.sdp.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal({ sdp: this.pc.localDescription?.toJSON() });
      }
      return;
    }

    if (payload.candidate) {
      // Candidates can legitimately beat the offer/answer to the wire.
      if (!this.remoteReady) this.pendingCandidates.push(payload.candidate);
      else await this.pc.addIceCandidate(payload.candidate).catch(() => undefined);
    }
  }

  async createOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ sdp: this.pc.localDescription?.toJSON() });
  }

  close(): void {
    this.pc.close();
  }
}

// --- Sending ----------------------------------------------------------------

export interface SendProgress {
  fileId: string;
  name: string;
  sent: number;
  total: number;
}

/**
 * Streams files down one data channel, one at a time, respecting the channel's
 * send buffer so a fast disk cannot outrun a slow network and blow up memory.
 */
export class FileSender {
  private queue: Promise<void> = Promise.resolve();
  private readonly cancelled = new Set<string>();

  /**
   * Sampled while sending so we can tell afterwards whether we were the
   * bottleneck or the network was. See diagnostics.ts.
   */
  private sends = 0;
  private starvedSends = 0;
  private lastStats: SendStats | null = null;

  /** Stats for the most recently completed file, if any. */
  get lastTransfer(): SendStats | null {
    return this.lastStats;
  }

  constructor(
    private readonly dc: RTCDataChannel,
    private readonly files: Map<string, File>,
    private readonly onProgress: (p: SendProgress) => void,
    private readonly pc?: RTCPeerConnection,
  ) {
    this.dc.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    this.dc.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: TransferMessage;
      try {
        msg = JSON.parse(ev.data) as TransferMessage;
      } catch {
        return;
      }
      if (msg.t === 'req') this.enqueue(msg.reqId, msg.fileId);
      else if (msg.t === 'cancel') this.cancelled.add(msg.reqId);
    });
  }

  private enqueue(reqId: string, fileId: string): void {
    this.queue = this.queue.then(() => this.sendFile(reqId, fileId)).catch((err) => {
      this.reply({ t: 'deny', reqId, reason: String(err) });
    });
  }

  private reply(msg: TransferMessage): void {
    if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  /** Resolves once the send buffer has room again - or the channel goes away,
   *  which would otherwise wedge the send queue for every later file. */
  private drain(): Promise<void> {
    return new Promise((resolvePromise) => {
      const done = () => {
        this.dc.removeEventListener('bufferedamountlow', done);
        this.dc.removeEventListener('close', done);
        this.dc.removeEventListener('error', done);
        resolvePromise();
      };
      this.dc.addEventListener('bufferedamountlow', done);
      this.dc.addEventListener('close', done);
      this.dc.addEventListener('error', done);
    });
  }

  /**
   * Largest message this pair actually agreed on. Going over it makes send()
   * throw and takes the channel down with it, so read the negotiated value
   * where the browser exposes it and only fall back to the universally
   * supported size when it does not.
   */
  private chunkSize(): number {
    const negotiated = this.pc?.sctp?.maxMessageSize ?? 0;
    if (!negotiated || !Number.isFinite(negotiated)) return CHUNK_SIZE;
    return Math.max(MIN_CHUNK_SIZE, Math.min(CHUNK_SIZE, negotiated));
  }

  /** One disk read. Kept separate so the caller can start the next one early. */
  private readBlock(file: File, start: number): Promise<ArrayBuffer> {
    return file.slice(start, Math.min(start + READ_BLOCK_SIZE, file.size)).arrayBuffer();
  }

  private async sendFile(reqId: string, fileId: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) {
      this.reply({ t: 'deny', reqId, reason: 'File is no longer available.' });
      return;
    }

    this.reply({
      t: 'begin', reqId, fileId,
      name: file.name, size: file.size, type: file.type,
    });

    const chunkSize = this.chunkSize();
    const report = throttle(PROGRESS_INTERVAL_MS, this.onProgress);
    const startedAt = performance.now();
    this.sends = 0;
    this.starvedSends = 0;

    // Keep one block's read in flight while the previous block goes out, so
    // disk latency overlaps the network rather than adding to it. Reading a
    // block at a time - instead of a message at a time - also means peak
    // memory stays flat no matter how large the file is.
    let offset = 0;
    let inFlight: Promise<ArrayBuffer> | null =
      file.size > 0 ? this.readBlock(file, 0) : null;

    while (inFlight) {
      const block = new Uint8Array(await inFlight);
      const blockStart = offset;
      const nextStart = blockStart + block.byteLength;
      inFlight = nextStart < file.size ? this.readBlock(file, nextStart) : null;
      if (block.byteLength === 0) break;

      for (let start = 0; start < block.byteLength; start += chunkSize) {
        if (this.cancelled.has(reqId)) {
          this.cancelled.delete(reqId);
          return;
        }
        if (this.dc.readyState !== 'open') return;

        if (this.dc.bufferedAmount > BUFFER_HIGH_WATER) {
          await this.drain();
          if (this.dc.readyState !== 'open') return;
        }

        const end = Math.min(start + chunkSize, block.byteLength);
        // A near-empty outgoing buffer at this point means we are failing to
        // keep the channel fed, i.e. the limit is here and not on the wire.
        this.sends++;
        if (this.dc.bufferedAmount < chunkSize) this.starvedSends++;
        // send() copies, so handing it a view into the block is safe and saves
        // allocating a fresh buffer per message.
        this.dc.send(block.subarray(start, end));
        offset = blockStart + end;
        report({ fileId, name: file.name, sent: offset, total: file.size });
      }
    }

    const seconds = (performance.now() - startedAt) / 1000;
    this.lastStats = {
      bytes: file.size,
      seconds,
      bytesPerSecond: seconds > 0 ? file.size / seconds : 0,
      starvedPercent: this.sends > 0 ? Math.round((this.starvedSends / this.sends) * 100) : 0,
    };

    // The throttle may have swallowed the last sample; completion must land.
    this.onProgress({ fileId, name: file.name, sent: file.size, total: file.size });
    this.reply({ t: 'end', reqId });
  }
}

// --- Receiving --------------------------------------------------------------

export interface ReceiveSink {
  write(chunk: ArrayBuffer): Promise<void> | void;
  close(): Promise<void> | void;
  abort(reason: string): Promise<void> | void;
}

export interface ActiveDownload {
  reqId: string;
  fileId: string;
  name: string;
  size: number;
  received: number;
  sink: ReceiveSink;
}

/**
 * Consumes one data channel. Binary messages always belong to the transfer
 * announced by the most recent "begin", because the sender serialises them.
 */
export class FileReceiver {
  private active: ActiveDownload | null = null;
  private pendingSinks = new Map<string, { sink: ReceiveSink; resolve: () => void; reject: (e: Error) => void }>();

  /**
   * Message events fire independently of our async handling, so every message
   * is appended to this chain. Without it a slow disk write could let the next
   * chunk overtake the one before it and corrupt the file.
   */
  private chain: Promise<void> = Promise.resolve();

  /** Sampled progress. Completion is reported separately and always fires. */
  private readonly report: (d: ActiveDownload) => void;

  constructor(
    private readonly dc: RTCDataChannel,
    private readonly onProgress: (d: ActiveDownload) => void,
  ) {
    this.report = throttle(PROGRESS_INTERVAL_MS, onProgress);
    this.dc.binaryType = 'arraybuffer';
    this.dc.addEventListener('message', (ev) => {
      this.chain = this.chain.then(() => this.handleMessage(ev)).catch(() => undefined);
    });
  }

  /** Requests a file and resolves once the last byte has been written. */
  request(fileId: string, sink: ReceiveSink): Promise<void> {
    const reqId = uid();
    return new Promise<void>((resolvePromise, rejectPromise) => {
      this.pendingSinks.set(reqId, { sink, resolve: resolvePromise, reject: rejectPromise });
      this.dc.send(JSON.stringify({ t: 'req', reqId, fileId } satisfies TransferMessage));
    });
  }

  cancel(reqId: string): void {
    if (this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify({ t: 'cancel', reqId } satisfies TransferMessage));
    }
    const pending = this.pendingSinks.get(reqId);
    if (pending) {
      void pending.sink.abort('Cancelled.');
      pending.reject(new Error('Cancelled.'));
      this.pendingSinks.delete(reqId);
    }
    if (this.active?.reqId === reqId) this.active = null;
  }

  /** Called when the peer connection drops mid-transfer. */
  failAll(reason: string): void {
    if (this.active) {
      void this.active.sink.abort(reason);
      this.active = null;
    }
    for (const [, pending] of this.pendingSinks) pending.reject(new Error(reason));
    this.pendingSinks.clear();
  }

  private async handleMessage(ev: MessageEvent): Promise<void> {
    if (typeof ev.data === 'string') {
      let msg: TransferMessage;
      try {
        msg = JSON.parse(ev.data) as TransferMessage;
      } catch {
        return;
      }

      if (msg.t === 'begin') {
        const pending = this.pendingSinks.get(msg.reqId);
        if (!pending) return;
        this.active = {
          reqId: msg.reqId, fileId: msg.fileId, name: msg.name,
          size: msg.size, received: 0, sink: pending.sink,
        };
        this.onProgress(this.active);
        return;
      }

      if (msg.t === 'end') {
        const pending = this.pendingSinks.get(msg.reqId);
        if (!pending || !this.active || this.active.reqId !== msg.reqId) return;
        await this.active.sink.close();
        this.onProgress(this.active);
        this.pendingSinks.delete(msg.reqId);
        this.active = null;
        pending.resolve();
        return;
      }

      if (msg.t === 'deny') {
        const pending = this.pendingSinks.get(msg.reqId);
        if (!pending) return;
        void pending.sink.abort(msg.reason);
        this.pendingSinks.delete(msg.reqId);
        if (this.active?.reqId === msg.reqId) this.active = null;
        pending.reject(new Error(msg.reason));
      }
      return;
    }

    // Binary: a chunk of the transfer currently in flight.
    const active = this.active;
    if (!active) return;
    const chunk = ev.data as ArrayBuffer;
    await active.sink.write(chunk);
    active.received += chunk.byteLength;
    this.report(active);
  }
}

export { CHUNK_SIZE };
