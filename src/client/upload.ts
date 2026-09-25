import type { ClientMessage, FileMeta, FileStub, RTCIceServerConfig } from '../shared/protocol.js';
import { MAX_FILES } from '../shared/protocol.js';
import {
  $, copyToClipboard, el, formatBytes, formatRate, RateMeter, Signaling, uid,
} from './common.js';
import { deriveKeys, newSecret, seal, unseal, type ShareKeys } from './crypto.js';
import { renderDonateButton } from './donate.js';
import { renderQr } from './qr.js';
import { FileSender, PeerLink, type SendProgress } from './transfer.js';
import { describeTransport, summarise } from './diagnostics.js';

/**
 * Someone receiving files. Keyed by `rid`, an id their page picks and sends us
 * sealed, because their address on the server (peerId) changes every time
 * their connection to it drops and comes back. The direct connection can
 * outlive that, or be rebuilt under the same row when it does not.
 */
interface Recipient {
  rid: string;
  /** Current address on the server; null while they are away from it. */
  peerId: string | null;
  link: PeerLink | null;
  channel: RTCDataChannel | null;
  everConnected: boolean;
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
/** Server address -> rid, for routing what the server relays. */
const peerRid = new Map<string, string>();
const signaling = new Signaling();
/** People who opened the link and are waiting for the sender's say-so, by rid. */
const pending = new Map<string, { peerId: string; row: HTMLElement }>();
/** What we registered, kept so it can be registered again after a drop. */
let hosting: Extract<ClientMessage, { t: 'host' }> | null = null;
let slug = '';
let ended = false;
let iceServers: RTCIceServerConfig[] = [];
let shareUrl = '';
let keys: ShareKeys | null = null;
let askFirst = false;
let manifest: FileMeta[] = [];

/** Everything sent through the server is sealed with the link's key. */
function sendSealed(to: string, data: unknown): void {
  if (keys) signaling.send({ t: 'signal', to, data: seal(keys.enc, data) });
}

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
const approveInput = $<HTMLInputElement>('#approve');
const pickerSection = $<HTMLElement>('#picker');
const shareSection = $<HTMLElement>('#share');
const errorBox = $<HTMLElement>('#error');
const serverNote = $<HTMLElement>('#server-note');

function noteServer(text: string | null): void {
  serverNote.textContent = text ?? '';
  serverNote.hidden = text === null;
}

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

  const meta: FileMeta[] = manifest = [...selected].map(([id, file]) => ({
    id, name: file.name, size: file.size, type: file.type,
  }));
  // The server gets ids and sizes; the names go inside the sealed manifest.
  const stubs: FileStub[] = meta.map(({ id, size }) => ({ id, size }));

  keys = deriveKeys(newSecret());
  if (!keys) return;
  askFirst = approveInput.checked;
  const password = passwordInput.value.trim();
  // Asking first also keeps the file names back: a leaked link then shows
  // nothing at all until the sender lets that person in.
  hosting = {
    t: 'host', files: stubs, sealed: seal(keys.enc, askFirst ? { approval: true } : meta),
    verifier: keys.verifier,
    ...(password ? { password } : {}),
  };
  signaling.send(hosting);
}

/**
 * After our line to the server dropped - or the server restarted - register
 * the same share again under the same slug, so the link already handed out
 * keeps working. Transfers between the browsers never noticed.
 */
function rehost(): void {
  if (!hosting || ended) return;
  signaling.send({ ...hosting, slug });
}

signaling.onDown(() => {
  if (ended) return;
  noteServer('Lost the connection to the server. Reconnecting… Transfers already running carry on.');
  peerRid.clear();
  for (const r of recipients.values()) r.peerId = null;
  // Anyone still waiting to be let in will knock again once we are back.
  for (const { row } of pending.values()) row.remove();
  pending.clear();
  updateRecipientCount();
});
signaling.onUp(rehost);

