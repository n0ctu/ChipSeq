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

## Running it in Docker

`server/Dockerfile` and `server/compose.yaml` are built for a box where Caddy
runs in its own container, every service lives at `/srv/docker/<name>`, and a
shared network called `edge` joins them.

```sh
mkdir -p /srv/docker/chipseq && cd /srv/docker/chipseq
cp <repo>/server/compose.yaml .
cp <repo>/server/.env.example .env   # defaults already match: edge, chipseq-relay
docker compose up -d
```

Then one site file in the central Caddy config:

```
ws.chipseq.app {
    reverse_proxy chipseq-relay:8080
}
```

The DNS record has to exist first, or Caddy cannot get a certificate for the
name.

### Releasing

Pushing a `v*` tag is the whole release. `.github/workflows/ghcr.yml` runs the
test gate, builds this Dockerfile and pushes
`ghcr.io/n0ctu/chipseq-relay:<tag>`; `server/deploy-chipseq`, run from
`chipseq-deploy.timer` every ten minutes, notices the newer tag and deploys it.

Install those once, from the checkout on the box - and once means once: the
script fetches `compose.yaml` *and its own next version* from each release tag
it deploys, validated before either can replace a working file, so this copy is
the bootstrap rather than a file to keep in sync by hand. There is no way
around that first copy: a script cannot retroactively teach the copy already on
the box to fetch it. Rollback deliberately uses the script on disk - fetching
an older script to perform the rollback would be trusting the past release's
deployer with the present release's mess.

Install:

```sh
sudo cp app/server/chipseq-deploy.{service,timer} /etc/systemd/system/
cp app/server/deploy-chipseq /srv/docker/chipseq/ && chmod +x /srv/docker/chipseq/deploy-chipseq
sudo systemctl enable --now chipseq-deploy.timer
```

**`compose.yaml` is fetched from the tag being deployed.** It belongs to the
release, not to the box: `--db` lives in compose's `command:` rather than the
image's `CMD`, so a new image on an old `compose.yaml` runs happily in memory,
passes its health gate, and has no persistence - a deploy that looks entirely
successful and silently does nothing. The reverse pairing crash-loops instead,
writing the database to a read-only root.

Failures there are non-fatal on purpose: an unreachable registry, no network at
a venue, or a tag without the file leaves the box deploying with what it
already has. A fetched file is validated before it can replace a working one,
and if the deploy then fails its health gate, that file is rolled back with the
image. Only a file *this run* installed is rolled back; restoring any
`.previous` lying around would revert compose.yaml further than the image, to a
pairing that never shipped.

Only one deploy runs at a time. systemd will not overlap a oneshot service
with itself, but a manual run alongside a timer-fired one would, and both write
`.env` - which is what the rollback path reads. Interleaving those writes could
leave `RELAY_IMAGE` naming one image, the container running another, and
`RELAY_IMAGE_PREVIOUS` pointing at something that was never live, so a later
rollback would restore the wrong thing. A `flock` on `.deploy.lock` serialises
them; a second deploy waits, and gives up after ten minutes on the assumption
that a deploy holding the lock that long is stuck rather than busy.

By hand, when you do not want to wait for the timer:

```sh
./deploy-chipseq                      # newest released tag, if the relay is idle
./deploy-chipseq --force              # ignore the idle guard
./deploy-chipseq --image ghcr.io/n0ctu/chipseq-relay:v0.7.1
./deploy-chipseq --rollback           # back to RELAY_IMAGE_PREVIOUS, now
```

Deploys are **health-gated**: a new image has to report healthy and answer
`/health` through the proxy inside two minutes, or the previous tag is put back
automatically. That is why `.env` carries the running tag and the one before it,
and why nothing here deploys `latest` - a moving tag stops pointing at the thing
you would want to return to, so it cannot be rolled back to.

Deploys also **defer while adopted badges are connected**. State is in memory by
design, so any deploy costs every paired badge a re-pair; an unattended one
waits for `online` to fall to zero rather than interrupting a set.

`online` counts adopted badges holding an open socket, which means a badge in
the middle of pairing does not hold a deploy off - it is not adopted yet, so it
is not counted. That was measured, not assumed: a connected but unadopted badge
reports `online:0` while `offers:1`, and a deploy went ahead over the top of it.
The cost is one re-pair for someone who was already pairing, which is why the
guard reads `online` anyway rather than `offers`, a field that never falls again
once it rises. For a set that matters, stop the timer rather than trusting the
guard.

