import { uid } from './common.js';
import {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  CHUNK_SIZE,
  type RTCIceServerConfig,
  type TransferMessage,
} from '../shared/protocol.js';

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

  constructor(
    private readonly dc: RTCDataChannel,
    private readonly files: Map<string, File>,
    private readonly onProgress: (p: SendProgress) => void,
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

  private drain(): Promise<void> {
    return new Promise((resolvePromise) => {
      const onLow = () => {
        this.dc.removeEventListener('bufferedamountlow', onLow);
        resolvePromise();
      };
      this.dc.addEventListener('bufferedamountlow', onLow);
    });
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

    let offset = 0;
    while (offset < file.size) {
      if (this.cancelled.has(reqId)) {
        this.cancelled.delete(reqId);
        return;
      }
      if (this.dc.readyState !== 'open') return;

      if (this.dc.bufferedAmount > BUFFER_HIGH_WATER) await this.drain();

      // Reading a slice at a time keeps peak memory at one chunk regardless of
      // how large the file is - a 50 GB file is no different from a 5 MB one.
      const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      if (this.dc.readyState !== 'open') return;
      this.dc.send(chunk);
      offset += chunk.byteLength;

      this.onProgress({ fileId, name: file.name, sent: offset, total: file.size });
    }

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

  constructor(
    private readonly dc: RTCDataChannel,
    private readonly onProgress: (d: ActiveDownload) => void,
  ) {
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
    this.onProgress(active);
  }
}

export { CHUNK_SIZE };
