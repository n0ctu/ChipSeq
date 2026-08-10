// Server tests, driven by the fake badge - so what is exercised is the same
// client the firmware author is given as a reference, not a mock that agrees
// with the server by construction.
//
//   node server/test.mjs

import { createServer } from './index.mjs';
import { Hub, makeCode, isValidCodeShape, CODE_TTL_MS, PAIR_MAX_ATTEMPTS } from './rooms.mjs';
import { FakeBadge } from '../tools/fake-badge.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => (cond ? pass++ : (fail++, console.log('FAIL:', msg)));
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}\n    got ${JSON.stringify(a)}\n   want ${JSON.stringify(b)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a condition rather than guessing a delay: a fixed sleep is either
// slow or flaky, and usually becomes both.
async function until(fn, what, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(10);
  }
  fail++;
  console.log('FAIL: timed out waiting for', what);
  return false;
}

// ---- adoptions survive a restart ----
//
// The point of persisting anything: a deploy used to cost every paired badge a
// re-pair, which is why the deploy script had an idle guard that then blocked
// deploys outright.
//
// The risk in the implementation is a mutation whose write was forgotten, so
// these do not check individual save() calls. After every operation they reload
// a hub from the same file and compare it against the live one, which catches a
// missed write wherever it is.
{
  const { openStore } = await import('./store.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'chipseq-store-'));
  const file = join(dir, 'relay.db');

  // What a restart sees: a new hub over the same file. `conn` is dropped on the
  // way out, so compare everything else.
  // Deliberately does NOT save first. The first version of this did, which
  // made every one of these assertions pass with the save() calls removed from
  // rooms.mjs entirely - it was testing the store, not the write points. What
  // is on disk has to have been put there by the operation itself.
  const persisted = (hub) => {
    const fresh = new Hub({ store: openStore(file) });
    const strip = (m) => [...m.entries()].map(([k, v]) => {
      const { conn, ...rest } = v; void conn; return [k, rest];
    }).sort();
    return {
      sessions: strip(fresh.sessions),
      badges: strip(fresh.badges),
      live: { sessions: strip(hub.sessions), badges: strip(hub.badges) },
    };
  };
  const matches = (hub, what) => {
    const p = persisted(hub);
    eq(p.badges, p.live.badges, `badges survive a restart after ${what}`);
    eq(p.sessions, p.live.sessions, `sessions survive a restart after ${what}`);
  };

  try {
    const hub = new Hub({ store: openStore(file) });
    const session = hub.createSession();
    matches(hub, 'createSession');

    const code = hub.issueCode(session).code;
    hub.redeem(code, 'badge:a', '1.2.3.4', { fw: 'fw1', name: 'Astronaut' });
    matches(hub, 'redeem');
    ok(hub.badges.get('badge:a').sessionId === session, 'the adoption names its session');

    hub.rename(session, 'badge:a', 'Cosmonaut');
    matches(hub, 'rename');
    hub.map(session, 'badge:a', 'track-7');
    matches(hub, 'map');
    hub.setLibrary('badge:a', { tunes: [{ id: 'cafe', name: 'Tetris' }], freeBytes: 9, maxTunes: 4 });
    matches(hub, 'setLibrary');
    hub.attach('badge:a', { open: true }, { fw: 'fw2', caps: ['note', 'sched'] });
    matches(hub, 'attach');

    // The thing that actually matters, stated directly rather than via a diff.
    {
      const restarted = new Hub({ store: openStore(file) });
      const b = restarted.badges.get('badge:a');
      ok(!!b, 'the badge is still adopted after a restart');
      eq(b.name, 'Cosmonaut', 'and keeps the name someone typed');
      eq(b.trackId, 'track-7', 'and its track mapping');
      eq(b.sessionId, session, 'and its owning session');
      eq(b.conn, null, 'but is offline until it reconnects');
      eq(restarted.stats().online, 0, 'so online counts it as absent');
    }

    // Pairing codes are deliberately NOT persisted: they expire in 120s and an
    // offer is bound to a socket that a restart has already closed.
    {
      hub.issueCode(session);
      hub.offerCode('badge:b');
      const restarted = new Hub({ store: openStore(file) });
      eq(restarted.stats().codes, 0, 'pairing codes do not survive a restart');
      eq(restarted.stats().offers, 0, 'nor do offers, whose sockets are gone');
    }

    hub.forget(session, 'badge:a');
    matches(hub, 'forget');
    ok(!new Hub({ store: openStore(file) }).badges.has('badge:a'), 'forgetting is persisted too');

    // A release is the badge disowning itself, and must stick across a restart
    // just as firmly - otherwise it comes back adopted and nobody can free it.
    {
      const c2 = hub.issueCode(session).code;
      hub.redeem(c2, 'badge:c', '1.2.3.4', {});
      hub.release('badge:c');
      matches(hub, 'release');
      ok(!new Hub({ store: openStore(file) }).badges.has('badge:c'), 'a released badge stays released');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- pure hub logic, with time and randomness under our control ----
{
  let clock = 1_000_000;
  const hub = new Hub({ now: () => clock });

  const s1 = hub.createSession();
  const s2 = hub.createSession();
  ok(s1 !== s2, 'sessions are distinct');
  eq(hub.resumeSession(s1), s1, 'a known session resumes as itself');
  ok(hub.resumeSession('nonsense') !== 'nonsense', 'an unknown one becomes a fresh session, not an error');

  const { code } = hub.issueCode(s1);
  ok(isValidCodeShape(code), `issued code is enterable on the badge: ${code}`);

  // Wrong code, then the right one.
  eq(hub.redeem('LLLLLL', 'badge-a', '1.1.1.1', { fw: 'fw' }).error, 'unknown', 'a wrong code is rejected');
  const r = hub.redeem(code, 'badge-a', '1.1.1.1', { fw: 'fw1' });
  ok(r.ok && r.sessionId === s1, 'the right code adopts the badge into that session');
  eq(hub.badgesOf(s2), [], 'and not into anyone else\'s');
  eq(hub.badgesOf(s1).length, 1, 'the owning session sees it');

  // Single use.
  eq(hub.redeem(code, 'badge-b', '1.1.1.2', { fw: 'fw' }).error, 'unknown', 'a code cannot be used twice');

  // Expiry, by moving the clock rather than sleeping two minutes.
  const second = hub.issueCode(s1);
  clock += CODE_TTL_MS + 1;
  eq(hub.redeem(second.code, 'badge-c', '1.1.1.3', { fw: 'fw' }).error, 'expired', 'a stale code is expired, not accepted');

  // Rate limiting is per address.
  const third = hub.issueCode(s1);
  for (let i = 0; i < PAIR_MAX_ATTEMPTS; i++) hub.redeem('UUUUUU', 'badge-d', '9.9.9.9', { fw: 'fw' });
  eq(hub.redeem(third.code, 'badge-d', '9.9.9.9', { fw: 'fw' }).error, 'rate', 'a guessing address is cut off');
  ok(hub.redeem(third.code, 'badge-e', '8.8.8.8', { fw: 'fw' }).ok, 'while an innocent address is unaffected');

  // Ownership: one session cannot touch another's badge.
  ok(hub.rename(s1, 'badge-a', 'Bass') === true, 'the owner can rename');
  ok(hub.rename(s2, 'badge-a', 'Stolen') === false, 'a stranger cannot');
  ok(hub.map(s2, 'badge-a', 'track-1') === false, 'nor map it');
  ok(hub.owned(s2, 'badge-a') === null, 'nor address it at all');

  // Two badges on one track is a supported arrangement, not an accident.
  hub.redeem(hub.issueCode(s1).code, 'badge-f', '1.1.1.9', { fw: 'fw' });
  hub.map(s1, 'badge-a', 'track-1');
  hub.map(s1, 'badge-f', 'track-1');
  const a = hub.badges.get('badge-a'); const f = hub.badges.get('badge-f');
  a.conn = { open: true }; f.conn = { open: true };
  eq(hub.forTrack(s1, 'track-1').length, 2, 'both badges on one track are addressed');

  // Codes with the wrong shape never reach the map.
  ok(!isValidCodeShape('URDLA'), 'five symbols is not a code');
  ok(!isValidCodeShape('URDLAX'), 'X is not a button');
  ok(!isValidCodeShape(''), 'nor is nothing');
  ok(isValidCodeShape(makeCode()), 'a generated code is always valid');
}

// ---- the display flow: badge shows a code, controller adopts it ----
{
  let clock = 2_000_000;
  const hub = new Hub({ now: () => clock });
  const s1 = hub.createSession();
  const s2 = hub.createSession();

  const code = hub.offerCode('badge-x');
  ok(/^[A-HJ-NP-Z2-9]{6}$/.test(code), `a display code avoids confusable characters: ${code}`);

  // Bound to the BADGE, not to a session - which is the security difference
  // from the button flow, where the code is a bearer token.
  const bad = hub.adopt('ZZZZZZ', s1, '1.2.3.4');
  eq(bad.error, 'unknown', 'a wrong code adopts nothing');
  const res = hub.adopt(code, s1, '1.2.3.4');
  ok(res.ok && res.badgeId === 'badge-x', 'the right code adopts the badge that showed it');
  eq(hub.badgesOf(s1).length, 1, 'into the adopting session');
  eq(hub.badgesOf(s2).length, 0, 'and no other');

  // Single use.
  eq(hub.adopt(code, s2, '1.2.3.4').error, 'unknown', 'a display code cannot be reused');

  // Case and whitespace: it is typed by a human off a screen.
  const code2 = hub.offerCode('badge-y');
  ok(hub.adopt(`  ${code2.toLowerCase()} `, s1, '1.2.3.4').ok, 'typed in lower case with spaces still works');

  // Expiry.
  const code3 = hub.offerCode('badge-z');
  clock += CODE_TTL_MS + 1;
  eq(hub.adopt(code3, s1, '1.2.3.4').error, 'expired', 'a stale display code is refused');

  // Reconnecting keeps the SAME code, because the badge is still showing it.
  // A badge with a flaky link would otherwise display a code the server had
  // already replaced - which is exactly what happened with real hardware.
  const first = hub.offerCode('badge-w');
  const second = hub.offerCode('badge-w');
  eq(second, first, 'reconnecting reuses the code the badge is displaying');
  ok(hub.adopt(first, s1, '5.5.5.5').ok, 'so what is on screen still works');

  // Once it expires, a reconnect does mint a fresh one.
  const old1 = hub.offerCode('badge-u');
  clock += CODE_TTL_MS + 1;
  const new1 = hub.offerCode('badge-u');
  ok(new1 !== old1, 'an expired offer is replaced');
  // "unknown" rather than "expired": minting the replacement removed the old
  // entry, so there is nothing left to report an expiry date for. The
  // distinction only survives while the entry is still in the map, which is
  // the case that matters - a code sitting past its TTL, untouched.
  eq(hub.adopt(old1, s1, '5.5.5.5').error, 'unknown', 'and the stale one no longer works');
  const untouched = hub.offerCode('badge-t');
  clock += CODE_TTL_MS + 1;
  eq(hub.adopt(untouched, s1, '5.5.5.5').error, 'expired', 'one that simply timed out says so');
}

// ---- end to end, over a real socket, with the reference badge ----
{
  const { httpServer, hub } = createServer({});
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}/ws`;

  // A controller is just a socket speaking the other role.
  const controller = new (class {
    constructor() { this.messages = []; this.ws = null; }
    connect(session) {
      return new Promise((resolve) => {
        this.ws = new WebSocket(url);
        this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'hello', role: 'controller', session }));
        this.ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          this.messages.push(m);
          if (m.t === 'welcome') { this.session = m.session; resolve(m); }
        };
      });
    }
    send(msg) { this.ws.send(JSON.stringify(msg)); }
    last(type) { return [...this.messages].reverse().find((m) => m.t === type); }
  })();

  const welcome = await controller.connect();
  ok(welcome.session && typeof welcome.s === 'number', 'a controller gets a session and the server clock');
  eq(welcome.badges, [], 'and no badges yet');

  // An unpaired badge is told it must pair.
  const badge = new FakeBadge({ url, id: 'aa:bb:cc:dd:ee:ff', fw: 'test-1' });
  const seen = [];
  badge.onEvent = (e) => seen.push(e);
  await badge.connect();
  await until(() => seen.some((e) => e.t === 'welcome'), 'badge welcome');
  eq(seen.find((e) => e.t === 'welcome').known, false, 'an unknown badge is told to pair');

  // Pair it with a code the controller asked for.
  controller.send({ t: 'code' });
  await until(() => controller.last('code'), 'a pairing code');
  const code = controller.last('code').code;
  ok(isValidCodeShape(code), `the code is enterable: ${code}`);
  badge.send({ t: 'pair', code });
  await until(() => seen.some((e) => e.t === 'paired'), 'pairing to succeed');
  await until(() => (controller.last('badges') || { badges: [] }).badges.length === 1, 'the controller to be told');
  eq(controller.last('badges').badges[0].online, true, 'the badge shows as online');

  // Clock sync: the badge pings on connect, so an offset should already exist.
  await until(() => seen.some((e) => e.t === 'sync'), 'a clock sync exchange');
  ok(Number.isFinite(badge.offset), 'the badge has an offset to the server clock');

  // Live note reaches the badge.
  const badgeIdOnServer = controller.last('badges').badges[0].id;
  controller.send({ t: 'note', id: badgeIdOnServer, p: 69, ms: 100 });
  await until(() => badge.played.length === 1, 'a live note to arrive');
  eq(badge.played[0].pitch, 69, 'the right pitch arrived');

  // Scheduled chunk plays at the requested time, not on arrival.
  const t0 = Date.now() + 300;
  controller.send({ t: 'sched', id: badgeIdOnServer, t0, n: [[0, 72, 100]] });
  await until(() => badge.played.length === 2, 'a scheduled note to play');
  const sched = badge.played[1];
  ok(Math.abs(sched.error) < 60, `a scheduled note lands near its time (off by ${sched.error.toFixed(1)} ms)`);

  // The display flow, end to end: a fresh badge shows a code, the controller
  // types it, and the badge is adopted on the same connection.
  {
    const shown = new FakeBadge({ url, id: 'display:flow:01', fw: 'test-2' });
    const ev = [];
    shown.onEvent = (e) => ev.push(e);
    await shown.connect();
    await until(() => ev.some((e) => e.t === 'welcome'), 'welcome for the display badge');
    const w = ev.find((e) => e.t === 'welcome');
    ok(w.code && /^[A-HJ-NP-Z2-9]{6}$/.test(w.code), `welcome carries a code to display: ${w.code}`);

    controller.send({ t: 'adopt', code: w.code });
    await until(() => ev.some((e) => e.t === 'paired'), 'the badge to be told it is adopted');
    await until(
      () => (controller.last('badges') || { badges: [] }).badges.some((b) => b.id === 'display:flow:01'),
      'the controller roster to include it'
    );
    ok(true, 'a badge adopted by displayed code needs no button entry');
    shown.close();
  }

  // Renaming reaches the badge.
  controller.send({ t: 'rename', id: badgeIdOnServer, name: 'Bass badge' });
  await until(() => badge.name === 'Bass badge', 'the rename to reach the badge');

  // Reconnect: adoption survives, so a badge that drops resumes by itself.
  badge.ws.close();
  await until(() => !hub.badges.get(badgeIdOnServer).conn?.open, 'the server to notice the drop');
  const again = new FakeBadge({ url, id: 'aa:bb:cc:dd:ee:ff', fw: 'test-1' });
  const seen2 = [];
  again.onEvent = (e) => seen2.push(e);
  await again.connect();
  await until(() => seen2.some((e) => e.t === 'welcome'), 'second welcome');
  const w2 = seen2.find((e) => e.t === 'welcome');
  eq(w2.known, true, 'a returning badge is recognised and skips pairing');
  eq(w2.name, 'Bass badge', 'and keeps the name it was given');

  // A second controller with a DIFFERENT session must not see these badges.
  const stranger = new (controller.constructor)();
  await stranger.connect();
  eq(stranger.last('welcome').badges, [], 'another session sees none of them');
  stranger.send({ t: 'note', id: badgeIdOnServer, p: 60, ms: 50 });
  await sleep(120);
  eq(again.played.length, 0, 'and cannot play notes on them');

  // The same session resuming DOES see them - that is how a browser reload
  // keeps its badges.
  const returning = new (controller.constructor)();
  await returning.connect(controller.session);
  // Two by now: the reconnected badge and the one adopted by displayed code.
  const restored = returning.last('welcome').badges.map((b) => b.id);
  ok(restored.includes('aa:bb:cc:dd:ee:ff') && restored.includes('display:flow:01'),
    `resuming a session restores its badges (got ${JSON.stringify(restored)})`);

  badge.close(); again.close(); stranger.ws.close(); returning.ws.close(); controller.ws.close();
  await sleep(50);
  httpServer.close();
}

// ---- v2: uploading a tune, and the badge answering back ----
//
// The reverse direction is new in v2: until now a badge never authored a frame
// the sequencer read. An upload cannot work without it, so it gets the same
// ownership scrutiny the play frames already have.
{
  const { httpServer } = createServer({});
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}/ws`;

  const { buildTune } = await import('../js/core/badge-tune.js');
  const { migrate } = await import('../js/core/doc.js');
  const { readFile } = await import('node:fs/promises');
  const doc = migrate(JSON.parse(await readFile(new URL('../demos/poly.chipseq.json', import.meta.url), 'utf8')));
  const tune = buildTune(doc, { name: 'uploaded' });

  const Controller = class {
    constructor() { this.messages = []; }
    connect(session) {
      return new Promise((resolve) => {
        this.ws = new WebSocket(url);
        this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'hello', role: 'controller', session }));
        this.ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          this.messages.push(m);
          if (m.t === 'welcome') { this.session = m.session; resolve(m); }
        };
      });
    }
    send(msg) { this.ws.send(JSON.stringify(msg)); }
    last(type) { return [...this.messages].reverse().find((m) => m.t === type); }
    all(type) { return this.messages.filter((m) => m.t === type); }
  };

  const controller = new Controller();
  await controller.connect();

  const badge = new FakeBadge({ url, id: 'up:01', fw: 'test-v2' });
  const events = [];
  badge.onEvent = (e) => events.push(e);
  await badge.connect();
  await until(() => events.some((e) => e.t === 'welcome'), 'badge welcome');
  controller.send({ t: 'adopt', code: events.find((e) => e.t === 'welcome').code });
  await until(() => (controller.last('badges') || { badges: [] }).badges.length === 1, 'adoption');

  const id = controller.last('badges').badges[0].id;
  eq(controller.last('badges').badges[0].caps, ['note', 'sched', 'store'],
    'the badge advertises what it can do, and the sequencer is told');

  // Chunk it the way js/net/badge-upload.js does.
  const CHUNK = 1024;
  const chunks = [];
  for (let i = 0; i < tune.bytes.length; i += CHUNK) {
    chunks.push(Buffer.from(tune.bytes.subarray(i, i + CHUNK)).toString('base64'));
  }

  const upload = (badgeId, data = chunks, tuneBytes = tune.bytes.length, tuneId = tune.id) => {
    controller.send({ t: 'put', badge: badgeId, id: tuneId, name: 'uploaded', bytes: tuneBytes, chunks: data.length, tracks: doc.tracks.length });
    data.forEach((d, seq) => controller.send({ t: 'put_data', badge: badgeId, id: tuneId, seq, d }));
    controller.send({ t: 'put_end', badge: badgeId, id: tuneId });
  };

  upload(id);
  await until(() => controller.last('put_done'), 'the badge to finish the upload');
  const done = controller.last('put_done');
  ok(done.ok === true, `the upload succeeds (${JSON.stringify(done)})`);
  eq(done.crc, tune.id, 'and the badge computed the same CRC the writer did');
  eq(done.badge, id, 'the reply is stamped with which badge sent it');
  eq(controller.all('put_ack').length, chunks.length, 'every chunk was acknowledged');
  ok(badge.tunes.has(tune.id), 'the badge is holding it');

  // The library reaches the controller, and the roster carries it too.
  await until(() => controller.last('lib'), 'a library report');
  eq(controller.last('lib').tunes[0].id, tune.id, 'the library lists the tune');
  await until(() => (controller.last('badges').badges[0].lib || {}).tunes, 'the roster to carry the library');
  eq(controller.last('badges').badges[0].lib.tunes.length, 1, 'and the roster shows it without a round trip');

  // A damaged upload is refused whole rather than stored half-right.
  {
    const broken = chunks.slice();
    const raw = Buffer.from(broken[1], 'base64');
    raw[10] ^= 0xff;
    broken[1] = raw.toString('base64');
    upload(id, broken);
    await until(() => controller.all('put_done').length === 2, 'the second upload to finish');
    const second = controller.all('put_done')[1];
    ok(second.ok === false && second.reason === 'crc', `a corrupted upload is rejected (${JSON.stringify(second)})`);
    eq(badge.tunes.size, 1, 'and nothing half-written is kept');
  }

  // A resent chunk is idempotent - it happens for real over a relay.
  {
    const before = badge.tunes.size;
    controller.send({ t: 'put', badge: id, id: tune.id, name: 'uploaded', bytes: tune.bytes.length, chunks: chunks.length });
    chunks.forEach((d, seq) => controller.send({ t: 'put_data', badge: id, id: tune.id, seq, d }));
    controller.send({ t: 'put_data', badge: id, id: tune.id, seq: 0, d: chunks[0] }); // again
    controller.send({ t: 'put_end', badge: id, id: tune.id });
    await until(() => controller.all('put_done').length === 3, 'the third upload');
    ok(controller.all('put_done')[2].ok === true, 'a repeated chunk does not break the transfer');
    eq(badge.tunes.size, before, 'and re-uploading the same tune replaces rather than duplicates');
  }

  // Out of space is answered immediately, not after the bytes have crossed.
  {
    const tiny = new FakeBadge({ url, id: 'up:tiny', fw: 'test-v2', flashBytes: 100 });
    const tinyEvents = [];
    tiny.onEvent = (e) => tinyEvents.push(e);
    await tiny.connect();
    await until(() => tinyEvents.some((e) => e.t === 'welcome'), 'tiny badge welcome');
    controller.send({ t: 'adopt', code: tinyEvents.find((e) => e.t === 'welcome').code });
    await until(() => (controller.last('badges') || { badges: [] }).badges.length === 2, 'tiny adoption');
    const tinyId = controller.last('badges').badges.find((b) => b.id === 'up:tiny').id;

    const n = controller.all('put_done').length;
    const acksBefore = controller.all('put_ack').length;
    controller.send({ t: 'put', badge: tinyId, id: tune.id, name: 'too big', bytes: tune.bytes.length, chunks: chunks.length });
    await until(() => controller.all('put_done').length > n, 'a refusal');
    const refusal = controller.all('put_done')[n];
    eq(refusal.reason, 'space', 'a tune that does not fit is refused up front');
    eq(controller.all('put_ack').length, acksBefore,
      'and the refusal came before any chunk was sent, not after');
    tiny.close();
  }

  // Ownership: the reverse path must not leak, and a stranger must not upload.
  {
    const stranger = new Controller();
    await stranger.connect();
    eq(stranger.messages.filter((m) => m.t === 'lib').length, 0, 'another session never saw the library');
    const before = badge.tunes.size;
    stranger.send({ t: 'put', badge: id, id: 'ffffffff', name: 'hostile', bytes: 8, chunks: 1 });
    stranger.send({ t: 'put_data', badge: id, id: 'ffffffff', seq: 0, d: 'AAAAAAAAAAA=' });
    stranger.send({ t: 'put_end', badge: id, id: 'ffffffff' });
    await sleep(150);
    eq(badge.tunes.size, before, 'a stranger cannot upload to a badge it does not own');
    eq((stranger.last('put_done') || {}).reason, 'offline',
      'and is told the badge is not addressable');
    eq(stranger.all('put_ack').length, 0, 'and never sees an acknowledgement from it');
    stranger.ws.close();
  }

  // Deleting.
  controller.send({ t: 'drop', badge: id, id: tune.id });
  await until(() => badge.tunes.size === 0, 'the tune to be deleted');
  await until(() => (controller.last('lib').tunes || []).length === 0, 'an empty library report');
  ok(true, 'dropping a tune clears it and reports the new library');

  // A v1 badge is refused outright - v2 is a hard cut.
  {
    const legacy = await new Promise((resolve) => {
      const ws = new WebSocket(url);
      const got = [];
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 1, id: 'old:01', fw: 'v1' }));
      ws.onmessage = (e) => got.push(JSON.parse(e.data));
      ws.onclose = () => resolve(got);
    });
    eq(legacy[0], { t: 'error', code: 'version', need: 2 }, 'a v1 badge is told plainly and closed');
  }

  // An oversized frame is refused without dropping the connection.
  {
    const n = controller.messages.length;
    controller.send({ t: 'put_data', badge: id, id: tune.id, seq: 0, d: 'A'.repeat(9000) });
    await until(() => controller.last('error'), 'an oversize refusal');
    eq(controller.last('error').code, 'big', 'an oversized frame is refused');
    controller.send({ t: 'lib?', badge: id });
    await until(() => controller.messages.length > n + 1, 'the connection to still work');
    ok(true, 'and the connection survives it');
  }

  badge.close(); controller.ws.close();
  await sleep(50);
  httpServer.close();
}

