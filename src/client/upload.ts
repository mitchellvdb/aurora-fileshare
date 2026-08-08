import type { FileMeta, RTCIceServerConfig } from '../shared/protocol.js';
import { MAX_FILES } from '../shared/protocol.js';
import {
  $, copyToClipboard, el, formatBytes, formatRate, RateMeter, Signaling, uid,
} from './common.js';
import { renderDonateButton } from './donate.js';
import { renderQr } from './qr.js';
import { FileSender, PeerLink, type SendProgress } from './transfer.js';
import { describeTransport, summarise } from './diagnostics.js';

interface Recipient {
  peerId: string;
  link: PeerLink;
  channel: RTCDataChannel | null;
  row: HTMLElement;
  bar: HTMLElement;
  status: HTMLElement;
  percent: HTMLElement;
  meter: RateMeter;
  label: string;
  sender: FileSender | null;
}

const selected = new Map<string, File>();
const recipients = new Map<string, Recipient>();
const signaling = new Signaling();
let iceServers: RTCIceServerConfig[] = [];
let shareUrl = '';

// --- File selection ---------------------------------------------------------

const dropZone = $<HTMLElement>('#drop-zone');
const fileInput = $<HTMLInputElement>('#file-input');
const fileList = $<HTMLElement>('#file-list');
const filesPanel = $<HTMLElement>('#files-panel');
const fileCount = $<HTMLElement>('#file-count');
const fileTotal = $<HTMLElement>('#file-total');
const moreInput = $<HTMLInputElement>('#file-input-more');
const composeBox = $<HTMLElement>('#compose');
const recipientsCard = $<HTMLElement>('#recipients-card');
const startButton = $<HTMLButtonElement>('#start-share');
const passwordInput = $<HTMLInputElement>('#password');
const pickerSection = $<HTMLElement>('#picker');
const shareSection = $<HTMLElement>('#share');
const errorBox = $<HTMLElement>('#error');

function showError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError(): void {
  errorBox.hidden = true;
}

