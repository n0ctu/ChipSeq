// The badge mesh, simulated. Reference implementation of docs/badge-mesh.md.
//
//   node tools/fake-mesh.mjs
//   node tools/fake-mesh.mjs --badges 8 --loss 0.1 --skew 200 --stall 120@45s
//   node tools/fake-mesh.mjs --song bad-apple --drift 80 --json
//
// Two jobs, the same two tools/fake-badge.mjs has. It is the executable
// version of the mesh specification - when the document is ambiguous, this is
// what the numbers came from - and it makes the design testable without eight
// pieces of hardware.
//
// What it does NOT simulate, stated plainly because the alternative is someone
// trusting it: real ESP-NOW loss patterns, WiFi channel contention, actual
// crystal behaviour, and flash write latency. It models packet loss as
// independent per recipient, latency as a constant plus uniform jitter, and
// clock error as a fixed skew plus constant drift. Those are assumptions, not
// measurements. What it DOES establish is whether the protocol's arithmetic
// holds up: whether badges converge, whether corrections skip notes, and how
// far apart they end up.
//
// Everything runs on a virtual clock, so a three-minute song takes a moment
// and the same seed gives the same run.

import { buildTune, parseTune, noteAt, NONE } from '../js/core/badge-tune.js';
import { migrate } from '../js/core/doc.js';
import { readFile } from 'node:fs/promises';

// ---- protocol constants (docs/badge-mesh.md) ----

export const BEACON_MS = 500;
export const TSYNC_BURST = 8; // exchanges during ARM
export const TSYNC_BURST_MS = 100;
export const TSYNC_IDLE_MS = 2000; // while playing
export const TSYNC_WINDOW = 5; // median of the last N
export const ARM_TIMEOUT_MS = 3000;
export const PLAY_LEAD_MS = 500; // how far ahead t0 is set
export const PLAY_REPEAT_MS = 100;
export const TICK_MS = 1000;
export const FRAGMENT_BYTES = 230; // ESP-NOW payload minus our header
export const NACK_AFTER_MS = 400; // quiet time before asking for repairs
export const PLAYER_STEP_MS = 2; // the evaluation interval
export const MIN_REMAINDER_MS = 20; // below this, wait for the next onset

// ---- deterministic randomness ----
//
// Math.random would make a failing run impossible to reproduce, which is the
// one thing a simulator has to be able to do.
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export function median(xs) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---- the radio ----

// One shared broadcast medium. Delivery is per-recipient: a frame one badge
// misses is a frame another may receive, which is what makes NACK repair
// necessary rather than decorative.
export class Bus {
  constructor({ loss = 0, latency = 2, jitter = 1, rand = rng(1) } = {}) {
    this.loss = loss;
    this.latency = latency;
    this.jitter = jitter;
    this.rand = rand;
    this.nodes = [];
    this.queue = []; // { at, to, frame }
    this.sent = 0;
    this.dropped = 0;
  }

  join(node) {
    this.nodes.push(node);
    node.bus = this;
  }

  // to === null broadcasts.
  send(now, from, to, frame) {
    this.sent++;
    for (const n of this.nodes) {
      if (n === from) continue;
      if (to && n.id !== to) continue;
      if (this.rand() < this.loss) { this.dropped++; continue; }
      const delay = this.latency + this.rand() * this.jitter;
      this.queue.push({ at: now + delay, to: n, frame: { ...frame, from: from.id } });
    }
  }

  deliver(now) {
    if (!this.queue.length) return;
    const ready = this.queue.filter((p) => p.at <= now);
    if (!ready.length) return;
    this.queue = this.queue.filter((p) => p.at > now);
    // Sorted so delivery order is a function of time, not of array order.
    ready.sort((a, b) => a.at - b.at);
    for (const p of ready) p.to.receive(now, p.frame);
  }
}

// ---- a badge on the mesh ----

