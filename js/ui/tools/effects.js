// Effects card: buses, their chains, and the active track's send to one.
//
// The document supports a full send matrix (track.sends is an array); this
// edits one send at a time, for the track you are on. That is the common case
// by a wide margin, and the schema does not have to change when the matrix UI
// arrives.

import { getTrack, activeTrack, buses, createBus, trackSends, setSend } from '../../core/doc.js';
import { EFFECTS, EFFECT_KINDS, DEFAULT_EFFECTS } from '../../core/effects.js';
import { formatPercent } from '../../core/units.js';
import { icon } from '../icons.js';

// Which params each kind exposes, and how. Adding an effect means one entry
// here and one builder in core/effects.js - nothing else knows the list.
const PARAMS = {
  delay: [
    { key: 'timeTicks', label: 'Time', type: 'choice', options: [[24, '1/16'], [48, '1/8'], [96, '1/4'], [192, '1/2']] },
    { key: 'feedback', label: 'Feedback', type: 'percent', min: 0, max: 95 },
  ],
  filter: [
    { key: 'type', label: 'Type', type: 'choice', options: [['lowpass', 'Low'], ['highpass', 'High'], ['bandpass', 'Band'], ['notch', 'Notch']] },
    { key: 'freq', label: 'Freq', type: 'range', min: 100, max: 12000, step: 100, unit: ' Hz' },
    { key: 'q', label: 'Q', type: 'range', min: 1, max: 200, step: 1, scale: 0.1 },
  ],
  reverb: [
    { key: 'seconds', label: 'Size', type: 'range', min: 1, max: 60, step: 1, scale: 0.1, unit: ' s' },
    { key: 'decay', label: 'Decay', type: 'range', min: 5, max: 80, step: 1, scale: 0.1 },
  ],
};

