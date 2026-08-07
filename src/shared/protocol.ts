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
 * 64 KiB. Comfortably under the 256 KiB message ceiling that every WebRTC
 * implementation supports, and large enough that per-message overhead is noise.
 */
export const CHUNK_SIZE = 64 * 1024;

/** Stop reading from disk once this much is queued in the data channel. */
export const BUFFER_HIGH_WATER = 8 * 1024 * 1024;
/** Resume reading once the queue drains below this. */
export const BUFFER_LOW_WATER = 1 * 1024 * 1024;

export const MAX_FILES = 64;