export class MeshBadge {
  constructor({ id, tune = null, skewMs = 0, driftPpm = 0, role = 'performer', rand = rng(2) }) {
    this.id = id;
    this.role = role;
    this.rand = rand;

    // Its own clock: wrong by skewMs at the start, and wrong by a bit more
    // every second after that. Without both, the sync code would look correct
    // while doing nothing.
    this.skewMs = skewMs;
    this.driftPpm = driftPpm;

    this.tune = tune; // { bytes, parsed } or null - a performer may arrive empty
    this.track = null;
    this.offset = 0; // badge clock -> mesh clock
    this.offsets = [];
    this.pendingSync = new Map(); // c -> sent-at

    this.t0 = null; // mesh time at song position 0
    this.sounding = NONE;
    this.armed = false;
    this.ready = false;
    this.joined = new Map(); // conductor: id -> { hasTune, track, ready }

    this.rx = null; // an incoming tune: { id, bytes, fragCount, have: Map }
    this.lastFragmentAt = 0;

    // Measurement, not protocol.
    this.onsets = []; // { index, songMs, wantMs, error }
    this.retriggers = 0;
    this.stallUntil = -1;
  }

  // The badge's own millisecond counter.
  millis(now) {
    return now * (1 + this.driftPpm / 1e6) + this.skewMs;
  }

  meshNow(now) {
    return this.millis(now) + this.offset;
  }

  say(now, frame, to = null) {
    this.bus.send(now, this, to, frame);
  }

  // ---- receiving ----

  receive(now, f) {
    if (now < this.stallUntil) return; // a stalled badge misses frames too
    switch (f.t) {
      case 'BEACON': return this.onBeacon(now, f);
      case 'JOIN': return this.onJoin(now, f);
      case 'WELCOME': return this.onWelcome(now, f);
      case 'TUNE_META': return this.onTuneMeta(now, f);
      case 'TUNE_DATA': return this.onTuneData(now, f);
      case 'TUNE_NACK': return this.onNack(now, f);
      case 'CLAIM': {
        const e = this.joined.get(f.from);
        if (e) e.track = f.track;
        return;
      }
      case 'TSYNC_REQ': return this.say(now, { t: 'TSYNC_RSP', c: f.c, s: this.millis(now) }, f.from);
      case 'TSYNC_RSP': return this.onSyncReply(now, f);
      case 'ARM': return this.onArm(now, f);
      case 'READY': {
        const e = this.joined.get(f.from);
        if (e) { e.ready = true; e.spread = f.spreadMs; }
        return;
      }
      case 'PLAY': return this.onPlay(now, f);
      case 'TICK': return this.onTick(now, f);
      case 'STOP': this.t0 = null; this.sounding = NONE; return;
      default: return; // unknown frames are ignored, as with the WebSocket
    }
  }

  onBeacon(now, f) {
    if (this.role === 'conductor') return;
    this.session = f.session;
    this.conductor = f.from;
    // Keep asking until this badge has BOTH a part and the tune. A single
    // dropped JOIN, WELCOME or TUNE_META would otherwise leave it silent for
    // the whole song with nothing on screen to explain it. The beacon already
    // arrives every 500 ms, so retrying on it costs nothing and needs no timer
    // of its own.
    const haveTune = this.tune && this.tune.parsed.id === f.id;
    if (this.track === null || (!haveTune && !this.rx)) {
      this.say(now, { t: 'JOIN', hasTune: this.tune ? this.tune.parsed.id : null }, f.from);
    }
    // A late joiner comes in on the beat: the beacon carries where the song is.
    if (f.playing && this.t0 === null && this.tune && this.track !== null) {
      this.t0 = f.t0;
    }
  }

  // Indices of the tracks that actually have notes.
  playableTracks() {
    const out = [];
    this.tune.parsed.tracks.forEach((t, i) => { if (t.notes.length) out.push(i); });
    return out.length ? out : [0];
  }

