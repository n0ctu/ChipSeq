// The sequencer's half of the badge protocol: a controller connection.
//
// Deliberately NOT in js/core/. Core is pure and deterministic - that is what
// lets flattenSong be golden-tested and what keeps preview === export true -
// and a socket is neither. Everything here is I/O; nothing here decides what
// the music is.
//
// The badge side of the protocol is docs/badge-protocol.md; the controller
// side is documented in server/README.md.
//
// Nothing connects on its own. The module is inert until connect() is called,
// which happens when the Badges card is opened - so the app's promise that it
// makes no external requests holds for anyone who never opens it.

const URL_KEY = 'chipseq.v1.badgeServer';
const SESSION_KEY = 'chipseq.v1.badgeSession';
const AUTO_KEY = 'chipseq.v1.badgeAuto';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

// ---- clock ----
//
// Same algorithm as docs/badge-protocol.md §4, and deliberately duplicated
// rather than shared with tools/fake-badge.mjs: that file is a specification
// artifact a firmware author reads on its own, and it would be worth less if
// understanding it required following an import into an app. A unit test
// asserts the two implementations agree, which is the real guarantee.

export function offsetFrom(sentAt, gotAt, serverMs) {
  return serverMs + (gotAt - sentAt) / 2 - gotAt;
}

export function medianOffset(samples, window = 5) {
  const recent = samples.slice(-window).sort((a, b) => a - b);
  if (!recent.length) return 0;
  const mid = recent.length >> 1;
  return recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
}

// ---- state ----
//
// A module-level snapshot so the tool manifest can render a status for a
// COLLAPSED card without loading or connecting anything. Read-only to callers.
const state = {
  url: '',
  connected: false,
  connecting: false,
  badges: [],
  code: null, // { code, expires } - for the button flow
  adoptError: null,
  offset: 0,
  error: null,
};

export function badgeState() {
  return state;
}

// Where the deployed build points by default. A static host cannot itself be
// the badge server, so guessing its origin there is guaranteed wrong - this is
// the server the published build should reach instead. Anyone running their
// own only has to change the field once; it is remembered.
//
// A dedicated relay rather than the Tailscale Funnel it used to be: Funnel
// relays every public client through Tailscale's own infrastructure, which is
// fine for scheduled playback and poor for live note-by-note.
export const PUBLIC_BADGE_SERVER = 'wss://ws.chipseq.app/ws';

// Somewhere the relay could plausibly be serving this page: a machine you are
// running it on. Everything else is a published build on a static host.
//
// The rule is written this way round deliberately. It used to ask "is this a
// known static host?" and name github.io, which meant the answer was an
// open-ended list - and the moment the site moved to chipseq.app the list was
// out of date and the card prefilled wss://chipseq.app/ws, an origin that
// serves no socket at all. The set of places you might run the relay yourself
// is bounded and stable; the set of hosts someone might publish to is not.
function selfHosted(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /(^|\.)ts\.net$/.test(hostname)
  );
}

// Pure, so tests can ask it about hosts this build will never be served from.
// `host` carries the port and `hostname` does not, and both are needed: the
// port belongs in the URL, and it must not confuse the classification.
export function relayUrlFor(loc) {
  const { protocol, host, hostname } = loc || {};
  if (!host || !hostname) return '';
  if (!selfHosted(hostname)) return PUBLIC_BADGE_SERVER;
  if (protocol === 'http:' || protocol === 'https:') {
    // The scheme has to follow the page: an https page cannot open ws://.
    return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
  }
  return '';
}

export function defaultServerUrl() {
  try {
    return relayUrlFor(window.location);
  } catch {
    return ''; // no window: tests
  }
}

// True when the address shown was inferred from this page rather than being the
// relay we ship. The published relay is a known address, not a guess, so saying
// otherwise would put a warning under the one value that is usually right.
export function isGuessedUrl() {
  const url = defaultServerUrl();
  return !read(URL_KEY) && !!url && url !== PUBLIC_BADGE_SERVER;
}

const read = (key, fallback = '') => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: the feature still works for this session */
  }
};

export function savedUrl() {
  return read(URL_KEY) || defaultServerUrl();
}

export function shouldAutoConnect() {
  return read(AUTO_KEY) === '1';
}

// ---- the client ----

// One client per page.
//
// The Badges card and the transport both need it, and two connections would
// mean two sessions, two rosters, and badges visible in the card that the
// player cannot address. The card was creating its own, which is why nothing
// played: the stream held a different client that had never connected.
let shared = null;
const listeners = new Set();
// Frames a BADGE authored, for whoever is running an upload. Separate from
// `listeners` because these are not state changes - an ack is addressed to one
// in-flight transfer, not news for the whole UI.
const frameListeners = new Set();

export function getBadgeClient() {
  if (!shared) {
    shared = createBadgeClient({
      onChange: (s) => listeners.forEach((fn) => fn(s)),
      onFrame: (msg) => frameListeners.forEach((fn) => fn(msg)),
    });
  }
  return shared;
}

