import type { FileMeta, RTCIceServerConfig } from '../shared/protocol.js';
import { $, el, formatBytes, formatEta, formatRate, RateMeter, Signaling } from './common.js';
import { deriveKeys, seal, unseal } from './crypto.js';
import { renderDonateButton } from './donate.js';
import { createSink, initSaver, type SaveMode } from './save.js';
import { FileReceiver, PeerLink, type ActiveDownload } from './transfer.js';
import { planZip, ZipWriter } from './zip.js';

const signaling = new Signaling();
let link: PeerLink | null = null;
let receiver: FileReceiver | null = null;
let uploaderId = '';
let iceServers: RTCIceServerConfig[] = [];
let saveMode: SaveMode = 'blob';
let files: FileMeta[] = [];
let busy = false;

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
  signaling.send({ t: 'join', slug, auth: keys.auth, ...(password !== undefined ? { password } : {}) });
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
  switch (msg.t) {
    case 'joined': {
      clearError();
      passwordSection.hidden = true;
      uploaderId = msg.uploader;
      iceServers = msg.iceServers;
      const manifest = readManifest(msg.sealed);
      if (!manifest) {
        showError('This share could not be read. The link may be damaged; ask the sender for it again.');
        signaling.close();
        return;
      }
      setupPeer();
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
        setStatus('The sender declined the connection.', 'warn');
        downloadAll.disabled = true;
        link?.close();
        signaling.close();
        return;
      }
      void link?.handleSignal(data);
      return;
    }
    case 'closed': {
      setStatus(msg.reason, 'warn');
      receiver?.failAll(msg.reason);
      downloadAll.disabled = true;
      return;
    }
    case 'error': {
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

$<HTMLFormElement>('#password-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  clearError();
  setStatus('Checking password…');
  join(passwordInput.value);
});

// --- Peer connection --------------------------------------------------------

function setupPeer(): void {
  link = new PeerLink(iceServers, (data) => {
    if (keys) signaling.send({ t: 'signal', to: uploaderId, data: seal(keys.enc, data) });
  });

  // The sender opens the channel; we just answer and wait for it.
  link.pc.addEventListener('datachannel', (ev) => {
    const channel = ev.channel;
    channel.binaryType = 'arraybuffer';

    receiver = new FileReceiver(channel, onReceiveProgress);

    channel.addEventListener('open', () => {
      setStatus('Connected directly to the sender. Nothing passes through our servers.', 'good');
      downloadAll.disabled = false;
      for (const button of fileList.querySelectorAll<HTMLButtonElement>('button.download')) {
        button.disabled = false;
      }
    });

    channel.addEventListener('close', () => {
      setStatus('The sender disconnected.', 'warn');
      receiver?.failAll('The sender disconnected.');
      downloadAll.disabled = true;
    });
  });

  link.pc.addEventListener('connectionstatechange', () => {
    if (link?.pc.connectionState === 'failed') {
      setStatus(
        'Could not open a direct connection. Both networks are blocking peer-to-peer traffic.',
        'warn',
      );
      showError(
        'This usually means one side is on a restrictive network (some corporate or mobile networks). '
        + 'Try a different network, or ask the sender to try again.',
      );
    }
  });
}

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
  if (!receiver || busy) return;
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
    setButtonsDisabled(false);
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
  if (!receiver || busy) return;
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
    setButtonsDisabled(false);
  }
}

renderDonateButton(document.querySelector('#donate-slot'));

void main();
