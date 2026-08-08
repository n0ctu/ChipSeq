// A badge, in software. Reference implementation of docs/badge-protocol.md.
//
// Two jobs. It is the executable version of the spec - when the document is
// ambiguous, this is what the server was tested against - and it is how every
// later phase gets tested without waiting for hardware.
//
//   node tools/fake-badge.mjs --url ws://localhost:8080/ws --code URDLAB
//   node tools/fake-badge.mjs --url ws://localhost:8080/ws --count 4
//
// Dependency-free: Node 22 has a WebSocket client built in.

// ---- timing maths (pure, so tests do not need a socket) ----

// One ping/pong exchange -> how far the badge's clock is behind the server's.
// c1: badge counter when the ping went out. c2: counter when the pong arrived.
// s: the server's clock, sampled somewhere in between.
//
// The assumption is that the two legs took equal time, so the server's clock
// at c2 was s + rtt/2. It is wrong on any single exchange - which is why
// medianOffset exists rather than this being used directly.
export function offsetFrom(c1, c2, s) {
  const rtt = c2 - c1;
  return s + rtt / 2 - c2;
}

// The median of the last N, NOT the latest. A relayed exchange can be tens of
// milliseconds out; one bad sample would otherwise yank every scheduled note.
export function medianOffset(samples, window = 5) {
  const recent = samples.slice(-window).sort((a, b) => a - b);
  if (!recent.length) return 0;
  const mid = recent.length >> 1;
  return recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
}

// A note is dropped rather than played late: in an ensemble, late is worse
// than absent. Anything already more than this far past is discarded.
export const LATE_DROP_MS = 50;

export function isPlayable(startServerMs, nowServerMs) {
  return startServerMs - nowServerMs > -LATE_DROP_MS;
}