  onJoin(now, f) {
    if (this.role !== 'conductor') return;
    // A repeated JOIN is a lost WELCOME, not a new badge. Answer it again with
    // the SAME part - idempotent, so a retry cannot reshuffle the ensemble.
    if (this.joined.has(f.from)) {
      const e = this.joined.get(f.from);
      this.say(now, { t: 'WELCOME', slot: e.slot, track: e.track }, f.from);
      if (f.hasTune !== this.tune.parsed.id) this.sendTune(now, f.from);
      return;
    }
    {
      // Round robin over the tune's parts, so nobody has to choose for the
      // common case. A performer may CLAIM a different one.
      //
      // Empty tracks are skipped: a song can carry a track with no notes on
      // it, and handing one to a badge is handing it silence. The conductor
      // holds the first part, so performers start from the one after it.
      const parts = this.playableTracks();
      const slot = this.joined.size;
      const track = parts[(slot + 1) % parts.length];
      this.joined.set(f.from, { hasTune: f.hasTune, slot, track, ready: false });
      this.say(now, { t: 'WELCOME', slot, track }, f.from);
      if (f.hasTune !== this.tune.parsed.id) this.sendTune(now, f.from);
    }
  }

  onWelcome(now, f) {
    this.track = f.track;
    this.slot = f.slot;
  }

  // ---- distributing the tune ----
  //
  // Broadcast once, repair by NACK. Sending to eight badges costs one pass,
  // not eight, and only what someone actually missed is repeated.
  sendTune(now, to) {
    const bytes = this.tune.bytes;
    const fragCount = Math.ceil(bytes.length / FRAGMENT_BYTES);

    // TUNE_META is UNICAST to whoever asked, every time, even while a
    // broadcast pass is already running.
    //
    // Sending it only once with the pass looked tidy and was wrong: a badge
    // that joined a moment later, or that simply lost that one frame, ended up
    // with a part and no tune and no way to ask for one - silent for the whole
    // song. At 30% loss the simulator left three of seven badges in exactly
    // that state. META is one frame; sending it again is free.
    this.say(now, { t: 'TUNE_META', id: this.tune.parsed.id, bytes: bytes.length, fragCount }, to);

    if (this.sending) return; // one broadcast pass serves everyone missing it
    this.sending = true;
    this.outbox = [];
    for (let i = 0; i < fragCount; i++) {
      this.outbox.push({
        seq: i,
        data: bytes.subarray(i * FRAGMENT_BYTES, (i + 1) * FRAGMENT_BYTES),
      });
    }
  }

  onTuneMeta(now, f) {
    if (this.tune && this.tune.parsed.id === f.id) return; // already have it
    this.rx = { id: f.id, bytes: f.bytes, fragCount: f.fragCount, have: new Map() };
    this.lastFragmentAt = now;
  }

  onTuneData(now, f) {
    if (!this.rx || this.rx.id !== f.id) return;
    this.rx.have.set(f.seq, f.data);
    this.lastFragmentAt = now;
    if (this.rx.have.size === this.rx.fragCount) this.assemble();
  }

  onNack(now, f) {
    if (this.role !== 'conductor' || !this.outbox) return;
    // Repairs are unicast: one badge's missing fragment is not everyone's.
    for (const seq of f.missing) {
      const frag = this.outbox[seq];
      if (frag) this.say(now, { t: 'TUNE_DATA', id: this.tune.parsed.id, seq, data: frag.data }, f.from);
    }
  }

