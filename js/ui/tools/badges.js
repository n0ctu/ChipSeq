// Badges card: connect to a badge server, adopt badges, map them to tracks.
//
// The pairing code is shown as the buttons you actually press, not as letters
// - the badge has a d-pad, so "↑ → ↓ ← A B" is the instruction and "URDLAB" is
// only how it travels over the wire.

import { createBadgeClient, badgeState, savedUrl, shouldAutoConnect } from '../../net/badges.js';
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
  let tick = null;

  const state = badgeState();

  function render() {
    const doc = store.getDoc();
    const s = state;

    const connectRow = `
      <div class="harm-row">
        <input type="text" id="bg-url" spellcheck="false" value="${s.url || savedUrl()}"
          placeholder="wss://box.tailnet.ts.net/ws"
          title="The badge server. Served from the server itself, this is filled in already." />
        <button class="btn" id="bg-connect">${s.connected ? 'Disconnect' : 'Connect'}</button>
      </div>`;

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

      ${pairing ? `
        <div class="bg-code">
          <div class="bg-code-glyphs">${showCode(s.code.code)}</div>
          <div class="in-hint">Enter this on the badge · expires in
            <b id="bg-countdown">${countdown(s.code.expires)}</b></div>
        </div>`
        : '<button class="btn" id="bg-pair">Pair a badge</button>'}

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
        : '<div class="in-hint">No badges yet. Press <b>Pair a badge</b> and enter the code on it.</div>'}`;
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

  function ensureClient() {
    if (!client) client = createBadgeClient({ onChange: render });
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
    const forget = e.target.closest('[data-act="forget"]');
    if (forget) {
      const id = forget.closest('[data-id]').dataset.id;
      ensureClient().forget(id);
    }
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
