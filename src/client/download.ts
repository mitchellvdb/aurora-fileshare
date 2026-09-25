import type { FileMeta, RTCIceServerConfig } from '../shared/protocol.js';
import { $, el, formatBytes, formatEta, formatRate, RateMeter, Signaling, uid } from './common.js';
import { deriveKeys, seal, unseal } from './crypto.js';
import { renderDonateButton } from './donate.js';
import { createSink, initSaver, type SaveMode } from './save.js';
import { FileReceiver, PeerLink, type ActiveDownload } from './transfer.js';
import { planZip, ZipWriter } from './zip.js';

const signaling = new Signaling();
const receiver = new FileReceiver(onReceiveProgress);
let link: PeerLink | null = null;
let channel: RTCDataChannel | null = null;
let uploaderId = '';
let iceServers: RTCIceServerConfig[] = [];
let saveMode: SaveMode = 'blob';
let files: FileMeta[] = [];
let busy = false;

/**
 * How long we keep trying to get a lost connection back before giving up.
 * Long enough for a laptop lid, a train tunnel or a router reboot.
 */
const RECOVERY_MS = 10 * 60_000;
/** A connection "disconnected" this long is treated as gone. */
const STALL_MS = 8_000;

/** Who we are to the sender, across reconnects. Sent sealed, never to the server. */
const rid = uid();
let joinedOnce = false;
/** In the server's channel right now (false after the sender's socket dropped). */
let inChannel = false;
let joinPassword: string | undefined;
let everConnected = false;
let lostSince: number | null = null;
let stalledSince: number | null = null;
let lastJoinTry = 0;
let lastConnectTry = 0;
let over = false;

const slug = decodeURIComponent(location.pathname.replace(/^\/d\//, ''));
// The secret after '#'. Browsers never send it to the server; see crypto.ts.
const keys = deriveKeys(location.hash.slice(1));

/**
 * The manifest is the one thing the other side controls that ends up in the
 * page and in a filename, so check its shape and clean the names here - the
 * server can no longer do it, because it cannot read them.
 */
function cleanFiles(raw: unknown): FileMeta[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) return null;
  const out: FileMeta[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const f = item as Record<string, unknown>;
    if (typeof f['id'] !== 'string' || typeof f['name'] !== 'string'
      || typeof f['size'] !== 'number' || !Number.isFinite(f['size']) || f['size'] < 0) return null;
    out.push({
      id: f['id'].slice(0, 64),
      // Strip path separators so a crafted name cannot influence the save path.
      name: (f['name'].replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 512)) || 'file',
      size: f['size'],
      type: typeof f['type'] === 'string' ? f['type'].slice(0, 128) : '',
    });
  }
  return out;
}

/** The file list, or 'ask' when the sender approves each person first. */
function readManifest(sealed: unknown): FileMeta[] | 'ask' | null {
  if (!keys) return null;
  const raw = unseal<unknown>(keys.enc, sealed);
  if (typeof raw === 'object' && raw !== null && (raw as { approval?: unknown }).approval === true) {
    return 'ask';
  }
  return cleanFiles(raw);
}

function join(password?: string): void {
  if (!keys) return;
  if (password !== undefined) joinPassword = password;
  signaling.send({
    t: 'join', slug, auth: keys.auth,
    ...(joinPassword !== undefined ? { password: joinPassword } : {}),
    ...(joinedOnce ? { again: true } : {}),
  });
}

/** Sealed to the sender, relayed by a server that cannot read it. */
function tellSender(data: unknown): void {
  if (keys && uploaderId) signaling.send({ t: 'signal', to: uploaderId, data: seal(keys.enc, data) });
}

function connected(): boolean {
  return channel?.readyState === 'open' && stalledSince === null;
}

/** The end: nothing will come back. Anything half-done is abandoned. */
function finish(message: string, kind: 'warn' | 'info' = 'warn'): void {
  if (over) return;
  over = true;
  setStatus(message, kind);
  receiver.failAll(message);
  setButtonsDisabled(true);
  link?.close();
  signaling.close();
}

