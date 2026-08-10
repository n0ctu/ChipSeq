# ChipSeq badge server

Relays a track from the sequencer to one or more badges. Node, no
dependencies - including the WebSocket server, which is `ws.mjs`, because Node
ships a client but not a server and this repository does not take packages.

```sh
node server/index.mjs --port 8080          # serves the app AND the socket
node server/test.mjs                       # no hardware needed
node tools/fake-badge.mjs --url ws://localhost:8080/ws --count 4
```

The badge side of the protocol is **`docs/badge-protocol.md`** - the contract
with the firmware, which is not tracked here (see below). This file documents
the *controller* side (the sequencer) and deployment.

---

## Why it serves the app too

`--root` defaults to the repository, so `http://host:8080/` is ChipSeq and
`ws://host:8080/ws` is the socket. One origin means no CORS and no mixed
content, and - with Tailscale Funnel - one thing to publish rather than two.

It also gives you a copy of the sequencer that works at the venue with no
internet at all. GitHub Pages stays the public build.

One caveat if you are relying on that offline: the app installs as a PWA and
caches itself, but **service workers need a secure context**. `localhost` and
the Funnel hostname qualify; `http://192.168.x.x:8080` does not, and the
browser will not register a worker there at all. Reaching the venue server by
LAN address works fine while it is running - it just is not the thing that
keeps working after the laptop reboots.

---

## Publishing with Tailscale Funnel

Funnel gives a valid certificate on `<node>.<tailnet>.ts.net` with no domain to
buy, no port to forward and nothing to renew. Badges need **no** Tailscale
client - Funnel accepts ordinary public clients, which is the only reason this
works with firmware we do not control.

```sh
node server/index.mjs --port 8080          # bind locally, any port
tailscale funnel --bg 8080                 # publish it on 443
tailscale funnel status
```

Then the app is at `https://<node>.<tailnet>.ts.net/` and the socket at
`wss://<node>.<tailnet>.ts.net/ws`.

One-time tailnet setup: HTTPS certificates enabled, and the `funnel` attribute
granted in the ACLs. Both are admin actions on the tailnet, not something the
server can arrange for itself.

**Funnel publishes on 443, 8443 or 10000 only.** The server binds wherever you
like; the funnel mapping must land on one of those three.

### What Funnel costs

Every public client is **relayed through Tailscale's infrastructure** - a
browser or badge on the open internet cannot reach the node directly, so there
is no NAT-traversal fast path. The relay is TCP-based, not built for low
latency, and rate-limited as a shared resource.

That is survivable for scheduled playback, which is designed to absorb it, and
poor for live note-by-note. If badges and server share a WiFi network, point
the badges at the LAN address instead: the protocol requires the address to be
configurable precisely so that choice stays open.

### systemd

```ini
[Unit]
Description=ChipSeq badge server
After=network-online.target

[Service]
ExecStart=/usr/bin/node /srv/chipseq/server/index.mjs --port 8080
Restart=always
User=chipseq

[Install]
WantedBy=multi-user.target
```

---

## The badge protocol documents

`docs/badge-protocol.md`, `badge-tune-format.md`, `badge-mesh.md`,
`badge-app.md`, `badge-handover.md` and `badge-unadopt.md` are the handover for
the firmware team and are **not in this repository** - the repository is served
verbatim as the GitHub Pages site, so anything tracked here is public. They are
distributed to that team directly.

Code comments still cite them by section, because they remain the contract this
server and `tools/fake-badge.mjs` are built against. `tools/fake-badge.mjs` is
the executable version of the same thing, and it *is* public - when the prose
is unavailable, that file is the specification.

---

## Controller protocol

The sequencer's half. One WebSocket to `/ws`, JSON frames, same as the badge -
the roles are told apart by the first message.

### Connecting

```jsonc
// -> server. Omit `session` the first time; reuse it afterwards.
{ "t": "hello", "role": "controller", "session": "<hex>" }

// <- server
{ "t": "welcome", "v": 2, "session": "<hex>", "s": 1765432109876, "badges": [] }
```

`session` is the ownership boundary: badges paired under it are visible and
controllable only to controllers holding it. Keep it in `localStorage` so a
reload keeps its badges. An unknown session is not an error - it becomes a new
one, because a browser must be able to recover from a server restart.

`s` is the server clock, and the server's clock is authoritative for everything
timed.

### Messages

