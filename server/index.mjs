// The ChipSeq badge server.
//
//   node server/index.mjs [--port 8080] [--root .]
//
// Serves the sequencer AND the badge socket from one origin, which is what
// makes Tailscale Funnel a complete answer: one funnel mapping publishes both,
// so there is no mixed content, no CORS, and no second thing to deploy. See
// server/README.md.
//
// Two roles share the socket, told apart by the first frame:
//
//   badge      - docs/badge-protocol.md, the contract with the firmware
//   controller - the sequencer, documented in server/README.md
//
// The server's clock is authoritative for both. That is the whole reason it
// sits in the middle: browser, badges and server would otherwise be three
// clocks with no agreement between them.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket } from './ws.mjs';
import { Hub } from './rooms.mjs';

export const PROTOCOL_VERSION = 2;

// The largest frame the relay will forward. Upload chunks are capped at 1024
// raw bytes (~1368 base64 characters) by the protocol, so this is generous -
// it exists so a misbehaving controller cannot make the relay buffer without
// bound, not to constrain a correct one.
export const MAX_RELAY_BYTES = 8 * 1024;

// Frames a badge may send TO the controller that owns it. An allowlist rather
// than a passthrough: the badge is on the far side of the internet, and a
// relay that forwards anything is a relay that forwards whatever an attacker
// puts in it.
const BADGE_TO_CONTROLLER = new Set(['put_ack', 'put_done', 'lib']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

export function createServer({ root, log = () => {} } = {}) {
  const hub = new Hub();
  const controllers = new Set(); // { conn, sessionId }
  // Badges that are connected but not yet adopted. The hub only knows badges
  // it owns, so without this the display flow could mint a code for a badge
  // and then have no way to tell it that it worked.
  //
  // It holds `caps` and `fw` as well as the socket because adoption happens on
  // the CONTROLLER's connection, which never saw the badge's hello - and a
  // badge whose capabilities were forgotten at adoption looks to the sequencer
  // like one that can only play live notes.
  const pendingConns = new Map(); // badgeId -> { conn, caps, fw }

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, v: PROTOCOL_VERSION, ...hub.stats() }));
      return;
    }
    if (!root) {
      res.writeHead(404).end('not found');
      return;
    }
    // Static app, same origin as the socket.
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
    const path = join(root, rel);
    if (!path.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const info = await stat(path);
      const file = info.isDirectory() ? join(path, 'index.html') : path;
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        // The app is lazily imported; a stale tool card against a fresh core
        // is a miserable thing to debug. See dev-server.mjs for the long story.
        'Cache-Control': 'no-store',
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });

  const pushBadges = (sessionId) => {
    const list = hub.badgesOf(sessionId);
    for (const c of controllers) {
      if (c.sessionId === sessionId) c.conn.sendJson({ t: 'badges', badges: list });
    }
  };

  // The reverse path: a frame the BADGE authored, delivered to the controllers
  // that own it. Everything else the badge sends is answered by the server
  // itself; this is the only direction where a badge speaks and the sequencer
  // listens, and it exists because an upload has to be acknowledged by the
  // thing doing the writing.
  //
  // Sent to every controller in the session, not just whichever one started
  // the upload: two open tabs should both see the library change.
  const toControllers = (sessionId, frame) => {
    let delivered = 0;
    for (const c of controllers) {
      if (c.sessionId === sessionId) { c.conn.sendJson(frame); delivered++; }
    }
    return delivered;
  };

  attachWebSocket(httpServer, {
    path: '/ws',
    onConnection: (conn, req) => {
      // Behind Funnel or any proxy the socket address is the proxy; the
      // forwarded header is what identifies the actual client for rate limits.
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || conn.remote;
      let role = null;
      let badgeId = null;
      let sessionId = null;
      let badgePingSeen = false;
      let badgeCaps = null;

      conn.onClose = () => {
        if (role === 'badge' && badgeId) {
          // The offer deliberately OUTLIVES the connection, for its full TTL.
          // Killing it here was wrong: a badge with a flaky link disconnects
          // seconds after being handed a code, and the user is then typing a
          // code the server has already forgotten while the badge is still
          // displaying it. It names one specific badge and expires on its
          // own; that is enough.
          pendingConns.delete(badgeId);
          hub.detach(badgeId);
          const b = hub.badges.get(badgeId);
          if (b) pushBadges(b.sessionId);
        }
        if (role === 'controller') {
          for (const c of controllers) if (c.conn === conn) controllers.delete(c);
        }
        log('close', { role, badgeId });
      };

      conn.onMessage = (text) => {
        if (text.length > MAX_RELAY_BYTES) {
          // Refused, but not fatal: a single oversized frame is a bug in the
          // sender, not a reason to drop a badge mid-song.
          conn.sendJson({ t: 'error', code: 'big', msg: `frame over ${MAX_RELAY_BYTES} bytes` });
          log('oversize', { role, bytes: text.length });
          return;
        }
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          conn.sendJson({ t: 'error', code: 'bad', msg: 'not JSON' });
          return;
        }
        if (!msg || typeof msg.t !== 'string') {
          conn.sendJson({ t: 'error', code: 'bad', msg: 'no type' });
          return;
        }

        // ---- first frame decides the role ----
        if (!role) {
          if (msg.t !== 'hello') {
            conn.sendJson({ t: 'error', code: 'bad', msg: 'expected hello' });
            return;
          }
          if (msg.role === 'controller') {
            role = 'controller';
            sessionId = hub.resumeSession(msg.session);
            controllers.add({ conn, sessionId });
            conn.sendJson({
              t: 'welcome',
              v: PROTOCOL_VERSION,
              session: sessionId,
              s: Date.now(),
              badges: hub.badgesOf(sessionId),
            });
            log('controller', { sessionId });
            return;
          }
          // A badge. Version check first, and v2 is a HARD cut: a v1 badge is
          // refused rather than half-supported. Told plainly, because the
          // alternative is firmware that connects and then silently never
          // receives anything it understands.
          if (msg.v !== PROTOCOL_VERSION) {
            conn.sendJson({ t: 'error', code: 'version', need: PROTOCOL_VERSION });
            conn.close(1002, 'version');
            log('version_refused', { v: msg.v ?? null });
            return;
          }
          role = 'badge';
          badgeId = String(msg.id || '').slice(0, 64);
          if (!badgeId) {
            conn.sendJson({ t: 'error', code: 'bad', msg: 'no id' });
            conn.close(1002, 'no id');
            return;
          }
          // Absent caps means the minimum: live notes only. A badge that says
          // nothing is not assumed to be capable of everything.
          badgeCaps = Array.isArray(msg.caps)
            ? msg.caps.filter((c) => typeof c === 'string').slice(0, 8)
            : ['note'];

          // The badge is the authority on whether it holds an adoption. A
          // device that was factory-reset, reflashed, or un-adopted from its
          // own menu says so here and the server's record yields.
          //
          // Without this it stays in somebody's sequencer forever: the server
          // answers `known: true`, offers no pairing code, and the badge is
          // listed but unusable - the same dead end `release` fixed, reached
          // by a badge that never got to send it.
          //
          // ABSENT means "no claim", NOT "not adopted". A badge that does not
          // send the field must keep its adoption across a reconnect, which is
          // the normal case and the whole reason adoption survives a blip.
          if (msg.adopted === false) {
            const disowned = hub.release(badgeId);
            if (disowned) {
              pushBadges(disowned);
              log('disowned', { badgeId }); // the badge says it is not ours
            }
          }

          const known = hub.attach(badgeId, msg.fw, conn, badgeCaps);
          if (!known) pendingConns.set(badgeId, { conn, caps: badgeCaps, fw: msg.fw });
          // An unadopted badge is handed a code to DISPLAY. A badge with a
          // screen shows it and you type it into the sequencer; one without
          // ignores it and uses the button flow instead. Both work.
          conn.sendJson(
            known
              ? { t: 'welcome', v: PROTOCOL_VERSION, known: true, name: known.name }
              : { t: 'welcome', v: PROTOCOL_VERSION, known: false, code: hub.offerCode(badgeId) }
          );
          if (known) pushBadges(known.sessionId);
          log('badge', { badgeId, known: !!known });
          return;
        }

        if (role === 'badge') return handleBadge(msg);
        return handleController(msg);
      };

      function handleBadge(msg) {
        switch (msg.t) {
          case 'pair': {
            const res = hub.redeem(msg.code, badgeId, msg.fw, ip);
            if (res.error) {
              conn.sendJson({ t: 'pair_failed', reason: res.error });
              log('pair_failed', { badgeId, reason: res.error });
              return;
            }
            hub.attach(badgeId, msg.fw, conn, badgeCaps);
            pendingConns.delete(badgeId);
            conn.sendJson({ t: 'paired', name: res.name });
            pushBadges(res.sessionId);
            log('paired', { badgeId, name: res.name });
            return;
          }
          case 'ping':
            // Answered immediately and without work, because everything this
            // measures is the network - any delay here is measured as clock error.
            conn.sendJson({ t: 'pong', c: msg.c, s: Date.now() });
            if (!badgePingSeen) {
              badgePingSeen = true;
              log('badge_ping', { badgeId }); // once, so a silent badge is visible
            }
            return;
          case 'release': {
            // The badge owner decides this adoption is over. Its authority is
            // that it IS the badge - it is speaking on the connection that
            // said `hello` with this id - so there is no session to check.
            // Nothing new is exposed: anyone who could forge this could
            // already impersonate the badge outright.
            const freed = hub.release(badgeId);
            // Straight back into the pairing flow on the SAME socket, with a
            // code to display. Disconnecting instead would work, but it would
            // make the badge look broken for the second it took to reconnect.
            pendingConns.set(badgeId, { conn, caps: badgeCaps, fw: '' });
            hub.revokeOffer(badgeId);
            conn.sendJson({ t: 'released', code: hub.offerCode(badgeId) });
            if (freed) pushBadges(freed); // the old owner's list just shrank
            log('released', { badgeId, wasAdopted: !!freed });
            return;
          }
          case 'bye':
            conn.close(1000, 'bye');
            return;
          default: {
            // Upload acknowledgements and library reports travel back to the
            // sequencer. Everything else a badge says is either handled above
            // or ignored - the same rule the badge follows for us.
            if (!BADGE_TO_CONTROLLER.has(msg.t)) return;
            const b = hub.badges.get(badgeId);
            if (!b) return; // unadopted badges have nobody to talk to
            if (msg.t === 'lib' && hub.setLibrary(badgeId, msg)) pushBadges(b.sessionId);
            // `badge` is stamped by the server, not taken from the frame: a
            // badge must not be able to claim it is a different badge.
            const delivered = toControllers(b.sessionId, { ...msg, badge: badgeId });
            log(msg.t, { from: badgeId, delivered });
            return;
          }
        }
      }

      function handleController(msg) {
        const need = (id) => hub.owned(sessionId, id);
        switch (msg.t) {
          case 'code': {
            const { code, expires } = hub.issueCode(sessionId);
            conn.sendJson({ t: 'code', code, expires, ttl: expires - Date.now() });
            return;
          }
          case 'now':
            conn.sendJson({ t: 'now', s: Date.now() });
            return;
          case 'adopt': {
            const res = hub.adopt(msg.code, sessionId, ip);
            if (res.error) {
              conn.sendJson({ t: 'adopt_failed', reason: res.error });
              log('adopt_failed', { reason: res.error });
              return;
            }
            // Reunite the freshly adopted badge with its live socket, and with
            // what it told us at hello - the controller's connection never saw
            // that, so it has to come from where the badge's own connection
            // left it.
            const live = pendingConns.get(res.badgeId);
            if (live) {
              hub.attach(res.badgeId, live.fw, live.conn, live.caps);
              pendingConns.delete(res.badgeId);
              live.conn.sendJson({ t: 'paired', name: res.name });
            }
            pushBadges(sessionId);
            log('adopted', { badgeId: res.badgeId, name: res.name });
            return;
          }
          case 'rename':
            if (hub.rename(sessionId, msg.id, msg.name)) {
              const b = hub.badges.get(msg.id);
              if (b.conn) b.conn.sendJson({ t: 'name', name: b.name });
              pushBadges(sessionId);
            }
            return;
          case 'map':
            if (hub.map(sessionId, msg.id, msg.trackId)) {
              // Unmapping must silence it: otherwise the last note hangs.
              const b = hub.badges.get(msg.id);
              if (!b.trackId && b.conn) b.conn.sendJson({ t: 'stop' });
              pushBadges(sessionId);
            }
            return;
          case 'forget': {
            // Grab the socket before the record goes: a forgotten badge is
            // handed a fresh code on the connection it already has, so it is
            // immediately adoptable again instead of appearing dead until it
            // notices and reconnects. Same end state as a badge-initiated
            // release, reached from the other side.
            const target = hub.owned(sessionId, msg.id);
            const live = target && target.conn && target.conn.open ? target.conn : null;
            const caps = target ? target.caps : null;
            const fw = target ? target.fw : '';
            if (hub.forget(sessionId, msg.id)) {
              if (live) {
                pendingConns.set(msg.id, { conn: live, caps, fw });
                hub.revokeOffer(msg.id);
                live.sendJson({ t: 'released', code: hub.offerCode(msg.id) });
              }
              pushBadges(sessionId);
              log('forgot', { badgeId: msg.id, told: !!live });
            }
            return;
          }
          case 'note': {
            const b = need(msg.id);
            if (b && b.conn) b.conn.sendJson({ t: 'note', p: msg.p, ms: msg.ms });
            log('note', { to: msg.id, p: msg.p, ms: msg.ms, delivered: !!(b && b.conn) });
            return;
          }
          case 'sched': {
            const b = need(msg.id);
            if (b && b.conn) b.conn.sendJson({ t: 'sched', t0: msg.t0, n: msg.n });
            log('sched', { to: msg.id, notes: (msg.n || []).length, delivered: !!(b && b.conn) });
            return;
          }
          case 'stop': {
            const targets = msg.id ? [need(msg.id)] : hub.badgesOf(sessionId).map((x) => hub.badges.get(x.id));
            for (const b of targets) if (b && b.conn) b.conn.sendJson({ t: 'stop' });
            return;
          }
          // ---- library and upload ----
          //
          // Forwarded verbatim minus the addressing. The server holds NO tune
          // bytes: an upload that dies is retried by the controller, which is
          // what keeps "state is in memory and there is nothing to persist"
          // true even while several megabytes flow through.
          case 'put':
          case 'put_data':
          case 'put_end':
          case 'lib?':
          case 'drop': {
            const b = need(msg.badge);
            if (!b || !b.conn) {
              conn.sendJson({ t: 'put_done', id: msg.id, badge: msg.badge, ok: false, reason: 'offline' });
              return;
            }
            const { badge, ...frame } = msg;
            b.conn.sendJson(frame);
            // Chunks are logged by count, not individually: a 39 kB tune is 39
            // chunks and a per-chunk line would bury everything else.
            if (msg.t !== 'put_data') log(msg.t, { to: msg.badge, id: msg.id });
            return;
          }
          default:
            return;
        }
      }
    },
  });

  return { httpServer, hub, controllers };
}

// ---- CLI ----

function parseArgs(argv) {
  const out = { port: 8080, root: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--root') out.root = argv[++i];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root
    ? normalize(args.root)
    : fileURLToPath(new URL('..', import.meta.url));
  const { httpServer } = createServer({
    root,
    log: (what, info) => console.log(new Date().toISOString(), what, JSON.stringify(info)),
  });
  httpServer.listen(args.port, () => {
    console.log(`ChipSeq badge server on http://localhost:${args.port}`);
    console.log(`  app    http://localhost:${args.port}/`);
    console.log(`  socket ws://localhost:${args.port}/ws`);
    console.log(`  serving ${root}`);
  });
}