const statusBox = $<HTMLElement>('#status');
const errorBox = $<HTMLElement>('#error');
const fileList = $<HTMLElement>('#file-list');
const filesSection = $<HTMLElement>('#files');
const passwordSection = $<HTMLElement>('#password-gate');
const passwordInput = $<HTMLInputElement>('#password');
const downloadAll = $<HTMLButtonElement>('#download-all');
const progressRows = new Map<string, { bar: HTMLElement; status: HTMLElement; meter: RateMeter }>();

function setStatus(text: string, kind: 'info' | 'good' | 'warn' = 'info'): void {
  statusBox.textContent = text;
  statusBox.className = `status status-${kind}`;
  statusBox.hidden = false;
}

function showError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
  // The error box says it better; two copies of the same sentence reads as a bug.
  statusBox.hidden = true;
}

function clearError(): void {
  errorBox.hidden = true;
}

// --- Startup ----------------------------------------------------------------

async function main(): Promise<void> {
  $<HTMLElement>('#slug').textContent = slug;
  if (!keys) {
    // Most often a link cut short by a chat app, or copied without its end.
    showError('This link is incomplete: the part after the # is missing or damaged. '
      + 'Ask the sender to send the whole link again.');
    return;
  }
  saveMode = await initSaver();

  if (saveMode === 'blob') {
    $<HTMLElement>('#mode-note').hidden = false;
  }

  setStatus('Contacting the server…');
  try {
    await signaling.connect();
  } catch {
    showError('Could not reach the server. Check your connection and reload.');
    return;
  }
  join();
}

signaling.on((msg) => {
  if (over) return;
  switch (msg.t) {
    case 'joined': {
      uploaderId = msg.uploader;
      iceServers = msg.iceServers;
      inChannel = true;
      if (joinedOnce) {
        // Back after a dropped connection. If the direct link survived there is
        // nothing to rebuild; the sender only needs our new address.
        if (!connected()) setupPeer();
        tellSender({ ctl: 'hello', rid, want: connected() ? 'keep' : 'connect' });
        return;
      }
      clearError();
      passwordSection.hidden = true;
      const manifest = readManifest(msg.sealed);
      if (!manifest) {
        showError('This share could not be read. The link may be damaged; ask the sender for it again.');
        signaling.close();
        return;
      }
      joinedOnce = true;
      setupPeer();
      tellSender({ ctl: 'hello', rid, want: 'connect' });
      if (manifest === 'ask') {
        // The names come later, and only if the sender says yes.
        setStatus('Waiting for the sender to let you in…');
        return;
      }
      files = manifest;
      setStatus('Connecting directly to the sender…');
      renderFiles();
      return;
    }
    case 'signal': {
      if (msg.from !== uploaderId || !keys) return;
      // Anything that does not decrypt was not written by the sender.
      const data = unseal<{ ctl?: string; files?: unknown }>(keys.enc, msg.data);
      if (data === null) return;
      if (data.ctl === 'manifest') {
        if (files.length > 0) return;
        const allowed = cleanFiles(data.files);
        if (!allowed) return;
        files = allowed;
        setStatus('The sender let you in. Connecting directly…');
        renderFiles();
        return;
      }
      if (data.ctl === 'wait') {
        setStatus('Waiting for the sender to let you in…');
        return;
      }
      if (data.ctl === 'declined') {
        finish('The sender declined the connection.');
        return;
      }
      if (data.ctl === 'bye') {
        finish('The sender closed their tab, so the share has ended.');
        return;
      }
      void link?.handleSignal(data);
      return;
    }
    case 'closed': {
      if (msg.code === 'sender-left') {
        // Only the sender's line to the server went. A transfer already
        // running between the two browsers is unaffected; we rejoin once the
        // sender is back, which the recovery loop takes care of.
        inChannel = false;
        if (!connected()) setStatus('The sender lost their connection. Waiting for them to come back…', 'warn');
        return;
      }
      finish(msg.reason);
      return;
    }
    case 'error': {
      if (joinedOnce) {
        // Rejoining while the sender is still away answers "not found" until
        // they are back. The recovery loop tries again; only a lockout is final.
        if (msg.code === 'locked') finish(msg.message);
        return;
      }
      if (msg.code === 'password-required' || msg.code === 'bad-password') {
        passwordSection.hidden = false;
        setStatus('This share is protected.', 'warn');
        if (msg.code === 'bad-password') showError('Incorrect password. Try again.');
        passwordInput.focus();
        return;
      }
      setStatus(msg.message, 'warn');
      showError(msg.message);
      return;
    }
  }
});

