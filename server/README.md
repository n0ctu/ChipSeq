# ChipSeq badge server

Relays a track from the sequencer to one or more badges. Node, no
dependencies — including the WebSocket server, which is `ws.mjs`, because Node
ships a client but not a server and this repository does not take packages.

```sh
node server/index.mjs --port 8080          # serves the app AND the socket
node server/test.mjs                       # 34 assertions, no hardware needed
node tools/fake-badge.mjs --url ws://localhost:8080/ws --count 4
```

The badge side of the protocol is **`docs/badge-protocol.md`** — that is the
contract with the firmware. This file documents the *controller* side (the
sequencer) and deployment.

---

## Why it serves the app too

`--root` defaults to the repository, so `http://host:8080/` is ChipSeq and
`ws://host:8080/ws` is the socket. One origin means no CORS and no mixed
content, and — with Tailscale Funnel — one thing to publish rather than two.

It also gives you a copy of the sequencer that works at the venue with no
internet at all. GitHub Pages stays the public build.

---

## Publishing with Tailscale Funnel

Funnel gives a valid certificate on `<node>.<tailnet>.ts.net` with no domain to
buy, no port to forward and nothing to renew. Badges need **no** Tailscale
client — Funnel accepts ordinary public clients, which is the only reason this
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

Every public client is **relayed through Tailscale's infrastructure** — a
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

## Controller protocol

The sequencer's half. One WebSocket to `/ws`, JSON frames, same as the badge —
the roles are told apart by the first message.

### Connecting

```jsonc
// -> server. Omit `session` the first time; reuse it afterwards.
{ "t": "hello", "role": "controller", "session": "<hex>" }

// <- server
{ "t": "welcome", "v": 1, "session": "<hex>", "s": 1765432109876, "badges": [] }
```

`session` is the ownership boundary: badges paired under it are visible and
controllable only to controllers holding it. Keep it in `localStorage` so a
reload keeps its badges. An unknown session is not an error — it becomes a new
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
| `{t:"forget", id}` | drop the adoption and disconnect it. |
| `{t:"note", id, p, ms}` | live mode: play now. |
| `{t:"sched", id, t0, n}` | scheduled mode: play at server time `t0 + offset`. |
| `{t:"stop", id?}` | silence one badge, or all of them when `id` is omitted. |

`{t:"badges", badges:[…]}` is **pushed** whenever the roster changes — a badge
connecting, dropping, being renamed or remapped. Do not poll for it.

A track may drive several badges; two playing the same part is a supported
arrangement, so mapping is deliberately not exclusive.

---

## Security

Reachable from the public internet, so:

- Pairing codes are single-use and expire in 120 seconds.
- A code is consumed even by a **failed** attempt against a real code — one
  that survived a wrong guess would be one being brute-forced.
- Pair attempts are rate-limited per address (10 per minute), read from
  `x-forwarded-for` when behind Funnel, since the socket address there is the
  relay rather than the client.
- Every controller action checks session ownership. `server/test.mjs` asserts a
  second controller can neither see nor play another session's badges — and
  that test was confirmed to fail when the check is removed.

State is in memory. At eight badges there is nothing worth persisting, and a
restart costs one re-pair.