signaling.on((msg) => {
  if (ended) return;
  switch (msg.t) {
    case 'hosted': {
      iceServers = msg.iceServers;
      const first = slug === '';
      const changed = !first && msg.slug !== slug;
      slug = msg.slug;
      // The secret rides in the fragment, which browsers never send to a server.
      shareUrl = `${location.origin}/d/${msg.slug}#${keys?.secret ?? ''}`;
      if (first || changed) showShareScreen();
      noteServer(changed
        ? 'The server gave this share a new link after a restart. Send the new one; '
          + 'transfers already running are not affected.'
        : null);
      return;
    }
    case 'peer-join':
      // Nothing to do until their page says who it is (see onHello).
      return;
    case 'peer-leave': {
      const rid = peerRid.get(msg.peerId);
      peerRid.delete(msg.peerId);
      if (!rid) return;
      const waiting = pending.get(rid);
      if (waiting?.peerId === msg.peerId) {
        waiting.row.remove();
        pending.delete(rid);
      }
      // Their line to the server went; a direct connection may well live on.
      const recipient = recipients.get(rid);
      if (recipient?.peerId === msg.peerId) recipient.peerId = null;
      updateRecipientCount();
      return;
    }
    case 'signal': {
      // Anything that does not decrypt was not written by a holder of the link.
      const data = keys ? unseal<Record<string, unknown>>(keys.enc, msg.data) : null;
      if (data === null || typeof data !== 'object') return;
      if (data['ctl'] === 'hello') {
        onHello(msg.from, data['rid'], data['want']);
        return;
      }
      const rid = peerRid.get(msg.from);
      if (rid) void recipients.get(rid)?.link?.handleSignal(data);
      return;
    }
    case 'closed': {
      // Closed by the operator, locked or expired: final. Stop sending too.
      ended = true;
      noteServer(null);
      showError(msg.reason);
      for (const r of recipients.values()) r.link?.close();
      signaling.close();
      return;
    }
    case 'error': {
      if (slug) {
        // Registering again failed (rate limit, server full). Try once more
        // shortly; running transfers do not depend on it.
        noteServer(`${msg.message} Trying again shortly…`);
        window.setTimeout(rehost, 10_000);
        return;
      }
      showError(msg.message);
      startButton.disabled = false;
      renderFileList();
      return;
    }
  }
});

/**
 * A recipient's page introduces itself - on first arrival, and again after
 * any reconnect. `want` is "connect" when it needs a (new) direct connection
 * and "keep" when its connection survived and it only has a new address.
 */
function onHello(peerId: string, rid: unknown, want: unknown): void {
  if (typeof rid !== 'string' || !/^[0-9a-f-]{36}$/.test(rid)) return;
  peerRid.set(peerId, rid);

  const known = recipients.get(rid);
  if (known) {
    known.peerId = peerId;
    if (want === 'connect') connect(known);
    return;
  }
  const waiting = pending.get(rid);
  if (waiting) {
    waiting.peerId = peerId;
    sendSealed(peerId, { ctl: 'wait' });
    return;
  }
  if (askFirst) askAbout(peerId, rid);
  else addRecipient(peerId, rid);
}

function showShareScreen(): void {
  pickerSection.hidden = true;
  shareSection.hidden = false;

  $<HTMLInputElement>('#share-url').value = shareUrl;

  const qrHolder = $<HTMLElement>('#qr');
  qrHolder.replaceChildren(renderQr(shareUrl, 180));

  const summary = $<HTMLElement>('#share-summary');
  const total = [...selected.values()].reduce((sum, f) => sum + f.size, 0);
  summary.textContent =
    `${selected.size} file${selected.size === 1 ? '' : 's'} · ${formatBytes(total)} ready to send`;

  if (passwordInput.value.trim()) $<HTMLElement>('#password-note').hidden = false;
  if (askFirst) $<HTMLElement>('#approve-note').hidden = false;
  updateRecipientCount();
}

$<HTMLButtonElement>('#copy-link').addEventListener('click', async (ev) => {
  const button = ev.currentTarget as HTMLButtonElement;
  const ok = await copyToClipboard(shareUrl);
  button.textContent = ok ? 'Copied' : 'Press Ctrl+C';
  if (!ok) $<HTMLInputElement>('#share-url').select();
  setTimeout(() => { button.textContent = 'Copy'; }, 1800);
});

// --- Asking first ------------------------------------------------------------

/**
 * With "ask me first" on, a newcomer gets no connection - and so no files - until
 * the sender allows it. The newcomer's page is told to wait, through the same
 * sealed channel, so the server cannot fake an approval either.
 */