// Our own line to the server dropping changes nothing for a running transfer;
// the socket reconnects by itself and we rejoin.
signaling.onDown(() => {
  inChannel = false;
});
signaling.onUp(() => {
  if (!over && keys) join();
});

$<HTMLFormElement>('#password-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  clearError();
  setStatus('Checking password…');
  join(passwordInput.value);
});

// --- Peer connection --------------------------------------------------------

/** Builds a fresh connection to the sender, replacing any previous one. */
function setupPeer(): void {
  link?.close();
  channel = null;
  stalledSince = null;
  const current = new PeerLink(iceServers, (data) => tellSender(data));
  link = current;

  // The sender opens the channel; we just answer and wait for it.
  current.pc.addEventListener('datachannel', (ev) => {
    const dc = ev.channel;
    dc.binaryType = 'arraybuffer';

    dc.addEventListener('open', () => {
      if (link !== current) return;
      channel = dc;
      const resuming = lostSince !== null && receiver.pending;
      everConnected = true;
      lostSince = null;
      receiver.attach(dc);
      setStatus(resuming
        ? `Reconnected. Continuing from ${formatBytes(receiver.pending?.received ?? 0)}.`
        : 'Connected directly to the sender. Nothing passes through our servers.', 'good');
      if (!busy) setButtonsDisabled(false);
    });

    dc.addEventListener('close', () => {
      if (link !== current) return;
      connectionLost();
    });
  });

  current.pc.addEventListener('connectionstatechange', () => {
    if (link !== current) return;
    const state = current.pc.connectionState;
    // "disconnected" often heals by itself within seconds; the loop below
    // only gives up on it after STALL_MS.
    stalledSince = state === 'disconnected' ? (stalledSince ?? Date.now()) : null;
    if (state !== 'failed') return;
    if (everConnected) {
      connectionLost();
      return;
    }
    setStatus(
      'Could not open a direct connection. Both networks are blocking peer-to-peer traffic.',
      'warn',
    );
    showError(
      'This usually means one side is on a restrictive network (some corporate or mobile networks). '
      + 'Try a different network, or ask the sender to try again.',
    );
  });
}

function connectionLost(): void {
  if (over || lostSince !== null) return;
  lostSince = Date.now();
  channel = null;
  receiver.detach();
  if (!busy) setButtonsDisabled(true);
  const pending = receiver.pending;
  setStatus(pending
    ? `Connection lost at ${formatBytes(pending.received)}. Reconnecting — the download will continue where it stopped…`
    : 'Connection lost. Reconnecting…', 'warn');
}

/**
 * Runs every few seconds once we have joined, and gets back whatever went
 * missing: our place in the server's channel, and the direct connection.
 */
function recover(): void {
  if (over || !joinedOnce) return;
  const now = Date.now();

  if (everConnected && stalledSince !== null && now - stalledSince > STALL_MS) {
    stalledSince = null;
    connectionLost();
  }
  if (lostSince !== null && now - lostSince > RECOVERY_MS) {
    finish('Lost the connection to the sender and could not get it back.');
    return;
  }
  if (!signaling.isOpen) return; // it reconnects by itself

  if (!inChannel) {
    if (now - lastJoinTry > 6_000) {
      lastJoinTry = now;
      join();
    }
    return;
  }
  if (lostSince !== null && now - lastConnectTry > 15_000) {
    lastConnectTry = now;
    setupPeer();
    tellSender({ ctl: 'hello', rid, want: 'connect' });
  }
}
window.setInterval(recover, 3_000);

receiver.onBye = () => finish('The sender closed their tab, so the share has ended.');

// --- File list and downloads ------------------------------------------------

