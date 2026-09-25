/**
 * Wire protocol shared by the signaling server and both browser roles.
 *
 * Two separate channels are in play:
 *   1. Signaling (WebSocket, via our server) - only SDP/ICE and tiny control
 *      messages. File bytes never appear here.
 *   2. Transfer (WebRTC RTCDataChannel, peer to peer) - the actual file bytes,
 *      which never touch the server at all.
 */

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  type: string;
}

/**
 * What the server gets to see of a file: an id and a size, for the file-count
 * and size checks. Names and types travel only inside the sealed manifest,
 * encrypted with a key the server never has (see client/crypto.ts).
 */
export interface FileStub {
  id: string;
  size: number;
}

/** Ceiling on a sealed manifest or signal, in base64url characters. */
export const SEALED_MAX = 128 * 1024;

/** Peer identifier assigned by the server, unique within a channel. */
export type PeerId = string;

// --- Signaling: browser -> server -------------------------------------------

export type ClientMessage =
  /**
   * Uploader offers a set of files and asks for a slug. `sealed` is the full
   * manifest, encrypted; `verifier` is the SHA-256 of the join token derived
   * from the link's secret.
   */
  | {
    t: 'host'; files: FileStub[]; sealed: string; verifier: string; password?: string;
    /**
     * Set when the sender re-registers a share it already had, after losing
     * its connection to the server (or the server restarting). The server
     * reuses the slug if it is free, so the link keeps working.
     */
    slug?: string;
  }
  /**
   * Downloader asks to join an existing slug, proving it holds the link's
   * secret. `again` marks a rejoin after a lost connection, so it is not
   * counted as another recipient.
   */
  | { t: 'join'; slug: string; auth: string; password?: string; again?: boolean }
  /** Relay a sealed SDP/ICE payload to another peer in the same channel. */
  | { t: 'signal'; to: PeerId; data: string }
  /** Uploader reports live progress so the server can surface it (optional). */
  | { t: 'ping' };

// --- Signaling: server -> browser -------------------------------------------

export type ServerMessage =
  /** Channel created; this is the slug to share. */
  | { t: 'hosted'; slug: string; peerId: PeerId; iceServers: RTCIceServerConfig[] }
  /** Join accepted; here is the manifest and how to reach the uploader. */
  | { t: 'joined'; peerId: PeerId; uploader: PeerId; files: FileStub[]; sealed: string; iceServers: RTCIceServerConfig[] }
  /** A downloader joined this channel (sent to the uploader). */
  | { t: 'peer-join'; peerId: PeerId }
  /** A peer disconnected. */
  | { t: 'peer-leave'; peerId: PeerId }
  /** Relayed sealed payload. */
  | { t: 'signal'; from: PeerId; data: string }
  /**
   * The channel is gone. `sender-left` means only the sender's connection to
   * this server dropped: a transfer already running between the browsers can
   * carry on, and the sender may come back. The others are final.
   */
  | { t: 'closed'; reason: string; code: CloseCode }
  | { t: 'pong' }
  | { t: 'error'; code: ErrorCode; message: string };

export type CloseCode = 'sender-left' | 'operator' | 'locked' | 'expired';

export type ErrorCode =
  | 'not-found'
  | 'bad-password'
  | 'password-required'
  | 'bad-request'
  | 'too-many-files'
  | 'file-too-large'
  | 'rate-limited'
  | 'locked'
  | 'server-full';

/** Structurally identical to RTCIceServer, redeclared so the server can build
 *  it without pulling in DOM lib types. */
export interface RTCIceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// --- Transfer: uploader <-> downloader over RTCDataChannel ------------------

export type TransferMessage =
  /**
   * Downloader requests one file, starting at byte `from` (0 when absent).
   * A non-zero `from` resumes a transfer that a dropped connection cut short.
   */
  | { t: 'req'; reqId: string; fileId: string; from?: number }
  /** Uploader is about to stream the file from byte `from`; binary chunks follow. */
  | { t: 'begin'; reqId: string; fileId: string; name: string; size: number; type: string; from: number }
  /** All chunks for reqId have been sent. */
  | { t: 'end'; reqId: string }
  /** Uploader refused or hit an error. */
  | { t: 'deny'; reqId: string; reason: string }
  /** Downloader aborted a transfer in flight. */
  | { t: 'cancel'; reqId: string }
  /** The sender is closing the tab: nothing will resume, stop waiting. */
  | { t: 'bye' };

/**
 * Largest single data-channel message we will send.
 *
 * 256 KiB is the ceiling every current browser advertises in its SDP
 * (`a=max-message-size:262144`), and the sender clamps to whatever the peer
 * actually negotiated. Per-message cost - a send() call, an SCTP header, a
 * receive event, and a trip through the receiver's promise chain - is paid once
 * per message no matter how big it is, so larger messages mean proportionally
 * less overhead per byte.
 */
export const CHUNK_SIZE = 256 * 1024;

/** Conservative floor: the smallest message size WebRTC guarantees. */
export const MIN_CHUNK_SIZE = 64 * 1024;

/**
 * How much we read from disk in one go. Reading is asynchronous and each read
 * costs a round trip to the browser's file backend, so we pull a large block
 * and carve messages out of it in memory rather than paying that cost per
 * message. The sender keeps one block read in flight while sending the
 * previous one, so disk latency overlaps the network instead of adding to it.
 */
export const READ_BLOCK_SIZE = 8 * 1024 * 1024;

/**
 * Stop reading from disk once this much is queued in the data channel.
 *
 * Chrome tears the channel down if the outgoing buffer ever passes 16 MiB, and
 * we test this before queueing one more message, so the true peak is this plus
 * one message. 12 MiB leaves a wide margin while giving the link about a
 * quarter of a second of runway at 50 MB/s - enough that a slow disk read can
 * never leave the channel with nothing to send.
 */
export const BUFFER_HIGH_WATER = 12 * 1024 * 1024;
/**
 * Resume reading once the queue drains below this. Deliberately not near zero:
 * the send buffer must still hold data while we go get more, or the link goes
 * idle every time we refill and throughput collapses to one block per round
 * trip.
 */
export const BUFFER_LOW_WATER = 4 * 1024 * 1024;

/**
 * How many bytes the receiver may hold between the data channel and the disk.
 * Without a real window here the stream defaults to a single chunk, which
 * serialises every chunk behind a page-to-service-worker round trip.
 */
export const RECEIVE_HIGH_WATER = 16 * 1024 * 1024;

/** Progress callbacks are sampled at this interval rather than fired per chunk. */
export const PROGRESS_INTERVAL_MS = 100;

export const MAX_FILES = 64;