export function onBadgeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function onBadgeFrame(fn) {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

export function createBadgeClient({ onChange = () => {}, onFrame = () => {} } = {}) {
  let ws = null;
  let attempt = 0;
  let closedByUs = false;
  let pingTimer = null;
  let sentAt = 0;
  const offsets = [];

  const changed = () => onChange(state);

  function connect(url) {
    const target = url || savedUrl();
    if (!target) {
      state.error = 'No server address';
      changed();
      return;
    }
    state.url = target;
    write(URL_KEY, target);
    closedByUs = false;
    state.connecting = true;
    state.error = null;
    changed();

    try {
      ws = new WebSocket(target);
    } catch (err) {
      state.connecting = false;
      state.error = err.message || 'bad address';
      changed();
      return;
    }

    ws.onopen = () => {
      attempt = 0;
      send({ t: 'hello', role: 'controller', session: read(SESSION_KEY) || undefined });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handle(msg);
    };
    ws.onerror = () => {
      // onclose always follows, and carries the retry logic.
      state.error = 'connection failed';
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      state.connected = false;
      state.connecting = false;
      changed();
      if (!closedByUs) retry();
    };
  }

  function retry() {
    const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
    setTimeout(() => {
      if (!closedByUs) connect(state.url);
    }, wait);
  }

  function handle(msg) {
    switch (msg.t) {
      case 'welcome':
        state.connected = true;
        state.connecting = false;
        state.badges = msg.badges || [];
        write(SESSION_KEY, msg.session);
        write(AUTO_KEY, '1');
        // First clock sample comes free with the welcome.
        note(msg.s);
        startPinging();
        changed();
        return;
      case 'badges':
        state.badges = msg.badges || [];
        state.adoptError = null; // a roster change means an adopt worked
        changed();
        return;
      case 'code':
        state.code = { code: msg.code, expires: msg.expires };
        changed();
        return;
      case 'adopt_failed':
        state.adoptError = msg.reason || 'unknown';
        changed();
        return;
      case 'now':
        // Deliberately no changed(): a clock sample every few seconds is not
        // a reason to rebuild the UI, and repainting on a timer is how a
        // text field loses what you are typing into it.
        note(msg.s);
        return;
      case 'error':
        state.error = msg.msg || msg.code;
        changed();
        return;
      // ---- frames the badge authored (v2) ----
      //
      // `lib` is both: it changes what the UI shows AND it may be the answer
      // an upload is waiting on, so it goes to both paths.
      case 'lib':
        onFrame(msg);
        changed();
        return;
      case 'put_ack':
      case 'put_done':
      case 'get_begin':
      case 'get_data':
      case 'get_end':
      case 'get_fail':
        onFrame(msg);
        return;
      default:
        // Unknown types are ignored: a newer server must not break an older tab.
    }
  }

  function note(serverMs) {
    if (typeof serverMs !== 'number') return;
    offsets.push(offsetFrom(sentAt || Date.now(), Date.now(), serverMs));
    state.offset = medianOffset(offsets);
  }

  function startPinging() {
    clearInterval(pingTimer);
    const tick = () => {
      sentAt = Date.now();
      send({ t: 'now' });
    };
    tick();
    pingTimer = setInterval(tick, 5000);
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function disconnect() {
    closedByUs = true;
    write(AUTO_KEY, null);
    clearInterval(pingTimer);
    if (ws) ws.close();
    state.connected = false;
    state.connecting = false;
    state.code = null;
    changed();
  }

  return {
    connect,
    disconnect,
    state,
    // What the server's clock reads right now, by our best estimate. Scheduled
    // playback is timestamped against this.
    serverNow: () => Date.now() + state.offset,
    requestCode: () => send({ t: 'code' }),
    adopt: (code) => {
      state.adoptError = null;
      send({ t: 'adopt', code });
    },
    rename: (id, name) => send({ t: 'rename', id, name }),
    map: (id, trackId) => send({ t: 'map', id, trackId: trackId || null }),
    forget: (id) => send({ t: 'forget', id }),
    note: (id, p, ms) => send({ t: 'note', id, p, ms }),
    sched: (id, t0, n) => send({ t: 'sched', id, t0, n }),
    stop: (id) => send({ t: 'stop', id }),
    // Library and upload. `send` is exposed because createUpload drives its
    // own frames - it owns the window and the resend clock, and routing every
    // chunk through a named method here would just be a longer way to say the
    // same thing.
    send,
    askLibrary: (badge) => send({ t: 'lib?', badge }),
    dropTune: (badge, id) => send({ t: 'drop', badge, id }),
  };
}

// What a badge said it can do. Absent means the v2 minimum: live notes only.
// Used to hide controls rather than to send frames and hope - a button that
// silently does nothing is worse than one that is not there.
export function badgeCan(badge, capability) {
  return !!badge && (badge.caps || ['note']).includes(capability);
}