  assemble() {
    const parts = [];
    for (let i = 0; i < this.rx.fragCount; i++) parts.push(this.rx.have.get(i));
    const bytes = new Uint8Array(this.rx.bytes);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }
    try {
      // parseTune verifies the CRC, so a mis-assembled tune is refused rather
      // than played - the same rule an upload follows.
      const parsed = parseTune(bytes);
      this.tune = { bytes, parsed };
      this.received = true;
    } catch {
      this.rx = null; // start over; the conductor is still beaconing
      return;
    }
    this.rx = null;
  }

  // ---- clock ----

  syncOnce(now) {
    const c = this.millis(now);
    this.pendingSync.set(c, c);
    this.say(now, { t: 'TSYNC_REQ', c }, this.conductor);
  }

  onSyncReply(now, f) {
    if (!this.pendingSync.has(f.c)) return;
    this.pendingSync.delete(f.c);
    const c2 = this.millis(now);
    const rtt = c2 - f.c;
    this.offsets.push(f.s + rtt / 2 - c2);
    // Median of the last few, not the latest: one relayed exchange can be far
    // out, and a single bad sample would yank every upcoming note.
    this.offset = median(this.offsets.slice(-TSYNC_WINDOW));
  }

  onArm(now, f) {
    if (this.role === 'conductor') return;
    this.armed = true;
    this.armBurst = TSYNC_BURST;
    this.nextSync = now;
  }

  onPlay(now, f) {
    if (this.tune && f.id !== this.tune.parsed.id) return;
    // Idempotent: the same t0 yields the same schedule, so a repeat costs
    // nothing and a lost PLAY cannot lose a badge.
    this.t0 = f.t0;
    this.fromMs = f.fromMs || 0;
  }

  // Position, stated by the conductor. Correcting to it is a single
  // assignment - there is no cursor to move and no queue to flush.
  onTick(now, f) {
    if (this.t0 === null) return;
    this.t0 = f.meshMs - f.songMs;
  }

  // ---- the loop ----

  step(now) {
    if (now < this.stallUntil) return;

    if (this.role === 'conductor') {
      if (now >= (this.nextBeacon || 0)) {
        this.nextBeacon = now + BEACON_MS;
        this.say(now, {
          t: 'BEACON', session: 'S1', id: this.tune.parsed.id,
          tracks: this.tune.parsed.tracks.length,
          playing: this.t0 !== null, t0: this.t0, fromMs: 0,
        });
      }
      // Drain the tune broadcast at one fragment per step, so distribution
      // does not monopolise the medium the way a burst would.
      if (this.outbox && this.outbox.length) {
        const frag = this.outbox[this.sendIndex || 0];
        if (frag) {
          this.say(now, { t: 'TUNE_DATA', id: this.tune.parsed.id, seq: frag.seq, data: frag.data });
          this.sendIndex = (this.sendIndex || 0) + 1;
        }
      }
      if (this.t0 !== null && now >= (this.nextTick || 0)) {
        this.nextTick = now + TICK_MS;
        const meshMs = this.millis(now);
        this.say(now, { t: 'TICK', id: this.tune.parsed.id, meshMs, songMs: meshMs - this.t0 });
      }
      if (this.playAt != null && now < this.playAt && now >= (this.nextPlay || 0)) {
        this.nextPlay = now + PLAY_REPEAT_MS;
        this.say(now, { t: 'PLAY', id: this.tune.parsed.id, t0: this.t0, fromMs: 0 });
      }
    } else {
      // Sync: a burst while arming, a trickle while playing.
      if (this.conductor && now >= (this.nextSync || 0)) {
        if (this.armBurst > 0) {
          this.armBurst--;
          this.nextSync = now + TSYNC_BURST_MS;
          this.syncOnce(now);
          if (this.armBurst === 0) this.readyAt = now + TSYNC_BURST_MS;
        } else {
          this.nextSync = now + TSYNC_IDLE_MS;
          this.syncOnce(now);
        }
      }
      if (this.readyAt != null && now >= this.readyAt && !this.ready) {
        this.ready = true;
        const recent = this.offsets.slice(-TSYNC_WINDOW);
        const spread = recent.length ? Math.max(...recent) - Math.min(...recent) : 999;
        this.say(now, { t: 'READY', samples: recent.length, spreadMs: spread }, this.conductor);
      }
      // Missing fragments: ask once the flow has gone quiet, so a NACK is not
      // sent for something still in flight.
      if (this.rx && now - this.lastFragmentAt > NACK_AFTER_MS) {
        const missing = [];
        for (let i = 0; i < this.rx.fragCount && missing.length < 32; i++) {
          if (!this.rx.have.has(i)) missing.push(i);
        }
        if (missing.length) this.say(now, { t: 'TUNE_NACK', id: this.rx.id, missing }, this.conductor);
        this.lastFragmentAt = now;
      }
    }

    this.play(now);
  }

  // The player. Identical in every mode; only `now()` differs.
  play(now) {
    if (this.t0 === null || !this.tune || this.track === null) return;
    const notes = this.tune.parsed.tracks[this.track].notes;
    const songMs = this.meshNow(now) - this.t0 + (this.fromMs || 0);
    let i = noteAt(notes, songMs);

    // The one guard: after jumping INTO a note, a sliver of it is a click
    // rather than a note, so wait for the next onset instead.
    //
    // It must not apply at a normal onset. Written as "remaining < 20 ms" it
    // silently swallows every note shorter than 20 ms - which this simulator
    // caught on a 14 ms note in the Rickroll melody. The condition is
    // therefore "we arrived late AND there is almost nothing left", not
    // "there is almost nothing left".
    if (i !== NONE && i !== this.sounding) {
      const n = notes[i];
      const arrivedLate = songMs - n.startMs > PLAYER_STEP_MS;
      if (arrivedLate && n.startMs + n.durMs - songMs < MIN_REMAINDER_MS) i = NONE;
    }
    if (i === this.sounding) return;

    if (i !== NONE) {
      if (this.onsets.some((o) => o.index === i)) this.retriggers++;
      this.onsets.push({
        index: i, songMs, wantMs: notes[i].startMs, error: songMs - notes[i].startMs,
      });
    }
    this.sounding = i;
  }
}

