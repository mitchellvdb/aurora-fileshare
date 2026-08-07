# Aurora FileShare

Peer-to-peer file transfers in the browser, in the spirit of FilePizza (whose
hosted instance went down). Files travel **directly from the sender's browser to
the recipient's** over an encrypted WebRTC data channel. The server only
introduces the two browsers to each other — it never sees, stores, or relays a
single byte of file content.

Built for `fileshare.aurorahosting.nl`.

## Why this shape

- **No storage, no size limit.** There is nothing to upload, so there is nothing
  to cap, scan, or clean up. A 50 GB file works the same as a 5 MB one.
- **Cheap to host.** Only signalling and static assets cross the wire. A share
  costs a few KB of RAM, which is what makes running it on a home connection
  behind a Cloudflare Tunnel reasonable.
- **Encrypted by construction.** WebRTC data channels are DTLS-encrypted; there
  is no mode in which content is readable by the server.

The trade-off: the sender's tab must stay open, because the sender *is* the
server for that file.

## How it works

```
  Sender browser                Signalling (this app)             Recipient browser
  ──────────────                ─────────────────────             ─────────────────
  pick files ──── host ───────────▶ slug + channel
                                    ◀─── join ────────────────────  open /d/<slug>
                 ◀── peer-join ────
  create offer ── signal ─────────▶ relay ──── signal ───────────▶  answer
                 ◀───────────── SDP / ICE relayed both ways ─────▶

  ═══════════════ WebRTC data channel, direct, DTLS-encrypted ══════════════════
  file.slice() ──────────── 64 KiB chunks, backpressured ─────────▶ Service Worker
                                                                    └─▶ disk
```

Downloads are streamed through a Service Worker, so the recipient's browser
writes to disk incrementally instead of buffering the whole file in memory. On
browsers where that is unavailable (no secure context, or no transferable
streams) it falls back to an in-memory Blob and says so in the UI.

When a share holds several files, the recipient can take them as one `.zip`.
The archive is muxed on the fly as the bytes arrive - STORE method, no
compression, with CRC-32s written after each payload in a data descriptor, so
nothing has to be buffered or known in advance. ZIP64 kicks in automatically
past the 4 GB boundaries. Because the manifest gives every file size up front,
the exact archive length is computed before the first byte, so the browser gets
a real `Content-Length` and a true progress bar. Individual files can still be
downloaded on their own.

Backpressure runs end to end: the receiver's disk writer gates the data channel,
which gates the sender's reads. Nothing accumulates unboundedly.

## Layout

```
src/shared/protocol.ts    Wire types shared by server and browser
src/server/              Signalling server: WS relay, channel registry, static files
src/client/              Browser: upload page, download page, transfer, zip, service worker
public/                  HTML, CSS, built bundles
deploy/                  LXC creation, bootstrap, systemd unit, Cloudflare Tunnel
test/                    Signalling, ZIP format, and real two-browser transfer tests
```

## Development

```bash
npm install
npm run build
npm start                 # http://localhost:8080
npm test                  # signalling + real browser transfers (needs chromium)
npm run typecheck
```

`npm test` boots the server on an ephemeral port, then drives real Chromium
pages through actual WebRTC transfers and verifies the received bytes by
SHA-256. Archives are checked against both `unzip -t` and Python's `zipfile`,
which is an implementation with nothing in common with ours.

> Browser tests need chromium (`apt install chromium`, or set `CHROME_PATH`).
> They force `LANG=C.UTF-8`: under `LANG=C`, Chromium saves any non-ASCII
> filename as `download`, which fails the filename assertions for reasons
> unrelated to this code.

## Deploying

On the Proxmox host:

```bash
bash deploy/create-lxc.sh                     # CTID/IP/etc. overridable by env
bash deploy/make-release.sh /tmp/app.tar.gz
pct push <CTID> /tmp/app.tar.gz /root/aurora-fileshare.tar.gz
pct push <CTID> deploy/bootstrap.sh /root/bootstrap.sh
pct exec <CTID> -- bash /root/bootstrap.sh
```

Then inside the container, to publish it:

```bash
TUNNEL_TOKEN=eyJ... bash /opt/aurora-fileshare/deploy/setup-tunnel.sh
```

Configuration lives in `.env` (see `.env.example`).

## The NAT caveat

STUN alone connects the large majority of peer pairs. When *both* ends sit
behind symmetric NAT — some corporate and mobile networks — a direct path does
not exist and the transfer needs a TURN relay.

`TURN_URL` is wired up and ready, but **TURN cannot run through a Cloudflare
Tunnel**: it needs a directly reachable UDP port, and tunnels carry HTTP only.
Adding it means exposing coturn some other way (a port forward, or a small VPS).
Until then, affected pairs see a clear "both networks are blocking peer-to-peer
traffic" message rather than a silent hang.

Note that a TURN relay also means those transfers consume your bandwidth, which
is exactly what the peer-to-peer design otherwise avoids.

## Security notes

- Strict CSP: no inline script or style, no third-party origins.
- Passwords are salted and scrypt-hashed in memory; only the hash is compared,
  in constant time.
- Signalling is scoped per channel — a peer cannot signal into another channel.
- Filenames are stripped of path separators server-side and encoded per RFC 6266
  on the way out.
- Channels are in-memory only and expire on idle (`CHANNEL_TTL_MINUTES`).
- The systemd unit runs unprivileged under `ProtectSystem=strict` with a
  read-only application directory.

## License

MIT.
