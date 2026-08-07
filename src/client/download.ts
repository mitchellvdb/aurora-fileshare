import type { FileMeta, RTCIceServerConfig } from '../shared/protocol.js';
import { $, el, formatBytes, formatEta, formatRate, RateMeter, Signaling } from './common.js';
import { createSink, initSaver, type SaveMode } from './save.js';
import { FileReceiver, PeerLink, type ActiveDownload } from './transfer.js';

const signaling = new Signaling();
let link: PeerLink | null = null;
let receiver: FileReceiver | null = null;
let uploaderId = '';
let iceServers: RTCIceServerConfig[] = [];
let saveMode: SaveMode = 'blob';
let files: FileMeta[] = [];
let busy = false;

const slug = decodeURIComponent(location.pathname.replace(/^\/d\//, ''));

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
}

function showError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError(): void {
  errorBox.hidden = true;
}

// --- Startup ----------------------------------------------------------------

async function main(): Promise<void> {
  $<HTMLElement>('#slug').textContent = slug;
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
  signaling.send({ t: 'join', slug });
}

signaling.on((msg) => {
  switch (msg.t) {
    case 'joined': {
      clearError();
      passwordSection.hidden = true;
      uploaderId = msg.uploader;
      iceServers = msg.iceServers;
      files = msg.files;
      setStatus('Connecting directly to the sender…');
      setupPeer();
      renderFiles();
      return;
    }
    case 'signal': {
      if (msg.from === uploaderId) void link?.handleSignal(msg.data);
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
  signaling.send({ t: 'join', slug, password: passwordInput.value });
});

// --- Peer connection --------------------------------------------------------

function setupPeer(): void {
  link = new PeerLink(iceServers, (data) => {
    signaling.send({ t: 'signal', to: uploaderId, data });
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
    const button = el('button', { class: 'download', type: 'button' }, 'Download');
    button.disabled = true;
    button.addEventListener('click', () => void downloadOne(file));

    fileList.append(el('li', { class: 'file-row', 'data-file': file.id },
      el('div', { class: 'file-main' },
        el('span', { class: 'file-name' }, file.name),
        el('span', { class: 'file-size' }, formatBytes(file.size)),
        button,
      ),
      el('span', { class: 'bar' }, bar),
      status,
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

downloadAll.addEventListener('click', async () => {
  // Sequential: the data channel carries one file at a time, and browsers throttle
  // a burst of simultaneous downloads anyway.
  for (const file of files) {
    await downloadOne(file);
  }
});

void main();