// ---- releasing an adoption, from the badge ----
//
// Adoption used to be a one-way door: only the owning controller could end it,
// so a controller whose session was gone took the badge with it - reconnecting
// as `known` with no pairing code, adoptable by nobody, recoverable only by
// restarting the server. This is the way out, and the orphan case is the test
// that matters.
{
  const { httpServer, hub } = createServer({});
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}/ws`;

  const Controller = class {
    constructor() { this.messages = []; }
    connect(session) {
      return new Promise((resolve) => {
        this.ws = new WebSocket(url);
        this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'hello', role: 'controller', session }));
        this.ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          this.messages.push(m);
          if (m.t === 'welcome') { this.session = m.session; resolve(m); }
        };
      });
    }
    send(msg) { this.ws.send(JSON.stringify(msg)); }
    last(type) { return [...this.messages].reverse().find((m) => m.t === type); }
  };

  const adopt = async (ctl, badge, events) => {
    await until(() => events.some((e) => e.t === 'welcome' && e.code), 'a code to adopt with');
    const code = [...events].reverse().find((e) => e.t === 'welcome' && e.code).code;
    ctl.send({ t: 'adopt', code });
    await until(() => (ctl.last('badges') || { badges: [] }).badges.length > 0, 'adoption');
  };

  // --- the badge lets itself go, and the owner is told ---
  const owner = new Controller();
  await owner.connect();
  const badge = new FakeBadge({ url, id: 'rel:01', fw: 'rel' });
  const ev = [];
  badge.onEvent = (e) => ev.push(e);
  await badge.connect();
  await adopt(owner, badge, ev);
  ok(badge.paired === true, 'the badge is adopted to begin with');

  badge.release();
  await until(() => ev.some((e) => e.t === 'released'), 'the badge to be released');
  const released = ev.find((e) => e.t === 'released');
  ok(badge.paired === false, 'the badge no longer considers itself adopted');
  ok(!!released.code, `and is handed a fresh code to display (${released.code})`);
  await until(() => (owner.last('badges') || { badges: [null] }).badges.length === 0,
    'the owner roster to shrink');
  ok(hub.badges.has('rel:01') === false, 'and the server no longer holds the adoption');

  // The connection survives it - the badge must not look dead while it waits.
  ok(badge.ws.readyState === 1, 'the socket stays open through a release');

  // --- and it is genuinely adoptable again, by someone else ---
  {
    const other = new Controller();
    await other.connect();
    other.send({ t: 'adopt', code: released.code });
    await until(() => (other.last('badges') || { badges: [] }).badges.length === 1,
      'the new controller to adopt it');
    ok(true, 'a different controller can adopt it with the new code');
    ok(badge.paired === true, 'and the badge knows it');
    other.ws.close();
  }

  // --- the orphan case, which is the reason this exists ---
  {
    const lost = new Controller();
    await lost.connect();
    const orphan = new FakeBadge({ url, id: 'rel:orphan', fw: 'rel' });
    const oev = [];
    orphan.onEvent = (e) => oev.push(e);
    await orphan.connect();
    await adopt(lost, orphan, oev);

    // The controller vanishes for good: closed browser, cleared storage.
    lost.ws.close();
    await sleep(150);

    // Before `release` existed this was terminal - reconnecting gave
    // known:true and NO code, so nobody could ever adopt it again.
    orphan.release();
    await until(() => oev.some((e) => e.t === 'released'), 'the orphan to free itself');
    const code = oev.find((e) => e.t === 'released').code;
    ok(!!code, 'an orphaned badge can free itself and gets a code');

    const rescuer = new Controller();
    await rescuer.connect();
    rescuer.send({ t: 'adopt', code });
    await until(() => (rescuer.last('badges') || { badges: [] }).badges.length === 1,
      'the rescuer to adopt it');
    ok(true, 'and a fresh controller can then adopt it - no server restart needed');
    rescuer.ws.close();
    orphan.close();
  }

  // --- forget, from the controller, lands in the same place ---
  {
    const ctl = new Controller();
    await ctl.connect();
    const b2 = new FakeBadge({ url, id: 'rel:02', fw: 'rel' });
    const e2 = [];
    b2.onEvent = (e) => e2.push(e);
    await b2.connect();
    await adopt(ctl, b2, e2);

    ctl.send({ t: 'forget', id: 'rel:02' });
    await until(() => e2.some((e) => e.t === 'released'), 'the badge to be told it was forgotten');
    ok(b2.paired === false, 'a forgotten badge learns it is free');
    ok(!!e2.find((e) => e.t === 'released').code, 'and gets a code without reconnecting');
    ok(b2.ws.readyState === 1, 'without its socket being closed');
    b2.close();
    ctl.ws.close();
  }

  // --- a badge that un-adopted ON THE DEVICE, and never got to say so ---
  //
  // Factory reset, reflash, or "forget pairing" in the badge's own menu. It
  // reconnects holding nothing while the server still lists it, so it sat in
  // the sequencer as a badge that could not be used or removed. The badge is
  // the authority on its own adoption, so `hello` settles it.
  {
    const ctl = new Controller();
    await ctl.connect();
    const b3 = new FakeBadge({ url, id: 'rel:03', fw: 'rel' });
    const e3 = [];
    b3.onEvent = (e) => e3.push(e);
    await b3.connect();
    await adopt(ctl, b3, e3);
    ok(hub.badges.has('rel:03'), 'adopted to begin with');

    // It reboots having forgotten - and says so this time.
    b3.close();
    await sleep(150);
    const reset = new FakeBadge({ url, id: 'rel:03', fw: 'rel', claimsAdopted: false });
    const re = [];
    reset.onEvent = (e) => re.push(e);
    await reset.connect();
    await until(() => re.some((e) => e.t === 'welcome'), 'welcome after reset');

    const w = re.find((e) => e.t === 'welcome');
    ok(w.known === false, 'the server takes the badge at its word');
    ok(!!w.code, 'and offers a code straight away');
    await until(() => (ctl.last('badges') || { badges: [null] }).badges.length === 0,
      'the sequencer roster to drop it');
    ok(hub.badges.has('rel:03') === false, 'it is gone from the server too');
    reset.close();
    ctl.ws.close();
  }

  // --- ...but silence is NOT a disclaimer ---
  //
  // Adoption surviving a reconnect is the whole reason a badge with a flaky
  // link keeps working. A badge that simply does not send the field must not
  // be freed by connecting.
  {
    const ctl = new Controller();
    await ctl.connect();
    const b4 = new FakeBadge({ url, id: 'rel:04', fw: 'rel' });
    const e4 = [];
    b4.onEvent = (e) => e4.push(e);
    await b4.connect();
    await adopt(ctl, b4, e4);

    b4.close();
    await sleep(150);
    const back = new FakeBadge({ url, id: 'rel:04', fw: 'rel' }); // no claim
    const be = [];
    back.onEvent = (e) => be.push(e);
    await back.connect();
    await until(() => be.some((e) => e.t === 'welcome'), 'welcome after a blip');
    ok(be.find((e) => e.t === 'welcome').known === true,
      'a badge that makes no claim keeps its adoption across a reconnect');
    ok(hub.badges.has('rel:04'), 'and stays in the roster');
    back.close();
    ctl.ws.close();
  }

  // --- badges have names, and announce them ---
  //
  // "Badge 1", "Badge 2" is a placeholder for a device that did not say what
  // it is called. Eight of those on a table is a guessing game.
  {
    const ctl = new Controller();
    await ctl.connect();
    const named = new FakeBadge({
      url, id: 'name:01', fw: 'rel', announceName: 'Astronaut Blue',
    });
    const ne = [];
    named.onEvent = (e) => ne.push(e);
    await named.connect();
    await adopt(ctl, named, ne);
    eq(ctl.last('badges').badges[0].name, 'Astronaut Blue',
      'a badge that announces a name is listed under it, not "Badge 1"');

    // The name follows the device across a reconnect, including a change.
    named.close();
    await sleep(150);
    const renamedOnDevice = new FakeBadge({
      url, id: 'name:01', fw: 'rel', announceName: 'Astronaut Red',
    });
    await renamedOnDevice.connect();
    await until(() => (ctl.last('badges') || { badges: [{}] }).badges[0].name === 'Astronaut Red',
      'the roster to follow a rename on the device');
    ok(true, 'renaming it on the badge updates the sequencer');

    // ...but a name typed in the sequencer is sticky. Whoever acted
    // deliberately last wins, and typing a name is more deliberate than a
    // device reporting its label on every connect.
    ctl.send({ t: 'rename', id: 'name:01', name: 'Bass' });
    await until(() => (ctl.last('badges') || { badges: [{}] }).badges[0].name === 'Bass', 'the rename');
    renamedOnDevice.close();
    await sleep(150);
    const back = new FakeBadge({ url, id: 'name:01', fw: 'rel', announceName: 'Astronaut Red' });
    const be = [];
    back.onEvent = (e) => be.push(e);
    await back.connect();
    await until(() => be.some((e) => e.t === 'welcome'), 'reconnect');
    await sleep(200);
    eq(ctl.last('badges').badges[0].name, 'Bass',
      'a badge cannot overwrite a name someone typed in the sequencer');
    back.close();
    ctl.ws.close();
  }

  // A name is human text, and the badge is on the far side of the internet.
  {
    const { sanitizeName, MAX_NAME } = await import('./rooms.mjs');
    eq(sanitizeName('  Astronaut Blue  '), 'Astronaut Blue', 'names are trimmed');
    eq(sanitizeName('Bad\nName\tHere'), 'BadNameHere', 'control characters are stripped');
    eq(sanitizeName('x'.repeat(200)).length, MAX_NAME, 'and the length is capped');
    eq(sanitizeName(null), '', 'a non-string is no name at all');
    eq(sanitizeName('   '), '', 'and neither is whitespace');
  }

  // --- releasing when not adopted is harmless ---
  {
    const loose = new FakeBadge({ url, id: 'rel:loose', fw: 'rel' });
    const le = [];
    loose.onEvent = (e) => le.push(e);
    await loose.connect();
    await until(() => le.some((e) => e.t === 'welcome'), 'welcome');
    loose.release();
    await until(() => le.some((e) => e.t === 'released'), 'a release from an unadopted badge');
    ok(loose.ws.readyState === 1, 'releasing when not adopted is a no-op, not an error');
    loose.close();
  }

  badge.close(); owner.ws.close();
  await sleep(50);
  httpServer.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
