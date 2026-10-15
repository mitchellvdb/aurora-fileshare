import { uid } from './common.js';
import { Crc32, CRC_INITIAL } from './crc32.js';
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

/**
 * The sender's running checksum of one file, kept outside FileSender because
 * a reconnect gets a new channel and a new FileSender, and the resumed
 * transfer has to pick the checksum up where the old one stopped. `at` maps
 * byte offsets to the CRC register there, for the most recent chunks only:
 * a resume lands at most a send buffer behind what was sent.
 */
export interface SendChecksum {
  at: Map<number, number>;
}
export type SendChecksums = Map<string, SendChecksum>;
const CHECKPOINTS_KEPT = 512; // 512 x 256 KiB = the last 128 MiB of every file

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
    private readonly checksums: SendChecksums = new Map(),
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
      if (msg.t === 'req') this.enqueue(msg.reqId, msg.fileId, msg.from ?? 0, msg.crc);
      else if (msg.t === 'cancel') this.cancelled.add(msg.reqId);
    });
  }

  /** Tells the other side nothing will resume. Best effort: the tab is closing. */
  sayBye(): void {
    this.reply({ t: 'bye' });
  }

  private enqueue(reqId: string, fileId: string, from: number, crc?: number): void {
    this.queue = this.queue.then(() => this.sendFile(reqId, fileId, from, crc)).catch((err) => {
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
   * Waits until the channel has actually handed everything to the network.
   *
   * send() only queues, so without this a file smaller than the outgoing
   * buffer looks instantaneous and the reported rate is nonsense - it would be
   * measuring how fast we can fill a buffer, not how fast the link drains it.
   */
  private flush(): Promise<void> {
    if (this.dc.bufferedAmount === 0 || this.dc.readyState !== 'open') {
      return Promise.resolve();
    }
    const previous = this.dc.bufferedAmountLowThreshold;
    this.dc.bufferedAmountLowThreshold = 0;
    return new Promise((resolvePromise) => {
      const done = () => {
        this.dc.removeEventListener('bufferedamountlow', done);
        this.dc.removeEventListener('close', done);
        this.dc.removeEventListener('error', done);
        this.dc.bufferedAmountLowThreshold = previous;
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
  private readBlock(file: File, start: number, end = Math.min(start + READ_BLOCK_SIZE, file.size)): Promise<ArrayBuffer> {
    return file.slice(start, end).arrayBuffer();
  }

  /**
   * Streams one file from byte `from`. A non-zero start is a resume: the
   * connection dropped part way and the recipient already has everything
   * before that byte, so there is no reason to send it again.
   */
  /**
   * The CRC register at `from`: from the checkpoints when this sender sent
   * those bytes itself, otherwise by reading the file's first `from` bytes
   * again. The second is slow on a large file but only happens when a resume
   * lands outside the window the checkpoints keep.
   */
  private async registerAt(file: File, fileId: string, from: number): Promise<number> {
    if (from === 0) return CRC_INITIAL;
    const known = this.checksums.get(fileId)?.at.get(from);
    if (known !== undefined) return known;
    const crc = new Crc32();
    for (let pos = 0; pos < from; pos += READ_BLOCK_SIZE) {
      crc.update(new Uint8Array(await this.readBlock(file, pos, Math.min(pos + READ_BLOCK_SIZE, from))));
    }
    return crc.state;
  }

  private async sendFile(reqId: string, fileId: string, from: number, theirCrc?: number): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) {
      this.reply({ t: 'deny', reqId, reason: 'File is no longer available.' });
      return;
    }
    if (!Number.isSafeInteger(from) || from < 0 || from > file.size) {
      this.reply({ t: 'deny', reqId, reason: 'Invalid resume position.' });
      return;
    }

    // On a resume, both sides must agree on the bytes already delivered before
    // anything is added to them. If they do not, continuing would only finish
    // a file that is already wrong.
    const crc = new Crc32(await this.registerAt(file, fileId, from));
    if (from > 0 && theirCrc !== undefined && crc.value !== theirCrc) {
      console.warn(`[fileshare] resume refused: the first ${from} bytes differ on the two sides`);
      this.reply({
        t: 'deny', reqId, code: 'mismatch',
        reason: 'The part already received does not match the original, so the transfer could not continue.',
      });
      return;
    }
    let ledger = this.checksums.get(fileId);
    if (!ledger || from === 0) {
      ledger = { at: new Map() };
      this.checksums.set(fileId, ledger);
    }
    ledger.at.set(from, crc.state);

    this.reply({
      t: 'begin', reqId, fileId,
      name: file.name, size: file.size, type: file.type, from,
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
    let offset = from;
    let inFlight: Promise<ArrayBuffer> | null =
      from < file.size ? this.readBlock(file, from) : null;

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
        const piece = block.subarray(start, end);
        this.dc.send(piece);
        crc.update(piece);
        offset = blockStart + end;
        ledger.at.set(offset, crc.state);
        if (ledger.at.size > CHECKPOINTS_KEPT) ledger.at.delete(ledger.at.keys().next().value!);
        report({ fileId, name: file.name, sent: offset, total: file.size });
      }
    }

    // Everything is queued; the transfer is not finished until it is drained.
    await this.flush();
    const seconds = (performance.now() - startedAt) / 1000;
    const bytes = file.size - from;
    this.lastStats = {
      bytes,
      seconds,
      bytesPerSecond: seconds > 0 ? bytes / seconds : 0,
      starvedPercent: this.sends > 0 ? Math.round((this.starvedSends / this.sends) * 100) : 0,
      messageBytes: chunkSize,
    };

    // The throttle may have swallowed the last sample; completion must land.
    this.onProgress({ fileId, name: file.name, sent: file.size, total: file.size });
    this.reply({ t: 'end', reqId, crc: crc.value });
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

/** One requested file. Survives a dropped connection; see FileReceiver. */
interface Request extends ActiveDownload {
  /** Set once the sender's "begin" for the current reqId has arrived. */
  started: boolean;
  /** CRC-32 of exactly the bytes that reached the sink, in order. */
  crc: Crc32;
  resolve: () => void;
  reject: (e: Error) => void;
}

/**
 * Receives files over a data channel - and, when that channel dies part way,
 * over the next one.
 *
 * The request in progress outlives its channel: its sink stays open and its
 * byte count stays put. When a new channel is attached, the receiver asks the
 * sender to continue from the first byte it does not have. Only bytes that
 * reached the sink are counted, so whatever was still in flight on the old
 * channel is simply asked for again: no gap, no duplicate.
 */
export class FileReceiver {
  private dc: RTCDataChannel | null = null;
  private current: Request | null = null;

  /**
   * Message events fire independently of our async handling, so every message
   * is appended to this chain. Without it a slow disk write could let the next
   * chunk overtake the one before it and corrupt the file.
   */
  private chain: Promise<void> = Promise.resolve();

  /** Sampled progress. Completion is reported separately and always fires. */
  private readonly report: (d: ActiveDownload) => void;

  /** The sender said it is closing its tab; nothing will resume. */
  onBye: (() => void) | null = null;

  /**
   * A request went out and no "begin" came back in time. Seen in testing: a
   * resume where both sides reported the new connection as open, yet the
   * transfer never restarted and nothing would ever have said so. The page
   * treats this as a lost connection and builds a new one.
   */
  onStall: (() => void) | null = null;
  private watchdog: number | undefined;
  static readonly STALL_MS = 20_000;

  private armWatchdog(reqId: string): void {
    window.clearTimeout(this.watchdog);
    this.watchdog = window.setTimeout(() => {
      const req = this.current;
      if (req && req.reqId === reqId && !req.started) {
        console.warn(`[fileshare] no answer to request ${reqId} after ${FileReceiver.STALL_MS / 1000}s`);
        this.onStall?.();
      }
    }, FileReceiver.STALL_MS);
  }

  constructor(private readonly onProgress: (d: ActiveDownload) => void) {
    this.report = throttle(PROGRESS_INTERVAL_MS, onProgress);
  }

  /** Where an interrupted transfer stands, or null when nothing is pending. */
  get pending(): ActiveDownload | null {
    return this.current;
  }

  /** Takes an open channel into use, resuming whatever the last one left. */
  attach(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.addEventListener('message', (ev) => {
      this.chain = this.chain.then(() => this.handleMessage(dc, ev)).catch(() => undefined);
    });
    // Behind the chain, so every write already under way has landed and
    // `received` is exact before we say where to continue from.
    this.chain = this.chain.then(() => {
      const req = this.current;
      if (!req || this.dc !== dc) return;
      req.reqId = uid();
      req.started = false;
      console.info(`[fileshare] resuming ${req.name || req.fileId} from byte ${req.received}`);
      this.send({ t: 'req', reqId: req.reqId, fileId: req.fileId, from: req.received, crc: req.crc.value });
      this.armWatchdog(req.reqId);
    });
  }

  /** The channel is gone. The request in progress waits for the next one. */
  detach(): void {
    this.dc = null;
  }

  /** Requests a file and resolves once the last byte has been written. */
  request(fileId: string, sink: ReceiveSink): Promise<void> {
    if (this.current) return Promise.reject(new Error('A transfer is already running.'));
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const reqId = uid();
      this.current = {
        reqId, fileId, sink, name: '', size: 0, received: 0, started: false, crc: new Crc32(),
        resolve: resolvePromise, reject: rejectPromise,
      };
      this.send({ t: 'req', reqId, fileId, from: 0 });
      this.armWatchdog(reqId);
    });
  }

  cancel(reqId: string): void {
    this.send({ t: 'cancel', reqId });
    const req = this.current;
    if (req && req.reqId === reqId) {
      this.current = null;
      void req.sink.abort('Cancelled.');
      req.reject(new Error('Cancelled.'));
    }
  }

  /** Gives up on the transfer in progress for good. */
  failAll(reason: string): void {
    const req = this.current;
    this.current = null;
    if (!req) return;
    void req.sink.abort(reason);
    req.reject(new Error(reason));
  }

  private send(msg: TransferMessage): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  private async handleMessage(dc: RTCDataChannel, ev: MessageEvent): Promise<void> {
    // Stragglers from a channel we have moved on from are dropped. Their bytes
    // were never counted, so the resume request asks for them again.
    if (dc !== this.dc) return;

    if (typeof ev.data === 'string') {
      let msg: TransferMessage;
      try {
        msg = JSON.parse(ev.data) as TransferMessage;
      } catch {
        return;
      }
      const req = this.current;

      if (msg.t === 'bye') {
        this.onBye?.();
        return;
      }

      if (msg.t === 'begin') {
        if (!req || req.reqId !== msg.reqId) return;
        if (msg.from !== req.received) {
          this.failAll('The sender resumed at the wrong position.');
          return;
        }
        req.started = true;
        window.clearTimeout(this.watchdog);
        req.name = msg.name;
        req.size = msg.size;
        this.onProgress(req);
        return;
      }

      if (msg.t === 'end') {
        if (!req || req.reqId !== msg.reqId || !req.started) return;
        if (req.received !== req.size) {
          this.failAll(`Received ${req.received} of ${req.size} bytes.`);
          return;
        }
        // The last word on whether the file is right: both sides' checksum of
        // the whole thing. A mismatch fails the download loudly - a damaged
        // file saved without a word is the one outcome that must not happen.
        if (msg.crc !== undefined && msg.crc !== req.crc.value) {
          console.warn(`[fileshare] checksum mismatch on ${req.name}: sent ${msg.crc}, received ${req.crc.value}`);
          this.failAll('The file arrived damaged, so it was not saved. Please download it again.');
          return;
        }
        this.current = null;
        await req.sink.close();
        this.onProgress(req);
        req.resolve();
        return;
      }

      if (msg.t === 'deny') {
        if (!req || req.reqId !== msg.reqId) return;
        this.failAll(msg.reason);
      }
      return;
    }

    // Binary: a chunk of the transfer currently in flight.
    const req = this.current;
    if (!req || !req.started) return;
    const chunk = ev.data as ArrayBuffer;
    await req.sink.write(chunk);
    req.crc.update(new Uint8Array(chunk));
    req.received += chunk.byteLength;
    this.report(req);
  }
}

export { CHUNK_SIZE };
