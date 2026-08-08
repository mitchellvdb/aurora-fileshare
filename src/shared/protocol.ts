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

/** Peer identifier assigned by the server, unique within a channel. */
export type PeerId = string;

// --- Signaling: browser -> server -------------------------------------------

export type ClientMessage =
  /** Uploader offers a set of files and asks for a slug. */
  | { t: 'host'; files: FileMeta[]; password?: string }
  /** Downloader asks to join an existing slug. */
  | { t: 'join'; slug: string; password?: string }
  /** Relay an SDP/ICE payload to another peer in the same channel. */
  | { t: 'signal'; to: PeerId; data: unknown }
  /** Uploader reports live progress so the server can surface it (optional). */
  | { t: 'ping' };

// --- Signaling: server -> browser -------------------------------------------

export type ServerMessage =
  /** Channel created; this is the slug to share. */
  | { t: 'hosted'; slug: string; peerId: PeerId; iceServers: RTCIceServerConfig[] }
  /** Join accepted; here is the manifest and how to reach the uploader. */
  | { t: 'joined'; peerId: PeerId; uploader: PeerId; files: FileMeta[]; iceServers: RTCIceServerConfig[] }
  /** A downloader joined this channel (sent to the uploader). */
  | { t: 'peer-join'; peerId: PeerId }
  /** A peer disconnected. */
  | { t: 'peer-leave'; peerId: PeerId }
  /** Relayed SDP/ICE payload. */
  | { t: 'signal'; from: PeerId; data: unknown }
  /** The uploader closed the tab; the channel is gone. */
  | { t: 'closed'; reason: string }
  | { t: 'pong' }
  | { t: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'not-found'
  | 'bad-password'
  | 'password-required'
  | 'bad-request'
  | 'too-many-files'
  | 'file-too-large'
  | 'rate-limited'
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
  /** Downloader requests one file. */
  | { t: 'req'; reqId: string; fileId: string }
  /** Uploader is about to stream the file; binary chunks follow. */
  | { t: 'begin'; reqId: string; fileId: string; name: string; size: number; type: string }
  /** All chunks for reqId have been sent. */
  | { t: 'end'; reqId: string }
  /** Uploader refused or hit an error. */
  | { t: 'deny'; reqId: string; reason: string }
  /** Downloader aborted a transfer in flight. */
  | { t: 'cancel'; reqId: string };

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
