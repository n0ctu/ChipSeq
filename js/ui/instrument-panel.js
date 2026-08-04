// Instrument section of the tools sidebar (poly mode). Appears once a
// track's instrument picker was used; edits produce a per-track "Custom"
// config which can be saved as a project-wide preset.

import { getTrack, uid } from '../core/doc.js';
import { promptDialog } from './dialogs.js';
import { initSectionFold, updateEmptyHint } from './sections.js';

const WAVES = [
  ['square', 'Square'],
  ['sine', 'Sine'],
  ['sawtooth', 'Saw'],
  ['triangle', 'Tri'],
  ['custom', 'PWM'],
];

export function initInstrumentPanel({ store, uiStore, engine }) {
  const section = document.getElementById('sec-instrument');
  const body = document.getElementById('instrument-body');
  const ctxLabel = section.querySelector('.tool-ctx');
  const ui = uiStore.state;

  function target() {
    const doc = store.getDoc();
    if (doc.mode !== 'poly' || !ui.instrumentTrackId) return null;
    return getTrack(doc, ui.instrumentTrackId);
  }

  function effective(doc, track) {
    return (
      track.instrument ||
      doc.instruments.find((i) => i.id === track.instrumentId) ||
      doc.instruments[0]
    );
  }

  // Any edit turns the track's instrument into an inline Custom config.
  function applyPatch(patch) {
    const trackId = ui.instrumentTrackId;
    store.commit('edit instrument', ['tracks'], (doc) => {
      const t = getTrack(doc, trackId);
      if (!t) return;
      const base = structuredClone(effective(doc, t));
      t.instrument = { ...base, ...patch, id: 'track:' + trackId, name: 'Custom' };
    });
  }

  function audition() {
    const track = target();
    if (!track) return;
    engine.previewNote(69, track.instrument ? 'track:' + track.id : track.instrumentId);
  }

  const fmtS = (v) => (v >= 0.1 ? v.toFixed(2) + ' s' : Math.round(v * 1000) + ' ms');

  function render() {
    const doc = store.getDoc();
    const track = target();
    section.hidden = !track;
    updateEmptyHint();
    if (!track) return;

    const inst = effective(doc, track);
    const isCustom = !!track.instrument;
    ctxLabel.textContent = `“${track.name}” · ${isCustom ? 'Custom' : inst.name}`;
    const duty = inst.duty ?? 0.25;

    body.innerHTML = `
      <div class="harm-field">Wave
        <div class="seg seg-wrap" id="in-wave">
          ${WAVES.map(([id, label]) => `<button class="seg-btn ${inst.wave === id ? 'active' : ''}" data-v="${id}">${label}</button>`).join('')}
        </div>
      </div>
      ${inst.wave === 'custom' ? `
      <div class="harm-field">Duty cycle <span id="in-duty-label">${Math.round(duty * 100)}%</span>
        <div class="harm-row"><input type="range" id="in-duty" min="5" max="50" step="1" value="${Math.round(duty * 100)}" /></div>
      </div>` : ''}
      <div class="harm-field">Attack <span>${fmtS(inst.adsr.a)}</span>
        <div class="harm-row"><input type="range" id="in-a" min="0" max="300" step="1" value="${Math.round(inst.adsr.a * 1000)}" /></div>
      </div>
      <div class="harm-field">Decay <span>${fmtS(inst.adsr.d)}</span>
        <div class="harm-row"><input type="range" id="in-d" min="0" max="500" step="5" value="${Math.round(inst.adsr.d * 1000)}" /></div>
      </div>
      <div class="harm-field">Sustain <span>${Math.round(inst.adsr.s * 100)}%</span>
        <div class="harm-row"><input type="range" id="in-s" min="0" max="100" step="1" value="${Math.round(inst.adsr.s * 100)}" /></div>
      </div>
      <div class="harm-field">Release <span>${fmtS(inst.adsr.r)}</span>
        <div class="harm-row"><input type="range" id="in-r" min="0" max="800" step="5" value="${Math.round(inst.adsr.r * 1000)}" /></div>
      </div>
      <div class="harm-field">Gain <span>${Math.round(inst.gain * 100)}%</span>
        <div class="harm-row"><input type="range" id="in-gain" min="5" max="100" step="1" value="${Math.round(inst.gain * 100)}" /></div>
      </div>
      <div class="btn-pair">
        <button class="btn" id="in-audition">Audition</button>
        <button class="btn" id="in-save" ${isCustom ? '' : 'disabled'} title="${isCustom ? 'Save as a preset for all tracks of this project' : 'Modify a parameter first'}">Save as preset…</button>
      </div>`;

    body.querySelector('#in-wave').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-v]');
      if (!btn) return;
      const wave = btn.dataset.v;
      applyPatch(wave === 'custom' ? { wave, duty: inst.duty ?? 0.25, harmonics: null } : { wave, duty: null, harmonics: null });
      audition();
    });

    const slider = (id, toPatch) => {
      const el = body.querySelector('#' + id);
      if (!el) return;
      el.addEventListener('change', () => {
        applyPatch(toPatch(Number(el.value)));
        audition();
      });
    };
    slider('in-duty', (v) => ({ duty: v / 100 }));
    slider('in-a', (v) => ({ adsr: { ...inst.adsr, a: v / 1000 } }));
    slider('in-d', (v) => ({ adsr: { ...inst.adsr, d: v / 1000 } }));
    slider('in-s', (v) => ({ adsr: { ...inst.adsr, s: v / 100 } }));
    slider('in-r', (v) => ({ adsr: { ...inst.adsr, r: v / 1000 } }));
    slider('in-gain', (v) => ({ gain: v / 100 }));

    body.querySelector('#in-audition').addEventListener('click', audition);

    body.querySelector('#in-save').addEventListener('click', async () => {
      const trackId = ui.instrumentTrackId;
      const name = await promptDialog('Preset name', '');
      if (!name) return;
      store.commit('save instrument preset', ['tracks'], (doc2) => {
        const t = getTrack(doc2, trackId);
        if (!t || !t.instrument) return;
        const preset = { ...structuredClone(t.instrument), id: uid(), name };
        doc2.instruments.push(preset);
        t.instrumentId = preset.id;
        t.instrument = null;
      });
    });
  }

  // Called by the tracks panel when an instrument picker is used.
  function openFor(trackId) {
    uiStore.update('instrument', (s) => {
      s.instrumentTrackId = trackId;
    });
    section.classList.remove('folded');
  }

  store.subscribe(['tracks', 'song', 'doc'], render);
  uiStore.subscribe(['instrument'], render);
  initSectionFold(section, 'instrument');
  render();
  return { openFor };
}
