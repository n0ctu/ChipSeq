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

export function defaultServerUrl() {
  try {
    // Served from the badge server itself? Then the socket is right here, and
    // the scheme has to follow the page or the browser will refuse it.
    const { protocol, host } = window.location;
    if (protocol === 'http:' || protocol === 'https:') {
      return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
    }
  } catch {
    /* no window: tests */
  }
  return '';
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

export function createBadgeClient({ onChange = () => {} } = {}) {
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
        note(msg.s);
        changed();
        return;
      case 'error':
        state.error = msg.msg || msg.code;
        changed();
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
  };
}