// ---- the simulation ----

export function runMesh({
  badges = 4, loss = 0, skew = 200, drift = 50, seed = 1,
  stallMs = 0, stallAt = 0, tune, durationMs,
} = {}) {
  const rand = rng(seed);
  const bus = new Bus({ loss, rand });

  const conductor = new MeshBadge({ id: 'C', role: 'conductor', tune, skewMs: 0, driftPpm: 0, rand });
  bus.join(conductor);
  const performers = [];
  for (let i = 0; i < badges - 1; i++) {
    const p = new MeshBadge({
      id: `P${i + 1}`,
      // Nobody starts with the tune: this exercises distribution every run.
      tune: null,
      skewMs: (rand() * 2 - 1) * skew,
      driftPpm: (rand() * 2 - 1) * drift,
      rand,
    });
    bus.join(p);
    performers.push(p);
  }
  const all = [conductor, ...performers];
  conductor.track = conductor.playableTracks()[0];

  let now = 0;
  const step = () => {
    bus.deliver(now);
    for (const b of all) b.step(now);
    now += PLAYER_STEP_MS;
  };

  // Phase 1: discovery and distribution.
  const distributeDeadline = 30_000;
  while (now < distributeDeadline && !performers.every((p) => p.tune)) step();
  const distributedAt = now;

  // Phase 2: ARM, and wait for everyone to report a converged clock.
  conductor.say(now, { t: 'ARM', id: tune.parsed.id });
  for (const p of performers) p.receive(now, { t: 'ARM', from: 'C', id: tune.parsed.id });
  const armDeadline = now + ARM_TIMEOUT_MS;
  while (now < armDeadline && !performers.every((p) => p.ready)) step();
  const armedAt = now;
  const unsynced = performers.filter((p) => !p.ready).map((p) => p.id);

  // Phase 3: play.
  conductor.t0 = conductor.millis(now) + PLAY_LEAD_MS;
  conductor.playAt = now + PLAY_LEAD_MS;
  conductor.say(now, { t: 'PLAY', id: tune.parsed.id, t0: conductor.t0, fromMs: 0 });

  // Stall the badge with the DENSEST part. Stalling a sparse one usually means
  // sleeping through silence, which proves nothing - the interesting case is
  // the badge that had notes to miss.
  const victim = performers
    .filter((p) => p.tune && p.track !== null)
    .sort((a, b) => b.tune.parsed.tracks[b.track].notes.length - a.tune.parsed.tracks[a.track].notes.length)[0];

  const stallStart = stallAt;
  let stallWindow = null;
  const end = now + durationMs + 2000;
  while (now < end) {
    if (stallMs && victim && now >= armedAt + stallStart && victim.stallUntil < 0) {
      victim.stallUntil = now + stallMs;
      // In song time, so the report can say which notes were legitimately lost
      // to the stall rather than to a correction.
      const from = victim.meshNow(now) - victim.t0;
      stallWindow = [from, from + stallMs];
    }
    step();
  }

  return { bus, conductor, performers, all, distributedAt, armedAt, unsynced, victim, stallWindow };
}

