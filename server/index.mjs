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

export const PROTOCOL_VERSION = 1;

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
  // Live sockets for badges that are connected but not yet adopted. The hub
  // only knows badges it owns, so without this the display flow could mint a
  // code for a badge and then have no way to tell it that it worked.
  const pendingConns = new Map(); // badgeId -> conn

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
          // A badge. Version check first: a badge that speaks a language we
          // do not is told so plainly rather than left guessing.
          if (typeof msg.v === 'number' && msg.v !== PROTOCOL_VERSION) {
            conn.sendJson({ t: 'error', code: 'version', need: PROTOCOL_VERSION });
            conn.close(1002, 'version');
            return;
          }
          role = 'badge';
          badgeId = String(msg.id || '').slice(0, 64);
          if (!badgeId) {
            conn.sendJson({ t: 'error', code: 'bad', msg: 'no id' });
            conn.close(1002, 'no id');
            return;
          }
          const known = hub.attach(badgeId, msg.fw, conn);
          if (!known) pendingConns.set(badgeId, conn);
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
            hub.attach(badgeId, msg.fw, conn);
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
          case 'bye':
            conn.close(1000, 'bye');
            return;
          default:
            return; // unknown types ignored, same rule the badge follows
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
            // Reunite the freshly adopted badge with its live socket.
            const live = pendingConns.get(res.badgeId);
            if (live) {
              hub.attach(res.badgeId, '', live);
              pendingConns.delete(res.badgeId);
              live.sendJson({ t: 'paired', name: res.name });
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
          case 'forget':
            if (hub.forget(sessionId, msg.id)) pushBadges(sessionId);
            return;
          case 'note': {
            const b = need(msg.id);
            if (b && b.conn) b.conn.sendJson({ t: 'note', p: msg.p, ms: msg.ms });
            return;
          }
          case 'sched': {
            const b = need(msg.id);
            if (b && b.conn) b.conn.sendJson({ t: 'sched', t0: msg.t0, n: msg.n });
            return;
          }
          case 'stop': {
            const targets = msg.id ? [need(msg.id)] : hub.badgesOf(sessionId).map((x) => hub.badges.get(x.id));
            for (const b of targets) if (b && b.conn) b.conn.sendJson({ t: 'stop' });
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
