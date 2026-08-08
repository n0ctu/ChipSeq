// Badges card: connect to a badge server, adopt badges, map them to tracks.
//
// The pairing code is shown as the buttons you actually press, not as letters
// - the badge has a d-pad, so "↑ → ↓ ← A B" is the instruction and "URDLAB" is
// only how it travels over the wire.

import { getBadgeClient, onBadgeChange, badgeState, savedUrl, shouldAutoConnect, isGuessedUrl } from '../../net/badges.js';
import { icon } from '../icons.js';

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

export function mount(body, { store }) {
  let client = null;
  let unsubscribe = null;
  let tick = null;

  const state = badgeState();

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

  function render() {
    withFocusPreserved(() => draw());
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
        </div>`).join('')}</div>`
        : '<div class="in-hint">No badges yet. Type the code the badge is showing, above.</div>'}`;
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
    }
    return client;
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
    const forget = e.target.closest('[data-act="forget"]');
    if (forget) {
      const id = forget.closest('[data-id]').dataset.id;
      ensureClient().forget(id);
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