// ---- reporting ----

export function report(sim, { stallMs }) {
  const { performers, conductor, bus, victim, stallWindow } = sim;
  const rows = [];
  for (const b of [conductor, ...performers]) {
    const errs = b.onsets.map((o) => o.error);
    const part = b.tune && b.track !== null ? b.tune.parsed.tracks[b.track] : null;
    const total = part ? part.notes.length : 0;
    rows.push({
      id: b.id,
      track: b.track,
      played: b.onsets.length,
      total,
      // How far from its mark each onset landed, in mesh time.
      mean: errs.length ? errs.reduce((a, c) => a + c, 0) / errs.length : 0,
      worst: errs.length ? Math.max(...errs.map(Math.abs)) : 0,
      offsetErr: b.offset ? Math.abs(b.offset + b.skewMs) : Math.abs(b.skewMs),
      retriggers: b.retriggers,
    });
  }

  // The number that decides whether an ensemble sounds tight: not how far one
  // badge is from the score, but how far the badges are from EACH OTHER.
  const means = rows.map((r) => r.mean);
  const spread = Math.max(...means) - Math.min(...means);

  // A future onset must never be swallowed by a correction. Anything a badge
  // did not play is checked against the stall it slept through.
  let skippedOutsideStall = 0;
  for (const b of [conductor, ...performers]) {
    if (!b.tune || b.track === null) continue;
    const notes = b.tune.parsed.tracks[b.track].notes;
    const played = new Set(b.onsets.map((o) => o.index));
    for (let i = 0; i < notes.length; i++) {
      if (played.has(i)) continue;
      // The stall is the ONLY excuse, and only for notes that started inside
      // it. Anything else missing is a note the correction swallowed, which
      // the design says cannot happen.
      const n = notes[i];
      const inStall = b === victim && stallWindow
        && n.startMs >= stallWindow[0] - 5 && n.startMs < stallWindow[1] + 5;
      if (inStall) continue;
      skippedOutsideStall++;
    }
  }

  // What the stall actually cost, which is the claim worth checking: notes lost
  // to it, and whether the badge was back in place immediately afterwards
  // rather than permanently behind.
  let stall = null;
  if (victim && stallWindow) {
    const notes = victim.tune.parsed.tracks[victim.track].notes;
    const inWindow = notes.filter((n) => n.startMs >= stallWindow[0] && n.startMs < stallWindow[1]).length;
    const after = victim.onsets.filter((o) => o.wantMs >= stallWindow[1]);
    const before = victim.onsets.filter((o) => o.wantMs < stallWindow[0]);
    const avg = (xs) => (xs.length ? xs.reduce((a, c) => a + c.error, 0) / xs.length : 0);
    stall = {
      windowMs: stallWindow.map(Math.round),
      notesInWindow: inWindow,
      lost: inWindow - notes.filter((n, i) =>
        n.startMs >= stallWindow[0] && n.startMs < stallWindow[1]
        && victim.onsets.some((o) => o.index === i)).length,
      errBefore: avg(before),
      errAfter: avg(after),
      worstAfter: after.length ? Math.max(...after.map((o) => Math.abs(o.error))) : 0,
    };
  }

  return { rows, spread, skippedOutsideStall, stall, sent: bus.sent, dropped: bus.dropped };
}

