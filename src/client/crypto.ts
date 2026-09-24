import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The share secret, and everything derived from it.
 *
 * Every link carries 128 random bits after the '#':
 *
 *     https://fileshare.aurorahosting.nl/d/swift-otter-482#Xk3v...
 *
 * Browsers never send the fragment anywhere - not to our server, not to
 * Cloudflare - so the secret exists only in the two browsers and in the link
 * itself. Two independent keys are derived from it:
 *
 *   auth - handed to the server on join. The server holds only its SHA-256
 *          (the "verifier", registered by the sender), so it can check a
 *          joiner without being able to mint a valid join itself. This is what
 *          makes a link unguessable: the slug alone gets you nowhere.
 *   enc  - never leaves the browser. Seals the file list and every signalling
 *          message with AES-GCM, so the server relays ciphertext: it cannot
 *          read file names, cannot see either side's network addresses in the
 *          ICE candidates, and cannot swap the DTLS fingerprints in the SDP to
 *          put itself in the middle of the transfer.
 *
 * Pure-JS primitives (the audited @noble libraries) rather than WebCrypto,
 * because crypto.subtle only exists in secure contexts and the app must keep
 * working over plain HTTP on a LAN. crypto.getRandomValues has no such
 * restriction.
 */

const SECRET_BYTES = 16;
const NONCE_BYTES = 12;
const SALT = new TextEncoder().encode('aurora-fileshare/v1');
const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;

export interface ShareKeys {
  /** The fragment itself, for building the link. */
  secret: string;
  /** Sent to the server when joining. */
  auth: string;
  /** SHA-256 of auth; registered by the sender. */
  verifier: string;
  /** AES-256-GCM key. Never sent anywhere. */
  enc: Uint8Array;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function newSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** Null when the fragment is missing or mangled, e.g. a link cut off in a chat. */
export function deriveKeys(secret: string): ShareKeys | null {
  if (!SECRET_RE.test(secret)) return null;
  const ikm = fromBase64Url(secret);
  if (!ikm || ikm.length !== SECRET_BYTES) return null;
  const info = (s: string) => new TextEncoder().encode(s);
  const auth = hkdf(sha256, ikm, SALT, info('auth'), 32);
  return {
    secret,
    auth: toBase64Url(auth),
    verifier: toBase64Url(sha256(auth)),
    enc: hkdf(sha256, ikm, SALT, info('enc'), 32),
  };
}

/** JSON-encodes and encrypts a value: base64url(nonce || ciphertext+tag). */
export function seal(key: Uint8Array, value: unknown): string {
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const sealed = gcm(key, nonce).encrypt(plain);
  const out = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce);
  out.set(sealed, NONCE_BYTES);
  return toBase64Url(out);
}

/**
 * Decrypts and parses. Null for anything that fails authentication - a
 * message the server made up or altered is dropped, never half-trusted.
 */
export function unseal<T>(key: Uint8Array, sealed: unknown): T | null {
  if (typeof sealed !== 'string') return null;
  const bytes = fromBase64Url(sealed);
  if (!bytes || bytes.length <= NONCE_BYTES + 16) return null;
  try {
    const plain = gcm(key, bytes.subarray(0, NONCE_BYTES)).decrypt(bytes.subarray(NONCE_BYTES));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}