function askAbout(peerId: string, rid: string): void {
  sendSealed(peerId, { ctl: 'wait' });

  const allow = el('button', { class: 'btn', type: 'button' }, 'Allow');
  const decline = el('button', { class: 'btn btn-secondary', type: 'button' }, 'Decline');
  const row = el('li', { class: 'recipient pending' },
    el('div', { class: 'xfer-head' },
      el('span', { class: 'recipient-name xfer-title' }, 'Someone opened the link'),
    ),
    el('div', { class: 'xfer-meta' }, 'They cannot see or download anything until you allow it.'),
    el('div', { class: 'approve-actions' }, allow, decline),
  );
  $<HTMLElement>('#recipients').append(row);
  pending.set(rid, { peerId, row });

  // Their address may have changed while the question was on screen.
  const settle = (): string => {
    const current = pending.get(rid)?.peerId ?? peerId;
    row.remove();
    pending.delete(rid);
    return current;
  };
  allow.addEventListener('click', () => {
    const current = settle();
    sendSealed(current, { ctl: 'manifest', files: manifest });
    addRecipient(current, rid);
  });
  decline.addEventListener('click', () => {
    sendSealed(settle(), { ctl: 'declined' });
    updateRecipientCount();
  });
  updateRecipientCount();
}

// --- One peer connection per recipient --------------------------------------

function addRecipient(peerId: string, rid: string): void {
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

  const recipient: Recipient = {
    rid, peerId, link: null, channel: null, everConnected: false, row, bar, status, percent,
    meter: new RateMeter(), label, sender: null,
  };
  recipients.set(rid, recipient);
  connect(recipient);
  updateRecipientCount();
}

/**
 * Opens a direct connection to a recipient, replacing any earlier one. Called
 * once on arrival, and again whenever their page asks after losing it - the
 * recipient then requests the rest of the file from where it stopped.
 */
function connect(r: Recipient): void {
  r.link?.close();
  const link = new PeerLink(iceServers, (data) => {
    if (r.peerId) sendSealed(r.peerId, data);
  });
  r.link = link;
  if (r.everConnected) r.status.textContent = 'Reconnecting…';

  const channel = link.pc.createDataChannel('transfer', { ordered: true });
  channel.binaryType = 'arraybuffer';
  r.channel = channel;

  channel.addEventListener('open', () => {
    if (r.link !== link) return;
    r.status.textContent = r.everConnected ? 'Reconnected' : 'Connected · waiting for their pick';
    r.everConnected = true;
    r.row.classList.add('connected');
    r.row.classList.remove('failed');
  });
  channel.addEventListener('close', () => {
    if (r.link !== link) return;
    r.status.textContent = r.everConnected
      ? 'Connection lost — waiting for them to reconnect…'
      : 'Disconnected';
    r.row.classList.remove('connected');
  });

  r.sender = new FileSender(
    channel, selected, (p: SendProgress) => onSendProgress(r, p), link.pc,
  );

  link.pc.addEventListener('connectionstatechange', () => {
    if (r.link !== link || link.pc.connectionState !== 'failed') return;
    if (r.everConnected) {
      r.status.textContent = 'Connection lost — waiting for them to reconnect…';
      return;
    }
    r.status.textContent = 'Connection failed — their network blocked the direct route';
    r.row.classList.add('failed');
  });

  void link.createOffer();
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
  if (!recipient.link) return;
  const transport = await describeTransport(recipient.link.pc);
  const lines = summarise(stats, transport);
  // The detail goes to the console; the headline verdict goes on the row.
  console.info(`[fileshare] ${recipient.label}\n  ${lines.join('\n  ')}`);
  recipient.status.title = lines.join(' · ');
}

function updateRecipientCount(): void {
  const count = recipients.size + pending.size;
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

// And once it is closing, say so - both ways, as neither is guaranteed to get
// out in time - so recipients stop waiting to resume instead of trying for
// ten minutes.
window.addEventListener('pagehide', () => {
  for (const r of recipients.values()) {
    r.sender?.sayBye();
    if (r.peerId) sendSealed(r.peerId, { ctl: 'bye' });
  }
});

renderFileList();
renderDonateButton(document.querySelector('#donate-slot'));