| → server | effect |
|---|---|
| `{t:"code"}` | mint a pairing code. Replies `{t:"code", code, expires, ttl}`. Valid 120 s, single use. |
| `{t:"now"}` | replies `{t:"now", s}`. Re-sync the browser against the server clock. |
| `{t:"rename", id, name}` | rename a badge; the badge is told too. |
| `{t:"map", id, trackId}` | map to a track, or `null` to unmap. Unmapping sends `stop`, so the last note cannot hang. |
| `{t:"forget", id}` | drop the adoption. The badge is told on its existing socket and handed a fresh pairing code, rather than being disconnected. |
| `{t:"note", id, p, ms}` | live mode: play now. |
| `{t:"sched", id, t0, n}` | scheduled mode: play at server time `t0 + offset`. |
| `{t:"stop", id?}` | silence one badge, or all of them when `id` is omitted. |

`{t:"badges", badges:[…]}` is **pushed** whenever the roster changes - a badge
connecting, dropping, being renamed or remapped. Do not poll for it. Each entry
is `{id, name, fw, caps, trackId, online, lastSeen, lib}`, where `caps` is what
the badge said it can do (`note`, `sched`, `store`, `mesh`) and `lib` is its
last reported tune library or `null`.

**Address by capability, not by hope.** A badge that did not advertise `store`
has no library; hide the control rather than sending frames it will ignore.

A track may drive several badges; two playing the same part is a supported
arrangement, so mapping is deliberately not exclusive.

### Uploading tunes (v2)

These are relayed to the badge, which answers them. The server holds **no tune
bytes at any point** - an upload that dies is retried by the controller, which
is what keeps "state is in memory" true even while megabytes flow through.

Note the addressing: `badge` names the badge, `id` is the **tune** id (its
CRC-32 as hex). The server strips `badge` before forwarding, so the badge sees
exactly what `docs/badge-protocol.md` §6 documents.

| → server | effect |
|---|---|
| `{t:"lib?", badge}` | ask a badge what it holds |
| `{t:"put", badge, id, name, bytes, chunks, tracks}` | announce an upload |
| `{t:"put_data", badge, id, seq, d}` | one chunk, ≤1024 raw bytes, base64 in `d` |
| `{t:"put_end", badge, id}` | commit; the badge verifies the CRC |
| `{t:"drop", badge, id}` | delete a stored tune |

| ← server | meaning |
|---|---|
| `{t:"put_ack", badge, id, seq}` | that chunk is safe on the badge |
| `{t:"put_done", badge, id, ok, crc?, reason?}` | committed, or refused (`crc`, `space`, `format`, `abort`, `offline`) |
| `{t:"lib", badge, tunes, freeBytes, maxTunes}` | the badge's library, also pushed unprompted after a change |

`badge` on the replies is **stamped by the server**, not taken from the badge's
frame - a badge must not be able to claim it is a different badge.

Flow control is the controller's job: at most **4 chunks unacknowledged**, resend
anything unacked after **3 seconds**. `js/net/badge-upload.js` implements it.

`offline` as a `put_done` reason means the badge is not connected or is not
yours; it is generated by the server, not the badge.

Frames over **8 KB** are refused with `{t:"error", code:"big"}` without closing
the connection - a guard against an unbounded relay buffer, not a constraint on
a correct sequencer.

---

## Security

Reachable from the public internet, so:

- Pairing codes are single-use and expire in 120 seconds.
- A code is consumed even by a **failed** attempt against a real code - one
  that survived a wrong guess would be one being brute-forced.
- Pair attempts are rate-limited per address (10 per minute), read from
  `x-forwarded-for` when behind Funnel, since the socket address there is the
  relay rather than the client.
- **A badge can end its own adoption** (`{t:"release"}`, protocol §3.4), which
  no session owns and none can veto. That is deliberate: the authority is being
  the badge, and anyone able to forge it could already impersonate the badge
  entirely. It is also the only way out of an adoption whose controller lost
  its session - the badge would otherwise reconnect as known, be offered no
  pairing code, and be adoptable by nobody until the server restarted.
- Every controller action checks session ownership, **including upload**.
  `server/test.mjs` asserts a second controller can neither see nor play
  another session's badges, nor upload to one - and each of those was
  confirmed to fail when the check is removed.
- The badge→controller path is an **allowlist** (`put_ack`, `put_done`, `lib`),
  not a passthrough. The badge is on the far side of the internet, and a relay
  that forwards anything is one that forwards whatever an attacker puts in it.
- Protocol v2 is a **hard cut**: a badge announcing any other version is told
  `{t:"error", code:"version", need:2}` and disconnected, rather than being
  half-supported.

State is in memory. At eight badges there is nothing worth persisting, and a
restart costs one re-pair.
