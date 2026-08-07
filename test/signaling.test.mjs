// Exercises the signalling server the way two browsers would, without a browser.
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:8080/ws';
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

const files = [{ id: 'f1', name: 'report.pdf', size: 1234, type: 'application/pdf' }];

// --- 1. host / join happy path ---
{
  const up = await open();
  up.send(JSON.stringify({ t: 'host', files }));
  const hosted = await next(up);
  check('host returns a slug', hosted.t === 'hosted' && /^[a-z]+-[a-z]+-\d{3}$/.test(hosted.slug), hosted.slug);
  check('host returns ICE servers', Array.isArray(hosted.iceServers) && hosted.iceServers.length > 0);

  const down = await open();
  down.send(JSON.stringify({ t: 'join', slug: hosted.slug }));
  const joined = await next(down);
  check('join returns manifest', joined.t === 'joined' && joined.files[0].name === 'report.pdf');
  check('join identifies the uploader', joined.uploader === hosted.peerId);

  const peerJoin = await next(up);
  check('uploader is told a peer joined', peerJoin.t === 'peer-join' && peerJoin.peerId === joined.peerId);

  // --- 2. signalling relay ---
  down.send(JSON.stringify({ t: 'signal', to: joined.uploader, data: { sdp: { type: 'offer', sdp: 'x' } } }));
  const relayed = await next(up);
  check('signal is relayed to the uploader',
    relayed.t === 'signal' && relayed.from === joined.peerId && relayed.data.sdp.sdp === 'x');

  // --- 3. uploader leaving closes the channel ---
  up.close();
  const closed = await next(down);
  check('downloader is told when uploader leaves', closed.t === 'closed', closed.reason);

  const late = await open();
  late.send(JSON.stringify({ t: 'join', slug: hosted.slug }));
  const gone = await next(late);
  check('slug is gone after uploader leaves', gone.t === 'error' && gone.code === 'not-found');
  late.close(); down.close();
}

// --- 4. password gate ---
{
  const up = await open();
  up.send(JSON.stringify({ t: 'host', files, password: 'hunter2' }));
  const hosted = await next(up);

  const d1 = await open();
  d1.send(JSON.stringify({ t: 'join', slug: hosted.slug }));
  const needPw = await next(d1);
  check('join without password is refused', needPw.t === 'error' && needPw.code === 'password-required');

  d1.send(JSON.stringify({ t: 'join', slug: hosted.slug, password: 'wrong' }));
  const badPw = await next(d1);
  check('wrong password is refused', badPw.t === 'error' && badPw.code === 'bad-password');

  d1.send(JSON.stringify({ t: 'join', slug: hosted.slug, password: 'hunter2' }));
  const ok = await next(d1);
  check('correct password is accepted', ok.t === 'joined');
  up.close(); d1.close();
}

// --- 5. cross-channel signalling must not leak ---
{
  const upA = await open(); upA.send(JSON.stringify({ t: 'host', files })); const a = await next(upA);
  const upB = await open(); upB.send(JSON.stringify({ t: 'host', files })); const b = await next(upB);

  const dB = await open();
  dB.send(JSON.stringify({ t: 'join', slug: b.slug }));
  await next(dB);
  await next(upB); // peer-join

  // Downloader in channel B tries to signal the uploader of channel A.
  dB.send(JSON.stringify({ t: 'signal', to: a.peerId, data: { sdp: 'leak' } }));
  let leaked = false;
  upA.once('message', () => { leaked = true; });
  await new Promise((r) => setTimeout(r, 400));
  check('signalling cannot cross channels', !leaked);
  upA.close(); upB.close(); dB.close();
}

// --- 6. input validation ---
{
  const ws = await open();
  ws.send(JSON.stringify({ t: 'host', files: [] }));
  const empty = await next(ws);
  check('empty file list rejected', empty.t === 'error' && empty.code === 'bad-request');
  ws.close();

  const ws2 = await open();
  ws2.send(JSON.stringify({ t: 'join', slug: '../../etc/passwd' }));
  const badSlug = await next(ws2);
  check('malformed slug rejected', badSlug.t === 'error' && badSlug.code === 'not-found');
  ws2.close();

  const ws3 = await open();
  ws3.send(JSON.stringify({ t: 'host', files: [{ id: 'x', name: '../../evil.sh', size: 10, type: '' }] }));
  const hosted3 = await next(ws3);
  const d3 = await open();
  d3.send(JSON.stringify({ t: 'join', slug: hosted3.slug }));
  const j3 = await next(d3);
  check('path separators stripped from filenames', !j3.files[0].name.includes('/'), j3.files[0].name);
  ws3.close(); d3.close();
}

console.log(failures === 0 ? '\nALL SIGNALLING TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