// ---- the badge ----

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export class FakeBadge {
  // clockSkew fakes a device whose millis() does not agree with the server,
  // which is the whole reason §4 of the spec exists. Without it the sync code
  // would look correct while doing nothing.
  constructor({ url, id, fw = 'fake-1.0.0', code = null, clockSkew = 0, onEvent = null } = {}) {
    this.url = url;
    this.id = id || 'fake-' + Math.random().toString(36).slice(2, 8);
    this.fw = fw;
    this.code = code;
    this.clockSkew = clockSkew;
    this.onEvent = onEvent || (() => {});

    this.ws = null;
    this.name = null;
    this.paired = false;
    this.showingCode = null; // the code this badge would be displaying (§3.1)
    this.offsets = [];
    this.offset = 0;
    this.pending = new Map(); // t0 -> timers, so a re-sent chunk can replace one
    this.played = []; // { pitch, ms, wantServerMs, gotServerMs, error }
    this.attempt = 0;
    this.closed = false;
    this.pingTimer = null;
    this.pingSentAt = 0;
  }

  // The badge's own clock, deliberately not the server's.
  clock() {
    return performance.now() + this.clockSkew;
  }

  serverNow() {
    return this.clock() + this.offset;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const failFast = (err) => reject(err instanceof Error ? err : new Error('connect failed'));
      ws.onerror = failFast;
      ws.onopen = () => {
        ws.onerror = (e) => this.onEvent({ t: 'socket_error', e });
        this.attempt = 0;
        this.send({ t: 'hello', v: 1, id: this.id, fw: this.fw });
        resolve(this);
      };
      ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        this.onEvent({ t: 'closed' });
        if (!this.closed) this.retry();
      };
    });
  }

  retry() {
    const wait = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)];
    this.onEvent({ t: 'retry', in: wait });
    setTimeout(() => this.connect().catch(() => this.retry()), wait);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  handle(msg) {
    switch (msg.t) {
      case 'welcome':
        this.paired = !!msg.known;
        if (msg.name) this.name = msg.name;
        // §3.1: a badge with a screen DISPLAYS this. Here there is no screen,
        // so it is simply held - which is what a test or a firmware author
        // needs to see anyway.
        this.showingCode = msg.code || null;
        this.onEvent({ t: 'welcome', known: !!msg.known, name: msg.name, code: this.showingCode });
        // §3.2: if this badge was given a code to type, it types it.
        if (!this.paired && this.code) this.send({ t: 'pair', code: this.code });
        this.startPinging();
        return;
      case 'paired':
        this.paired = true;
        this.name = msg.name || this.name;
        this.showingCode = null; // stop showing it once adopted
        this.onEvent({ t: 'paired', name: this.name });
        return;
      case 'pair_failed':
        this.onEvent({ t: 'pair_failed', reason: msg.reason });
        return;
      case 'pong': {
        const now = this.clock();
        this.offsets.push(offsetFrom(msg.c, now, msg.s));
        this.offset = medianOffset(this.offsets);
        this.onEvent({ t: 'sync', offset: this.offset, samples: this.offsets.length });
        return;
      }
      case 'note':
        this.play(msg.p, msg.ms, this.serverNow());
        return;
      case 'sched':
        this.schedule(msg);
        return;
      case 'stop':
        this.stopAll();
        this.onEvent({ t: 'stop' });
        return;
      case 'name':
        this.name = msg.name;
        this.onEvent({ t: 'name', name: msg.name });
        return;
      case 'error':
        this.onEvent({ t: 'error', code: msg.code, msg: msg.msg });
        return;
      default:
        // Unknown types are ignored, per the spec: a badge that disconnects on
        // one breaks the moment the server learns a new message.
        this.onEvent({ t: 'ignored', type: msg.t });
    }
  }

  startPinging() {
    clearInterval(this.pingTimer);
    const ping = () => {
      this.pingSentAt = this.clock();
      this.send({ t: 'ping', c: Math.round(this.pingSentAt) });
    };
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  // A chunk with a t0 we already hold REPLACES it, so re-sending is safe.
  schedule(msg) {
    const key = msg.t0;
    if (this.pending.has(key)) {
      for (const timer of this.pending.get(key)) clearTimeout(timer);
    }
    const timers = [];
    for (const [offsetMs, pitch, durMs] of msg.n || []) {
      const wantServerMs = msg.t0 + offsetMs;
      const delay = wantServerMs - this.serverNow();
      if (!isPlayable(wantServerMs, this.serverNow())) {
        this.onEvent({ t: 'dropped', pitch, late: -delay });
        continue;
      }
      timers.push(setTimeout(() => this.play(pitch, durMs, wantServerMs), Math.max(0, delay)));
    }
    this.pending.set(key, timers);
  }

  // "Playing" is recording when it happened against when it should have. That
  // difference IS the measurement the whole exercise exists to make.
  play(pitch, ms, wantServerMs) {
    const gotServerMs = this.serverNow();
    this.played.push({
      pitch, ms, wantServerMs, gotServerMs, error: gotServerMs - wantServerMs,
    });
    this.onEvent({ t: 'play', pitch, ms, error: gotServerMs - wantServerMs });
  }

  stopAll() {
    for (const timers of this.pending.values()) for (const t of timers) clearTimeout(t);
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.stopAll();
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  }
}

// ---- CLI ----

function parseArgs(argv) {
  const out = { url: 'ws://localhost:8080/ws', count: 1, code: null, id: null };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = argv[i].startsWith('--') ? [argv[i].slice(2), argv[i + 1]] : [null, null];
    if (k && v !== undefined) { out[k] = /^\d+$/.test(v) ? Number(v) : v; i++; }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const badges = [];
  for (let i = 0; i < args.count; i++) {
    const id = args.count === 1 && args.id ? args.id : `${args.id || 'fake'}-${i + 1}`;
    const badge = new FakeBadge({
      url: args.url,
      id,
      code: args.code,
      // each fake badge gets its own wrong clock, so sync has work to do
      clockSkew: (i + 1) * 137,
      onEvent: (e) => console.log(`[${id}]`, JSON.stringify(e)),
    });
    badges.push(badge);
    await badge.connect().catch((err) => {
      console.error(`[${id}] ${err.message} - is the server running at ${args.url}?`);
      process.exit(1);
    });
  }
  console.log(`${badges.length} badge(s) connected to ${args.url}. Ctrl+C to stop.`);
  process.on('SIGINT', () => {
    for (const b of badges) {
      const errs = b.played.map((p) => p.error);
      if (errs.length) {
        const mean = errs.reduce((a, c) => a + c, 0) / errs.length;
        console.log(`[${b.id}] ${errs.length} notes, mean onset error ${mean.toFixed(1)} ms`);
      }
      b.close();
    }
    process.exit(0);
  });
}