The image is **anonymously pullable**, because the package inherits this
repository's visibility and the repository is public, so the box needs no
registry credential at all. That was checked against the live registry, not
assumed. If the repository ever goes private the package follows it and the
box's pulls start failing; the workflow's last step asserts an anonymous pull
works, so that surfaces as a red release rather than a deploy that silently
never happens.

Building locally is still one command, and is the right answer at a venue with
no internet:

```sh
docker build -f server/Dockerfile -t chipseq-relay:local .
RELAY_IMAGE=chipseq-relay:local docker compose up -d
```

**The service publishes no ports.** Caddy is on the same network and reaches it
by container name, so there is no host binding at all, which is a stronger
version of "bind local ports to 127.0.0.1" than binding them: there is nothing
to bind to the wrong interface. It matters here specifically because
`index.mjs` calls `listen(port)` with no host and therefore binds `0.0.0.0`, so
on bare metal only the firewall keeps the plaintext socket off the internet. It
also sidesteps Docker publishing ports into iptables ahead of ufw, where a
`-p 8080:8080` is reachable from outside while ufw reports it denied.

The image has no install step, because the relay imports only `node:` builtins.
It runs as `node` on a read-only root filesystem with `cap_drop: ALL`, and
carries no volumes, since hub state is in memory by design.

`--root` points at an empty directory so the relay answers `/ws` and `/health`
and nothing else; the app itself is served from chipseq.app. To make it host
the app too, as a venue fallback, copy the repository into the image and drop
the `--root` argument.

The whole arrangement was verified locally before it went anywhere: a Caddy
container proxying to the relay over `edge`, `/health` answering through it,
and `tools/fake-badge.mjs` completing a handshake and clock sync through the
proxy, which is the part a careless `reverse_proxy` would break.

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

## Adoptions persist

`--db <file>` keeps adoptions and sessions in SQLite, via `node:sqlite`, so a
restart does not cost every paired badge a re-pair. The compose file passes
`--db /data/relay.db` and mounts a volume for it; without the flag the relay
behaves exactly as it always did, which is the path the tests and a local run
take.

This exists because deploys became automatic. A relay with badges connected is
the normal state at an event, so "restart later" meant "never update".

Pairing codes, offers and rate limits are deliberately **not** persisted. They
expire in 120 seconds, and an offer names a socket that a restart has already
closed, so restoring one would resurrect a token for a connection that no
longer exists. Anything loaded from disk starts offline until its badge
reconnects, which is exactly what `online` already meant.

The database is rewritten whole on every change. At eight badges that is
cheaper than being clever, and it removes the only way this could go subtly
wrong: a mutation whose write was forgotten. `server/test.mjs` reloads a hub
from the same file after every operation and compares it against the live one,
so a missing write fails wherever it is - and both were confirmed to fail when
a `save()` is removed. The first version of that test saved on its own behalf
before comparing, which made it pass with every `save()` call deleted; it was
testing the store rather than the write points.

---

## What `/health` reports

`{"ok":true,"v":2,"sessions":0,"badges":0,"online":0,"codes":0,"offers":0}`.
Useful as a liveness probe as it stands - `ok` and `v` are all a healthcheck
needs. The counters are worth reading before anything automates against them,
because only one of them falls again on its own.

| field | rises when | falls when |
|---|---|---|
| `sessions` | a controller connects without a known session | **never** - nothing deletes from `sessions` |
| `badges` | a badge is adopted | forgotten or released, *not* when it disconnects |
| `online` | an adopted badge has an open socket | it disconnects - **computed live, every call** |
| `codes` | a controller mints a pairing code | swept, on the next `issueCode` |
| `offers` | a badge is offered a code | swept, on the next `issueCode` |

The sweep is the part that surprises: `sweep()` is called from `issueCode()` and
nowhere else, and `stats()` reports `codes.size` and `offers.size` without
filtering by expiry. So a badge that connects once and leaves keeps `offers` at
1 indefinitely - the entry is expired, and nothing looks at it again until some
controller happens to mint a code.

That is harmless for a display and wrong for a decision. **`online` is the only
field safe to gate on**, because it is derived from the live socket state on
every request rather than accumulated. Anything using `sessions`, `badges`,
`codes` or `offers` as "is the relay busy" will latch on after the first badge
of the event and never let go.

Deliberate, and not worth changing: at eight badges none of these grow enough to
matter, and a sweeper on a timer would be a background task to reason about in a
process whose whole appeal is that it has none.

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
