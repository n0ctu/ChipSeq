// Badges card: connect to a badge server, adopt badges, map them to tracks.
//
// The pairing code is shown as the buttons you actually press, not as letters
// - the badge has a d-pad, so "↑ → ↓ ← A B" is the instruction and "URDLAB" is
// only how it travels over the wire.

import {
  getBadgeClient, onBadgeChange, onBadgeFrame, badgeState, savedUrl,
  shouldAutoConnect, isGuessedUrl, badgeCan,
} from '../../net/badges.js';
import { createUpload, createFetch, replacePlan } from '../../net/badge-upload.js';
import { buildTune } from '../../core/badge-tune.js';
import { icon } from '../icons.js';
import { confirmDialog } from '../dialogs.js';

// Bytes, for a card that has to say whether a 39 kB tune fits in what is left.
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(ms) {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The wire alphabet, as the thing in your hands.
const GLYPH = { U: '↑', R: '→', D: '↓', L: '←', A: 'A', B: 'B' };

export function showCode(code) {
  return [...String(code || '')].map((c) => GLYPH[c] || c).join(' ');
}

export function countdown(expires, now = Date.now()) {
  const left = Math.max(0, expires - now);
  const s = Math.ceil(left / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function mount(body, { store, badgeStream = null, openImportedTune = null }) {
  let client = null;
  let unsubscribe = null;
  let unsubscribeFrames = null;
  let tick = null;

  const state = badgeState();
  // Uploads in flight, by badge id. Held here rather than in module state so
  // closing the card cancels them - a transfer whose progress bar is gone is a
  // transfer nobody can stop.
  const uploads = new Map();
  // In-flight downloads, keyed like uploads. A fetched tune opens as a new
  // project, so one at a time per badge is plenty.
  const fetches = new Map();

  // The card rebuilds its DOM on every state change, and state changes for
  // reasons that have nothing to do with what you are typing - a clock sample
  // every few seconds, a badge coming online, a track being renamed. Without
  // this, the field you are typing a code into is destroyed underneath you.
  //
  // Restoring focus and caret AFTER the rebuild is the fix that survives
  // whatever triggers the next render, rather than chasing each trigger.
  function withFocusPreserved(fn) {
    const active = document.activeElement;
    const id = active && body.contains(active) ? active.id : null;
    const value = id ? active.value : null;
    const start = id && active.selectionStart != null ? active.selectionStart : null;
    const end = id && active.selectionEnd != null ? active.selectionEnd : null;
    fn();
    if (!id) return;
    const next = body.querySelector('#' + id);
    if (!next) return;
    if (value != null && next.value !== undefined) next.value = value;
    next.focus();
    if (start != null && next.setSelectionRange) {
      try {
        next.setSelectionRange(start, end);
      } catch {
        /* not a text input */
      }
    }
  }

  // Badges whose library we have already asked for on this connection. A
  // badge reports unprompted after any change, so one ask is enough - and
  // asking on every render would put a frame on the wire for every keystroke.
  const asked = new Set();

  function refreshLibraries() {
    // A dropped connection invalidates every ask: the badge may have been
    // re-flashed, or a different one may reconnect under the same name.
    if (!state.connected) { asked.clear(); return; }
    if (!client) return;
    // Forget badges that have left the roster, so re-adopting one asks again.
    // Without this a badge that releases itself and is adopted back in the
    // same session keeps its id in here, is never asked, and shows an empty
    // library for the rest of the session while actually holding tunes.
    const present = new Set(state.badges.map((b) => b.id));
    for (const id of asked) if (!present.has(id)) asked.delete(id);
    for (const b of state.badges) {
      if (!b.online || !badgeCan(b, 'store') || asked.has(b.id)) continue;
      asked.add(b.id);
      client.askLibrary(b.id);
    }
  }

  function render() {
    withFocusPreserved(() => draw());
    refreshLibraries();
  }

  function draw() {
    const doc = store.getDoc();
    const s = state;

    const connectRow = `
      <div class="harm-row">
        <input type="text" id="bg-url" spellcheck="false" value="${s.url || savedUrl()}"
          placeholder="wss://box.tailnet.ts.net/ws"
          title="The badge server's WebSocket address. Not the page you are on unless the server is also serving this app." />
        <button class="btn" id="bg-connect">${s.connected ? 'Disconnect' : 'Connect'}</button>
      </div>
      ${!s.connected && isGuessedUrl() ? `<div class="in-hint">Guessed from this page's address.
        If the badge server runs elsewhere, correct the port - it is a
        <b>ws://</b> address, not http.</div>` : ''}`;

    if (!s.connected) {
      body.innerHTML = `
        ${connectRow}
        <div class="in-hint">${
          s.connecting ? 'Connecting…'
            : s.error ? `Not connected - ${s.error}`
            : 'Not connected. Nothing leaves this browser until you press Connect.'}</div>`;
      return;
    }

    const pairing = s.code && s.code.expires > Date.now();
    const tracks = doc.tracks || [];

    body.innerHTML = `
      ${connectRow}
      <div class="lv-out-head">Connected
        <span class="lv-mode">clock ${s.offset >= 0 ? '+' : ''}${Math.round(s.offset)} ms</span></div>

      <div class="bg-adopt">
        <div class="harm-row">
          <input type="text" id="bg-adopt-code" spellcheck="false" maxlength="8"
            placeholder="code from the badge" />
          <button class="btn" id="bg-adopt">Adopt</button>
        </div>
        <div class="in-hint">${s.adoptError
          ? `That code ${s.adoptError === 'unknown' ? 'is not valid' : s.adoptError === 'expired' ? 'has expired' : 'was rejected'} - the badge shows a new one each time it connects.`
          : 'Type the code shown on the badge.'}</div>
      </div>

      ${pairing ? `
        <div class="bg-code">
          <div class="bg-code-glyphs">${showCode(s.code.code)}</div>
          <div class="in-hint">For a badge with no display: enter this on it · expires in
            <b id="bg-countdown">${countdown(s.code.expires)}</b></div>
        </div>`
        : '<button class="btn-link" id="bg-pair">Badge has no display?</button>'}

      ${s.badges.length ? `<div class="bg-list">${s.badges.map((b) => `
        <div class="bg-badge${b.online ? '' : ' offline'}" data-id="${b.id}">
          <div class="harm-caption">
            <span class="bg-dot${b.online ? ' on' : ''}"></span>
            <b class="bg-name" title="Double-click to rename">${b.name}</b>
            <button class="btn-icon" data-act="forget" title="Forget this badge">${icon('trash')}</button>
          </div>
          <div class="fx-param">
            <label>Plays</label>
            <select data-act="map">
              <option value="">— nothing —</option>
              ${tracks.map((t) => `<option value="${t.id}"${b.trackId === t.id ? ' selected' : ''}>${t.name}</option>`).join('')}
            </select>
          </div>
          ${library(b)}
        </div>`).join('')}</div>`
        : '<div class="in-hint">No badges yet. Type the code the badge is showing, above.</div>'}

      ${modeSwitch()}`;
  }

  // Fetch a stored tune back and open it as a project (§6.5). The transfer
  // resolves raw bytes; parseTune inside openImportedTune is the integrity
  // gate, since the file carries its own CRC.
  function fetchTune(badgeId, tuneId) {
    if (fetches.has(badgeId) || !openImportedTune) return;
    const transfer = createFetch({
      send: (m) => ensureClient().send(m),
      badgeId,
      tuneId,
    });
    fetches.set(badgeId, transfer);
    state.error = null;
    transfer.start().then(
      (bytes) => {
        fetches.delete(badgeId);
        try {
          openImportedTune(bytes);
        } catch (err) {
          state.error = `That tune did not survive the trip: ${err.message}`;
          render();
        }
      },
      (err) => {
        fetches.delete(badgeId);
        state.error = err.reason === 'unknown'
          ? 'The badge no longer holds that tune.'
          : err.reason === 'busy'
            ? 'The badge is busy - try again shortly.'
            : `Fetch failed (${err.reason || 'unknown'}).`;
        render();
      }
    );
  }

  // Live vs scheduled. Measured over a real Funnel, live costs 50 ms of onset
  // error against scheduled's 0.3 ms - so scheduled is the default and this
  // exists because on a LAN the gap narrows, and because a badge that has not
  // implemented `sched` needs a way to be driven at all.
  function modeSwitch() {
    if (!badgeStream) return '';
    const mode = badgeStream.getMode();
    const anySched = state.badges.some((b) => badgeCan(b, 'sched'));
    return `
      <div class="bg-mode">
        <div class="fx-param">
          <label>Live playback</label>
          <select data-act="mode">
            <option value="sched"${mode === 'sched' ? ' selected' : ''}>Scheduled (accurate)</option>
            <option value="live"${mode === 'live' ? ' selected' : ''}>Live (simple)</option>
          </select>
        </div>
        <div class="in-hint">${mode === 'sched'
          ? (anySched
            ? 'Notes are sent ahead with timestamps and played from the badge’s own clock. ~0.3 ms onset error over the internet.'
            : 'No connected badge advertises <b>sched</b> — switch to Live, or they will stay silent.')
          : 'Each note is sent as it plays. Simple, but every network hiccup is audible — ~50 ms over the internet.'}</div>
      </div>`;
  }

  // What a badge is holding, and how to put something there. Hidden entirely
  // for a badge that never advertised `store`: a control that silently does
  // nothing is worse than an absent one.
  function library(b) {
    if (!badgeCan(b, 'store')) return '';
    const up = uploads.get(b.id);
    if (up) {
      const pct = up.chunks ? Math.round((up.acked / up.chunks) * 100) : 0;
      return `
        <div class="bg-lib">
          <div class="lv-out-head">Sending ${up.name || ''}
            <span class="lv-mode">${pct}%</span></div>
          <div class="bg-bar"><i style="width:${pct}%"></i></div>
          <button class="btn-link" data-act="cancel-put">Cancel</button>
        </div>`;
    }

    const lib = b.lib;
    return `
      <div class="bg-lib">
        <div class="lv-out-head">On the badge${lib
          ? ` <span class="lv-mode">${formatBytes(lib.freeBytes)} free</span>` : ''}</div>
        ${lib
          ? (lib.tunes.length
            ? `<div class="bg-tunes">${lib.tunes.map((t) => `
                <div class="bg-tune" data-tune="${t.id}">
                  <b>${t.name || t.id}</b>
                  <span class="lv-mode">${t.tracks} trk · ${formatMs(t.ms)} · ${formatBytes(t.bytes)}</span>
                  ${badgeCan(b, 'fetch') && openImportedTune ? `<button class="btn-icon" data-act="get-tune"
                    title="Fetch and open in the editor - a converted performance, not the original project">${icon('music')}</button>` : ''}
                  <button class="btn-icon" data-act="drop-tune" title="Delete from the badge">${icon('trash')}</button>
                </div>`).join('')}</div>`
            : '<div class="in-hint">Nothing stored yet.</div>')
          : '<div class="in-hint">Library not read yet.</div>'}
        <div class="harm-row">
          <button class="btn" data-act="put">Send this song</button>
        </div>
        <div class="in-hint">Sends every track - the badge picks its part.
          Stored tunes play with no server and no network.</div>
      </div>`;
  }

  // The countdown is the only thing that changes without an event, so it gets
  // its own cheap timer rather than re-rendering the whole card every second.
  function startTick() {
    clearInterval(tick);
    tick = setInterval(() => {
      const el = body.querySelector('#bg-countdown');
      if (!el) return;
      if (!state.code || state.code.expires <= Date.now()) {
        render();
        return;
      }
      el.textContent = countdown(state.code.expires);
    }, 500);
  }

  // The SHARED client - the transport streams through the same one, so a badge
  // adopted here is a badge the player can actually address.
  function ensureClient() {
    if (!client) {
      client = getBadgeClient();
      unsubscribe = onBadgeChange(render);
      // Upload acks are addressed to one transfer, not to the UI at large, so
      // they are routed to the transfer that owns them and only the progress
      // number reaches the card.
      unsubscribeFrames = onBadgeFrame((msg) => {
        for (const up of uploads.values()) up.transfer.handle(msg);
        for (const f of fetches.values()) f.handle(msg);
      });
    }
    return client;
  }

  // Send the current song - every track of it - to a badge. The badge picks
  // the part it plays; per-track transfers used to be offered here and were
  // removed, because nobody wants a tune with the other parts missing.
  //
  // Refuses up front when it cannot fit. The badge would refuse too, but only
  // after the announcement round trip, and "it does not fit" is a better thing
  // to learn before a progress bar appears than during one.
  async function sendTune(badgeId) {
    let b = state.badges.find((x) => x.id === badgeId);
    if (!b || uploads.has(badgeId)) return;
    const doc = store.getDoc();
    let built;
    try {
      built = buildTune(doc, { name: doc.name });
    } catch (err) {
      state.error = err.message;
      render();
      return;
    }
    // Sending the same song again REPLACES the copy on the badge: same name,
    // different id means the old versions are dropped once the new one has
    // committed. Same id means the exact bytes are already there.
    let plan = replacePlan(b.lib, { id: built.id, name: doc.name, bytes: built.bytes.length });
    if (plan.upload && plan.dropFirst.length + plan.dropAfter.length > 0) {
      // Ask before replacing, because a shared name is not proof of an update:
      // every fresh project is called "Untitled", and two unrelated songs with
      // that name would otherwise silently destroy each other on the badge.
      // Only the person pressing Send knows which of the two cases this is -
      // same precedent as overwriting a named arp preset.
      const go = await confirmDialog(
        'Replace tune',
        `“${doc.name}” is already on ${b.name}. Send the current version in its place? Rename the project if you want to keep both.`,
        'Replace'
      );
      if (!go) return;
      // The library can change while the dialog is open - a lib push, another
      // upload finishing - so what was decided from is re-decided, not reused.
      b = state.badges.find((x) => x.id === badgeId);
      if (!b || uploads.has(badgeId)) return;
      plan = replacePlan(b.lib, { id: built.id, name: doc.name, bytes: built.bytes.length });
    }
    if (!plan.upload) {
      state.error = null;
      ensureClient().askLibrary(badgeId);
      render();
      return;
    }
    // Space is judged with the about-to-be-dropped copies credited back - but
    // the refusal happens BEFORE any drop is sent, so a tune that will not fit
    // even after the replacement costs nothing that was already stored.
    const credit = plan.dropFirst.reduce(
      (n, tid) => n + ((b.lib.tunes.find((t) => t.id === tid) || {}).bytes || 0), 0);
    const free = b.lib ? b.lib.freeBytes + credit : Infinity;
    if (built.bytes.length > free) {
      state.error = `“${doc.name}” needs ${formatBytes(built.bytes.length)} but only ${formatBytes(free)} is free on ${b.name}.`;
      render();
      return;
    }
    for (const tid of plan.dropFirst) ensureClient().dropTune(badgeId, tid);

    const entry = {
      name: doc.name, acked: 0, chunks: 0,
      transfer: createUpload({
        send: (msg) => ensureClient().send(msg),
        badgeId,
        tune: { bytes: built.bytes, id: built.id, name: doc.name, tracks: built.tracks.length },
        onProgress: (p) => {
          entry.acked = p.acked;
          entry.chunks = p.chunks;
          render();
        },
      }),
    };
    uploads.set(badgeId, entry);
    state.error = null;
    entry.transfer.start().then(
      () => {
        uploads.delete(badgeId);
        // The new version is committed, so the stale same-named copies can go.
        for (const tid of plan.dropAfter) ensureClient().dropTune(badgeId, tid);
        // The badge sends a fresh `lib` on its own after a commit; ask anyway,
        // so a firmware that forgets still leaves the card correct.
        ensureClient().askLibrary(badgeId);
        render();
      },
      (err) => {
        uploads.delete(badgeId);
        state.error = err.reason === 'space'
          ? `${b.name} is full.`
          : err.reason === 'crc'
            ? `${b.name} received a damaged copy — try again.`
            : err.reason === 'offline'
              ? `${b.name} is not connected.`
              : `Upload to ${b.name} failed (${err.reason || 'unknown'}).`;
        render();
      }
    );
    render();
  }

  body.addEventListener('click', (e) => {
    if (e.target.closest('#bg-connect')) {
      const c = ensureClient();
      if (state.connected) c.disconnect();
      else c.connect(body.querySelector('#bg-url').value.trim());
      return;
    }
    if (e.target.closest('#bg-pair')) {
      ensureClient().requestCode();
      return;
    }
    if (e.target.closest('#bg-adopt')) {
      const input = body.querySelector('#bg-adopt-code');
      const code = input.value.trim();
      if (code) ensureClient().adopt(code);
      input.value = '';
      return;
    }
    const getTune = e.target.closest('[data-act="get-tune"]');
    if (getTune) {
      const badgeId = getTune.closest('[data-id]').dataset.id;
      const tuneId = getTune.closest('[data-tune]').dataset.tune;
      fetchTune(badgeId, tuneId);
      return;
    }
    const forget = e.target.closest('[data-act="forget"]');
    if (forget) {
      const id = forget.closest('[data-id]').dataset.id;
      ensureClient().forget(id);
      return;
    }
    const put = e.target.closest('[data-act="put"]');
    if (put) {
      sendTune(put.closest('[data-id]').dataset.id);
      return;
    }
    const cancel = e.target.closest('[data-act="cancel-put"]');
    if (cancel) {
      const id = cancel.closest('[data-id]').dataset.id;
      const up = uploads.get(id);
      if (up) up.transfer.cancel();
      return;
    }
    const drop = e.target.closest('[data-act="drop-tune"]');
    if (drop) {
      const id = drop.closest('[data-id]').dataset.id;
      const tuneId = drop.closest('[data-tune]').dataset.tune;
      ensureClient().dropTune(id, tuneId);
    }
  });

  body.addEventListener('keydown', (e) => {
    if (e.target.id !== 'bg-adopt-code' || e.key !== 'Enter') return;
    e.preventDefault();
    const code = e.target.value.trim();
    if (code) ensureClient().adopt(code);
    e.target.value = '';
  });

  body.addEventListener('change', (e) => {
    const mode = e.target.closest('[data-act="mode"]');
    if (mode) {
      if (badgeStream) badgeStream.setMode(mode.value);
      render();
      return;
    }
    const sel = e.target.closest('[data-act="map"]');
    if (!sel) return;
    const id = sel.closest('[data-id]').dataset.id;
    ensureClient().map(id, sel.value || null);
  });

  // Renaming reuses the double-click affordance tracks already have, so there
  // is one gesture for "give this thing a name" in the whole app.
  body.addEventListener('dblclick', (e) => {
    const nameEl = e.target.closest('.bg-name');
    if (!nameEl) return;
    const id = nameEl.closest('[data-id]').dataset.id;
    const next = prompt('Name for this badge', nameEl.textContent.trim());
    if (next != null) ensureClient().rename(id, next.trim());
  });

  // Re-render when tracks change: the per-badge selector lists them.
  store.subscribe(['tracks', 'doc'], render);

  render();
  startTick();

  // Opening the card is the opt-in. Reconnecting after that is convenience,
  // not a surprise: it only happens if a previous connection succeeded here.
  if (shouldAutoConnect() && savedUrl()) ensureClient().connect(savedUrl());
}