export function mount(body, { store }) {
  let selectedBusId = null;

  const doc = () => store.getDoc();
  const selected = () => {
    const list = buses(doc());
    return list.find((b) => b.id === selectedBusId) || list[0] || null;
  };

  function paramControl(spec, i, p) {
    const raw = (spec.params || {})[p.key] ?? DEFAULT_EFFECTS[spec.kind].params[p.key];
    if (p.type === 'choice') {
      return `<label class="fx-param">${p.label}
        <select data-fx="${i}" data-k="${p.key}">
          ${p.options.map(([v, l]) => `<option value="${v}"${String(raw) === String(v) ? ' selected' : ''}>${l}</option>`).join('')}
        </select></label>`;
    }
    if (p.type === 'percent') {
      return `<label class="fx-param">${p.label}
        <input type="range" data-fx="${i}" data-k="${p.key}" data-scale="0.01"
          min="${p.min}" max="${p.max}" step="1" value="${Math.round(raw * 100)}" />
        <span class="mix-val">${formatPercent(raw)}</span></label>`;
    }
    const scale = p.scale || 1;
    return `<label class="fx-param">${p.label}
      <input type="range" data-fx="${i}" data-k="${p.key}" data-scale="${scale}"
        min="${p.min}" max="${p.max}" step="${p.step}" value="${Math.round(raw / scale)}" />
      <span class="mix-val">${Math.round(raw / scale) * scale}${p.unit || ''}</span></label>`;
  }

  function render() {
    const d = doc();
    const list = buses(d);
    const bus = selected();
    const track = activeTrack(d);

    if (!list.length) {
      body.innerHTML = `
        <div class="in-hint">A bus is a shared effect: tracks send some of their
          signal to it and the result is mixed back in. One reverb for six tracks
          is one reverb, not six.</div>
        <button class="btn" id="fx-add-bus">Add a bus</button>`;
      return;
    }

    selectedBusId = bus.id;
    const send = track ? (trackSends(d, track).find((s) => s.busId === bus.id) || { level: 0 }) : { level: 0 };
    const chain = Array.isArray(bus.chain) ? bus.chain : [];

    body.innerHTML = `
      <div class="harm-row">
        <select id="fx-bus">
          ${list.map((b) => `<option value="${b.id}"${b.id === bus.id ? ' selected' : ''}>${b.name}</option>`).join('')}
        </select>
        <button class="btn btn-icon" id="fx-add-bus" title="Add another bus">+</button>
        <button class="btn btn-icon" id="fx-del-bus" title="Delete this bus and every send to it">${icon('trash')}</button>
      </div>

      ${track ? `
      <div class="harm-field">
        <div class="harm-caption">Send from “${track.name}” <span class="mix-val" id="fx-send-label">${formatPercent(send.level)}</span></div>
        <div class="harm-row"><input type="range" id="fx-send" min="0" max="150" step="1" value="${Math.round(send.level * 100)}"
          title="How much of this track is fed to the bus. The track's own fader moves this with it." /></div>
      </div>` : ''}

      <div class="fx-chain">
        ${chain.length ? chain.map((spec, i) => `
          <div class="fx-item" data-i="${i}">
            <div class="harm-caption"><b>${EFFECTS[spec.kind] ? EFFECTS[spec.kind].name : spec.kind}</b>
              ${EFFECTS[spec.kind] ? '' : '<span class="mix-val">not in this build</span>'}
              <button class="btn-icon" data-del="${i}" title="Remove">${icon('trash')}</button></div>
            ${(PARAMS[spec.kind] || []).map((p) => paramControl(spec, i, p)).join('')}
          </div>`).join('')
          : '<div class="in-hint">This bus is empty - anything sent to it comes back unchanged.</div>'}
      </div>

      <div class="harm-row">
        <select id="fx-add-kind">
          ${EFFECT_KINDS.map((k) => `<option value="${k}">${EFFECTS[k].name}</option>`).join('')}
        </select>
        <button class="btn" id="fx-add">Add effect</button>
      </div>`;
  }

  // Every edit goes through the store, so undo covers effects like everything
  // else and the engine rebuilds its routing off the same subscription.
  const editBus = (label, fn) => store.commit(label, ['tracks', 'doc'], (d) => {
    const bus = (d.buses || []).find((b) => b.id === selectedBusId);
    if (bus) fn(bus, d);
  });

  body.addEventListener('click', (e) => {
    if (e.target.closest('#fx-add-bus')) {
      store.commit('add bus', ['tracks', 'doc'], (d) => {
        if (!Array.isArray(d.buses)) d.buses = [];
        const bus = createBus({ name: 'Bus ' + (d.buses.length + 1), chain: [structuredClone(DEFAULT_EFFECTS.reverb)] });
        d.buses.push(bus);
        selectedBusId = bus.id;
      });
      return;
    }
    if (e.target.closest('#fx-del-bus')) {
      const busId = selectedBusId;
      store.commit('delete bus', ['tracks', 'doc'], (d) => {
        d.buses = (d.buses || []).filter((b) => b.id !== busId);
        // Sends to it go too. A dangling send is preserved when the bus is
        // merely UNKNOWN to this build - it may belong to a newer one - but
        // deleting is a deliberate act, and leaving invisible sends behind
        // would mean a later bus with a recycled id came back haunted.
        for (const t of d.tracks) {
          if (!Array.isArray(t.sends)) continue;
          const kept = t.sends.filter((x) => x && x.busId !== busId);
          if (kept.length) t.sends = kept;
          else delete t.sends;
        }
        if (!d.buses.length) delete d.buses;
      });
      selectedBusId = null;
      return;
    }
    if (e.target.closest('#fx-add')) {
      const kind = body.querySelector('#fx-add-kind').value;
      editBus('add effect', (bus) => {
        if (!Array.isArray(bus.chain)) bus.chain = [];
        bus.chain.push(structuredClone(DEFAULT_EFFECTS[kind]));
      });
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      const i = Number(del.dataset.del);
      editBus('remove effect', (bus) => bus.chain.splice(i, 1));
    }
  });

  body.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'fx-bus') {
      selectedBusId = el.value;
      render();
      return;
    }
    if (el.id === 'fx-send') {
      const trackId = doc().activeTrackId;
      const busId = selectedBusId;
      store.commit('set send', ['tracks'], (d) => {
        const t = getTrack(d, trackId);
        if (t) setSend(t, busId, Number(el.value) / 100);
      });
      return;
    }
    if (el.dataset && el.dataset.fx !== undefined) {
      const i = Number(el.dataset.fx);
      const key = el.dataset.k;
      const scale = Number(el.dataset.scale || 1);
      const value = el.tagName === 'SELECT'
        ? (Number.isNaN(Number(el.value)) ? el.value : Number(el.value))
        : Number(el.value) * scale;
      editBus('set effect param', (bus) => {
        const spec = bus.chain[i];
        if (!spec) return;
        spec.params = { ...spec.params, [key]: value };
      });
    }
  });

  // Live readout while dragging; the commit lands on release.
  body.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'fx-send') {
      const label = body.querySelector('#fx-send-label');
      if (label) label.textContent = formatPercent(Number(el.value) / 100);
      return;
    }
    if (el.dataset && el.dataset.fx !== undefined && el.type === 'range') {
      const out = el.parentElement.querySelector('.mix-val');
      if (!out) return;
      const scale = Number(el.dataset.scale || 1);
      out.textContent = scale === 0.01
        ? formatPercent(Number(el.value) / 100)
        : String(Math.round(Number(el.value)) * scale) + (el.parentElement.textContent.includes('Hz') ? ' Hz' : '');
    }
  });

  store.subscribe(['tracks', 'doc', 'song'], render);
  render();
}