function addFiles(files: FileList | File[]): void {
  clearError();
  for (const file of Array.from(files)) {
    if (selected.size >= MAX_FILES) {
      showError(`You can share at most ${MAX_FILES} files at once.`);
      break;
    }
    // Same name and size twice is almost certainly the same file picked twice.
    const duplicate = [...selected.values()].some(
      (f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified);
    if (!duplicate) selected.set(uid(), file);
  }
  renderFileList();
}

function renderFileList(): void {
  fileList.replaceChildren();
  let total = 0;

  for (const [id, file] of selected) {
    total += file.size;
    const remove = el('button', {
      class: 'file-x', type: 'button', 'aria-label': `Remove ${file.name}`,
    }, '\u00d7');
    remove.addEventListener('click', () => {
      selected.delete(id);
      renderFileList();
    });
    fileList.append(el('li', { class: 'file' },
      el('span', { class: 'file-bullet', 'aria-hidden': 'true' }),
      el('span', { class: 'file-name' }, file.name),
      el('span', { class: 'file-size' }, formatBytes(file.size)),
      remove,
    ));
  }

  const count = selected.size;
  fileCount.textContent = `${count} file${count === 1 ? '' : 's'}`;
  fileTotal.textContent = formatBytes(total);

  // The drop zone and the list are the same slot in two states.
  filesPanel.hidden = count === 0;
  dropZone.hidden = count > 0;

  startButton.disabled = count === 0;
  startButton.textContent = count === 0
    ? 'Choose files first'
    : `Create share link for ${count} file${count === 1 ? '' : 's'} (${formatBytes(total)})`;
}

// Both pickers append rather than replace, so a second pick adds to the list.
for (const input of [fileInput, moreInput]) {
  input.addEventListener('change', () => {
    if (input.files) addFiles(input.files);
    input.value = '';
  });
}

// The drop zone is a <label> wrapping the input, so click and keyboard
// activation come from the browser. A click handler here would double-fire it.

for (const type of ['dragenter', 'dragover'] as const) {
  dropZone.addEventListener(type, (ev) => {
    ev.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop'] as const) {
  dropZone.addEventListener(type, (ev) => {
    ev.preventDefault();
    dropZone.classList.remove('dragging');
  });
}
dropZone.addEventListener('drop', (ev) => {
  if (ev.dataTransfer?.files.length) addFiles(ev.dataTransfer.files);
});

// Dropping anywhere on the page is friendlier than hunting for the target.
window.addEventListener('dragover', (ev) => ev.preventDefault());
window.addEventListener('drop', (ev) => ev.preventDefault());

// --- Hosting ----------------------------------------------------------------

startButton.addEventListener('click', () => void startShare());

async function startShare(): Promise<void> {
  if (selected.size === 0) return;
  startButton.disabled = true;
  startButton.textContent = 'Connecting…';
  clearError();

  try {
    await signaling.connect();
  } catch {
    showError('Could not reach the server. Check your connection and try again.');
    startButton.disabled = false;
    renderFileList();
    return;
  }

  const meta: FileMeta[] = [...selected].map(([id, file]) => ({
    id, name: file.name, size: file.size, type: file.type,
  }));

  const password = passwordInput.value.trim();
  signaling.send({ t: 'host', files: meta, ...(password ? { password } : {}) });
}

signaling.on((msg) => {
  switch (msg.t) {
    case 'hosted': {
      iceServers = msg.iceServers;
      shareUrl = `${location.origin}/d/${msg.slug}`;
      showShareScreen(msg.slug);
      return;
    }
    case 'peer-join': {
      addRecipient(msg.peerId);
      return;
    }
    case 'peer-leave': {
      const recipient = recipients.get(msg.peerId);
      if (recipient) {
        recipient.link.close();
        recipient.row.remove();
        recipients.delete(msg.peerId);
      }
      updateRecipientCount();
      return;
    }
    case 'signal': {
      void recipients.get(msg.from)?.link.handleSignal(msg.data);
      return;
    }
    case 'closed': {
      showError(msg.reason);
      return;
    }
    case 'error': {
      showError(msg.message);
      startButton.disabled = false;
      renderFileList();
      return;
    }
  }
});

function showShareScreen(slug: string): void {
  pickerSection.hidden = true;
  shareSection.hidden = false;

  $<HTMLInputElement>('#share-url').value = shareUrl;

  const qrHolder = $<HTMLElement>('#qr');
  qrHolder.replaceChildren(renderQr(shareUrl, 180));

  const summary = $<HTMLElement>('#share-summary');
  const total = [...selected.values()].reduce((sum, f) => sum + f.size, 0);
  summary.textContent =
    `${selected.size} file${selected.size === 1 ? '' : 's'} · ${formatBytes(total)} ready to send · code ${slug}`;

  if (passwordInput.value.trim()) $<HTMLElement>('#password-note').hidden = false;
  updateRecipientCount();
}

$<HTMLButtonElement>('#copy-link').addEventListener('click', async (ev) => {
  const button = ev.currentTarget as HTMLButtonElement;
  const ok = await copyToClipboard(shareUrl);
  button.textContent = ok ? 'Copied' : 'Press Ctrl+C';
  if (!ok) $<HTMLInputElement>('#share-url').select();
  setTimeout(() => { button.textContent = 'Copy'; }, 1800);
});

// --- One peer connection per recipient --------------------------------------

function addRecipient(peerId: string): void {
  const bar = el('span', { class: 'bar-fill' });
  const percent = el('span', { class: 'xfer-pct' }, '0%');
  const status = el('span', { class: 'recipient-status' }, 'Connecting…');
  const label = `Recipient ${recipients.size + 1}`;
  const row = el('li', { class: 'recipient' },
    el('div', { class: 'xfer-head' },
      el('span', { class: 'recipient-name xfer-title' }, label),
      percent,
    ),
    el('div', { class: 'bar' }, bar),
    el('div', { class: 'xfer-meta' }, status),
  );
  $<HTMLElement>('#recipients').append(row);

  const link = new PeerLink(iceServers, (data) => {
    signaling.send({ t: 'signal', to: peerId, data });
  });

  const recipient: Recipient = {
    peerId, link, channel: null, row, bar, status, percent,
    meter: new RateMeter(), label, sender: null,
  };
  recipients.set(peerId, recipient);

  const channel = link.pc.createDataChannel('transfer', { ordered: true });
  channel.binaryType = 'arraybuffer';
  recipient.channel = channel;

  channel.addEventListener('open', () => {
    status.textContent = 'Connected · waiting for their pick';
    row.classList.add('connected');
  });
  channel.addEventListener('close', () => {
    status.textContent = 'Disconnected';
    row.classList.remove('connected');
  });

  recipient.sender = new FileSender(
    channel, selected, (p: SendProgress) => onSendProgress(recipient, p), link.pc,
  );

  link.pc.addEventListener('connectionstatechange', () => {
    const state = link.pc.connectionState;
    if (state === 'failed') {
      status.textContent = 'Connection failed — their network blocked the direct route';
      row.classList.add('failed');
    }
  });

  void link.createOffer();
  updateRecipientCount();
}

function onSendProgress(recipient: Recipient, p: SendProgress): void {
  const pct = p.total === 0 ? 100 : (p.sent / p.total) * 100;
  recipient.bar.style.width = `${pct.toFixed(1)}%`;
  recipient.percent.textContent = `${pct.toFixed(0)}%`;
  const rate = recipient.meter.update(p.sent);
  recipient.status.textContent = p.sent >= p.total
    ? `Sent ${p.name}`
    : `${p.name} · ${formatBytes(p.sent)} of ${formatBytes(p.total)} · ${formatRate(rate)}`;

  if (p.sent >= p.total && p.total > 0) void reportTransfer(recipient);
}

/**
 * Once a file is through, work out what the ceiling actually was and say so.
 * "It was slow" is not actionable; "your upload was the limit" is.
 */
async function reportTransfer(recipient: Recipient): Promise<void> {
  const stats = recipient.sender?.lastTransfer;
  if (!stats) return;
  const transport = await describeTransport(recipient.link.pc);
  const lines = summarise(stats, transport);
  // The detail goes to the console; the headline verdict goes on the row.
  console.info(`[fileshare] ${recipient.label}\n  ${lines.join('\n  ')}`);
  recipient.status.title = lines.join(' · ');
}

function updateRecipientCount(): void {
  const count = recipients.size;
  $<HTMLElement>('#recipient-count').textContent = count === 0
    ? 'Waiting for the other side to open the link'
    : `${count} ${count === 1 ? 'person has' : 'people have'} opened the link.`;
  // The transfers card only means anything once somebody is connected.
  recipientsCard.hidden = count === 0;
}

// Closing the tab kills every transfer, so make that an explicit choice.
window.addEventListener('beforeunload', (ev) => {
  if (recipients.size > 0) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

renderFileList();
renderDonateButton(document.querySelector('#donate-slot'));