// ---- CLI ----

function parseArgs(argv) {
  const out = {
    badges: 4, loss: 0, skew: 200, drift: 50, seed: 1,
    song: 'tetris', stall: null, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k === 'json') { out.json = true; continue; }
    const v = argv[++i];
    out[k] = /^[\d.]+$/.test(v) ? Number(v) : v;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));

  // "120@45s" - a 120 ms stall, 45 seconds in.
  let stallMs = 0, stallAt = 0;
  if (args.stall) {
    const m = String(args.stall).match(/^(\d+)(?:@(\d+)s?)?$/);
    if (m) { stallMs = Number(m[1]); stallAt = Number(m[2] || 0) * 1000; }
  }

  const doc = migrate(JSON.parse(
    await readFile(new URL(`../demos/${args.song}.chipseq.json`, import.meta.url), 'utf8')
  ));
  const built = buildTune(doc, { name: doc.name });
  const tune = { bytes: built.bytes, parsed: parseTune(built.bytes) };

  const sim = runMesh({
    badges: args.badges, loss: args.loss, skew: args.skew, drift: args.drift,
    seed: args.seed, stallMs, stallAt, tune, durationMs: built.totalMs,
  });
  const r = report(sim, { stallMs });

  if (args.json) {
    console.log(JSON.stringify({ ...r, args }, null, 2));
  } else {
    const frags = Math.ceil(built.bytes.length / FRAGMENT_BYTES);
    console.log(`"${doc.name}" - ${built.bytes.length} B, ${built.tracks.length} tracks, ${frags} fragments`);
    console.log(`${args.badges} badges, ${(args.loss * 100).toFixed(0)}% loss, ±${args.skew} ms skew, ±${args.drift} ppm drift`
      + (stallMs ? `, ${stallMs} ms stall at ${stallAt / 1000}s` : ''));
    console.log(`tune distributed to every badge in ${(sim.distributedAt / 1000).toFixed(2)} s`);
    console.log(`clocks converged (ARM->READY) in ${((sim.armedAt - sim.distributedAt) / 1000).toFixed(2)} s`
      + (sim.unsynced.length ? `  UNSYNCED: ${sim.unsynced.join(',')}` : ''));
    console.log('');
    console.log('badge  track  notes      mean err   worst   clock err  retrig');
    for (const row of r.rows) {
      console.log(
        `${row.id.padEnd(6)} ${String(row.track).padEnd(6)} ${String(row.played + '/' + row.total).padEnd(10)} `
        + `${row.mean.toFixed(2).padStart(8)} ms ${row.worst.toFixed(1).padStart(7)} `
        + `${row.offsetErr.toFixed(2).padStart(10)} ${String(row.retriggers).padStart(7)}`
      );
    }
    if (r.stall) {
      const s = r.stall;
      console.log('');
      console.log(`stall on ${sim.victim.id}: song ${s.windowMs[0]}..${s.windowMs[1]} ms, `
        + `${s.notesInWindow} note(s) inside it, ${s.lost} lost`);
      console.log(`  onset error before ${s.errBefore.toFixed(2)} ms, `
        + `after ${s.errAfter.toFixed(2)} ms (worst ${s.worstAfter.toFixed(1)}) `
        + `- recovery is immediate, not gradual`);
    }
    console.log('');
    console.log(`ensemble spread ${r.spread.toFixed(2)} ms   `
      + `future onsets swallowed ${r.skippedOutsideStall}   `
      + `frames ${r.sent} sent, ${r.dropped} dropped`);
  }
  process.exit(r.skippedOutsideStall === 0 && r.spread < 15 ? 0 : 1);
}
