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
  eq(hub.redeem('LLLLLL', 'badge-a', 'fw', '1.1.1.1').error, 'unknown', 'a wrong code is rejected');
  const r = hub.redeem(code, 'badge-a', 'fw1', '1.1.1.1');
  ok(r.ok && r.sessionId === s1, 'the right code adopts the badge into that session');
  eq(hub.badgesOf(s2), [], 'and not into anyone else\'s');
  eq(hub.badgesOf(s1).length, 1, 'the owning session sees it');

  // Single use.
  eq(hub.redeem(code, 'badge-b', 'fw', '1.1.1.2').error, 'unknown', 'a code cannot be used twice');

  // Expiry, by moving the clock rather than sleeping two minutes.
  const second = hub.issueCode(s1);
  clock += CODE_TTL_MS + 1;
  eq(hub.redeem(second.code, 'badge-c', 'fw', '1.1.1.3').error, 'expired', 'a stale code is expired, not accepted');

  // Rate limiting is per address.
  const third = hub.issueCode(s1);
  for (let i = 0; i < PAIR_MAX_ATTEMPTS; i++) hub.redeem('UUUUUU', 'badge-d', 'fw', '9.9.9.9');
  eq(hub.redeem(third.code, 'badge-d', 'fw', '9.9.9.9').error, 'rate', 'a guessing address is cut off');
  ok(hub.redeem(third.code, 'badge-e', 'fw', '8.8.8.8').ok, 'while an innocent address is unaffected');

  // Ownership: one session cannot touch another's badge.
  ok(hub.rename(s1, 'badge-a', 'Bass') === true, 'the owner can rename');
  ok(hub.rename(s2, 'badge-a', 'Stolen') === false, 'a stranger cannot');
  ok(hub.map(s2, 'badge-a', 'track-1') === false, 'nor map it');
  ok(hub.owned(s2, 'badge-a') === null, 'nor address it at all');

  // Two badges on one track is a supported arrangement, not an accident.
  hub.redeem(hub.issueCode(s1).code, 'badge-f', 'fw', '1.1.1.9');
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

  // A new offer replaces the old one for the same badge: reconnecting must not
  // leave a redeemable code behind for a connection that is gone.
  const first = hub.offerCode('badge-w');
  const second = hub.offerCode('badge-w');
  ok(first !== second, 'reconnecting mints a new code');
  eq(hub.adopt(first, s1, '5.5.5.5').error, 'unknown', 'and the previous one stops working');
  ok(hub.adopt(second, s1, '5.5.5.5').ok, 'while the current one works');

  // Revoked on disconnect.
  const live = hub.offerCode('badge-v');
  hub.revokeOffer('badge-v');
  eq(hub.adopt(live, s1, '5.5.5.5').error, 'unknown', 'a code dies with its connection');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