function renderFiles(): void {
  filesSection.hidden = false;
  fileList.replaceChildren();
  progressRows.clear();

  let total = 0;
  for (const file of files) {
    total += file.size;
    const bar = el('span', { class: 'bar-fill' });
    const status = el('span', { class: 'file-status' }, 'Ready');
    const button = el('button', { class: 'btn btn-secondary download', type: 'button' }, 'Download');
    button.disabled = true;
    button.addEventListener('click', () => void downloadOne(file));

    fileList.append(el('li', { class: 'file file-block', 'data-file': file.id },
      el('div', { class: 'file-main' },
        el('span', { class: 'file-bullet', 'aria-hidden': 'true' }),
        el('span', { class: 'file-name' }, file.name),
        el('span', { class: 'file-size' }, formatBytes(file.size)),
        button,
      ),
      el('div', { class: 'bar' }, bar),
      el('div', { class: 'xfer-meta' }, status),
    ));

    progressRows.set(file.id, { bar, status, meter: new RateMeter() });
  }

  $<HTMLElement>('#files-summary').textContent =
    `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(total)}`;
  downloadAll.hidden = files.length < 2;
}

function onReceiveProgress(d: ActiveDownload): void {
  const row = progressRows.get(d.fileId);
  if (!row) return;
  const percent = d.size === 0 ? 100 : (d.received / d.size) * 100;
  row.bar.style.width = `${percent.toFixed(1)}%`;
  const rate = row.meter.update(d.received);
  const remaining = rate > 0 ? (d.size - d.received) / rate : Infinity;
  row.status.textContent = d.received >= d.size
    ? 'Complete'
    : `${percent.toFixed(0)}% · ${formatRate(rate)} · ${formatEta(remaining)} left`;
}

async function downloadOne(file: FileMeta): Promise<void> {
  if (busy || !connected()) return;
  busy = true;
  setButtonsDisabled(true);

  const row = progressRows.get(file.id);
  if (row) row.status.textContent = 'Starting…';

  try {
    const sink = await createSink(saveMode, file.name, file.size, file.type);
    await receiver.request(file.id, sink);
    if (row) {
      row.status.textContent = 'Complete';
      row.bar.style.width = '100%';
    }
  } catch (err) {
    if (row) row.status.textContent = `Failed: ${(err as Error).message}`;
  } finally {
    busy = false;
    setButtonsDisabled(!connected());
  }
}

function setButtonsDisabled(disabled: boolean): void {
  for (const button of fileList.querySelectorAll<HTMLButtonElement>('button.download')) {
    button.disabled = disabled;
  }
  downloadAll.disabled = disabled;
}

downloadAll.addEventListener('click', () => void downloadAllAsZip());

/**
 * Pulls every file in order and muxes them into one ZIP as they arrive. The
 * archive is written straight through to disk - at no point does a whole file,
 * let alone the whole archive, sit in memory.
 */
async function downloadAllAsZip(): Promise<void> {
  if (busy || !connected()) return;
  busy = true;
  setButtonsDisabled(true);

  const archiveName = `aurora-files-${slug}.zip`;
  const plan = planZip(files.map((f) => ({ name: f.name, size: f.size })));

  for (const row of progressRows.values()) {
    row.bar.style.width = '0%';
    row.status.textContent = 'Queued';
  }
  setStatus(`Building ${archiveName} (${formatBytes(plan.totalSize)})…`);

  try {
    const sink = await createSink(saveMode, archiveName, plan.totalSize, 'application/zip');
    const zip = new ZipWriter(plan, sink);

    for (const file of files) {
      const row = progressRows.get(file.id);
      if (row) row.status.textContent = 'Receiving…';
      await receiver.request(file.id, zip.nextEntry());
      if (row) {
        row.bar.style.width = '100%';
        row.status.textContent = 'Added to archive';
      }
    }

    await zip.finish();
    setStatus(`Saved ${archiveName} — ${files.length} files, ${formatBytes(plan.totalSize)}.`, 'good');
  } catch (err) {
    const message = (err as Error).message;
    setStatus(`The archive failed: ${message}`, 'warn');
    showError(`Could not build ${archiveName}: ${message}`);
  } finally {
    busy = false;
    setButtonsDisabled(!connected());
  }
}

renderDonateButton(document.querySelector('#donate-slot'));

void main();
