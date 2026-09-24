// Exercises the signalling server the way two browsers would, without a browser.
import WebSocket from 'ws';
import { createHash, randomBytes } from 'node:crypto';

const URL = (process.env.TEST_ORIGIN ?? 'http://127.0.0.1:8080')
  .replace(/^http/, 'ws') + '/ws';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures++;
}

function open() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => res(ws));
    ws.once('error', rej);
  });
}

function next(ws, timeout = 3000) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout waiting for message')), timeout);
    ws.once('message', (raw) => { clearTimeout(timer); res(JSON.parse(raw.toString())); });
  });
}

// What a browser derives from the link's secret, as far as the server can
// tell: a join token, and the verifier the sender registers for it.
function tokens() {
  const auth = randomBytes(32);
  return {
    auth: auth.toString('base64url'),
    verifier: createHash('sha256').update(auth).digest('base64url'),
  };
}
// The manifest is ciphertext to the server; any base64url blob will do here.
const SEALED = randomBytes(96).toString('base64url');
const files = [{ id: 'f1', size: 1234 }];
const host = (ws, t, extra = {}) =>
  ws.send(JSON.stringify({ t: 'host', files, sealed: SEALED, verifier: t.verifier, ...extra }));
const join = (ws, slug, auth, extra = {}) =>
  ws.send(JSON.stringify({ t: 'join', slug, auth, ...extra }));

// --- 1. host / join happy path ---
{
  const tk = tokens();
  const up = await open();
  host(up, tk);
  const hosted = await next(up);
  check('host returns a slug', hosted.t === 'hosted' && /^[a-z]+-[a-z]+-\d{3}$/.test(hosted.slug), hosted.slug);
  check('host returns ICE servers', Array.isArray(hosted.iceServers) && hosted.iceServers.length > 0);

  const down = await open();
  join(down, hosted.slug, tk.auth);
  const joined = await next(down);
  check('join returns the sealed manifest untouched', joined.t === 'joined' && joined.sealed === SEALED);
  check('the server hands out ids and sizes only',
    JSON.stringify(joined.files) === JSON.stringify(files), JSON.stringify(joined.files));
  check('join identifies the uploader', joined.uploader === hosted.peerId);

  const peerJoin = await next(up);
  check('uploader is told a peer joined', peerJoin.t === 'peer-join' && peerJoin.peerId === joined.peerId);

  // --- 2. signalling relay: sealed strings only ---
  const blob = randomBytes(64).toString('base64url');
  down.send(JSON.stringify({ t: 'signal', to: joined.uploader, data: blob }));
  const relayed = await next(up);
  check('a sealed signal is relayed as-is', relayed.t === 'signal' && relayed.from === joined.peerId && relayed.data === blob);

  let plainRelayed = false;
  up.once('message', () => { plainRelayed = true; });
  down.send(JSON.stringify({ t: 'signal', to: joined.uploader, data: { sdp: { type: 'offer', sdp: 'x' } } }));
  await new Promise((r) => setTimeout(r, 300));
  check('an unsealed signal is dropped', !plainRelayed);
  up.removeAllListeners('message');

  // --- 3. uploader leaving closes the channel ---
  up.close();
  const closed = await next(down);
  check('downloader is told when uploader leaves', closed.t === 'closed', closed.reason);

  const late = await open();
  join(late, hosted.slug, tk.auth);
  const gone = await next(late);
  check('slug is gone after uploader leaves', gone.t === 'error' && gone.code === 'not-found');
  late.close(); down.close();
}

// --- 4. the link's secret is required ---
{
  const tk = tokens();
  const up = await open();
  host(up, tk);
  const hosted = await next(up);

  const noAuth = await open();
  noAuth.send(JSON.stringify({ t: 'join', slug: hosted.slug }));
  const r1 = await next(noAuth);
  check('the slug alone is not enough', r1.t === 'error' && r1.code === 'not-found', JSON.stringify(r1));

  const wrong = await open();
  join(wrong, hosted.slug, tokens().auth);
  const r2 = await next(wrong);
  const missing = await open();
  join(missing, 'swift-otter-100', tk.auth);
  const r3 = await next(missing);
  check('a wrong secret gets a wrong-slug answer, word for word',
    r2.code === 'not-found' && r2.code === r3.code && r2.message === r3.message, `${r2.message} / ${r3.message}`);
  up.close(); noAuth.close(); wrong.close(); missing.close();
}

// --- 5. password gate ---
{
  const tk = tokens();
  const up = await open();
  host(up, tk, { password: 'hunter2' });
  const hosted = await next(up);

  const d1 = await open();
  join(d1, hosted.slug, tk.auth);
  const needPw = await next(d1);
  check('join without password is refused', needPw.t === 'error' && needPw.code === 'password-required');

  join(d1, hosted.slug, tk.auth, { password: 'wrong' });
  const badPw = await next(d1);
  check('wrong password is refused', badPw.t === 'error' && badPw.code === 'bad-password');

  join(d1, hosted.slug, tk.auth, { password: 'hunter2' });
  const ok = await next(d1);
  check('correct password is accepted', ok.t === 'joined');
  up.close(); d1.close();
}

// --- 6. cross-channel signalling must not leak ---
{
  const ta = tokens(); const tb = tokens();
  const upA = await open(); host(upA, ta); const a = await next(upA);
  const upB = await open(); host(upB, tb); const b = await next(upB);

  const dB = await open();
  join(dB, b.slug, tb.auth);
  await next(dB);
  await next(upB); // peer-join

  // Downloader in channel B tries to signal the uploader of channel A.
  dB.send(JSON.stringify({ t: 'signal', to: a.peerId, data: SEALED }));
  let leaked = false;
  upA.once('message', () => { leaked = true; });
  await new Promise((r) => setTimeout(r, 400));
  check('signalling cannot cross channels', !leaked);
  upA.close(); upB.close(); dB.close();
}

// --- 7. input validation ---
{
  const ws = await open();
  ws.send(JSON.stringify({ t: 'host', files: [], sealed: SEALED, verifier: tokens().verifier }));
  const empty = await next(ws);
  check('empty file list rejected', empty.t === 'error' && empty.code === 'bad-request');
  ws.close();

  const wsv = await open();
  wsv.send(JSON.stringify({ t: 'host', files, sealed: SEALED }));
  const noVerifier = await next(wsv);
  check('a share without a verifier is refused', noVerifier.t === 'error' && noVerifier.code === 'bad-request');
  wsv.send(JSON.stringify({ t: 'host', files, sealed: 'not base64!', verifier: tokens().verifier }));
  const badSealed = await next(wsv);
  check('a manifest that is not ciphertext-shaped is refused', badSealed.code === 'bad-request');
  wsv.close();

  const ws2 = await open();
  ws2.send(JSON.stringify({ t: 'join', slug: '../../etc/passwd', auth: tokens().auth }));
  const badSlug = await next(ws2);
  check('malformed slug rejected', badSlug.t === 'error' && badSlug.code === 'not-found');
  ws2.close();
}

console.log(failures === 0 ? '\nALL SIGNALLING TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
