// Instrument card in the tools sidebar (poly mode). Always present, editing
// the active track; edits produce a per-track "Custom" config which can be
// saved as a project-wide preset.
//
// The Audition button is a TOGGLE: while on, a reference note repeats and
// always plays the current values - slider drags are audible live via a
// transient patch that only becomes an undoable commit on release.

import { getTrack, activeTrack, uid, defaultGainForWave } from '../../core/doc.js';
import { promptDialog } from '../dialogs.js';
import { formatPercent, formatSeconds, isHot } from '../../core/units.js';
import { envToAdsr, isAdsrShaped, effectiveEnvelope } from '../../core/modulation.js';
import { initEnvelopeEditor } from './envelope-editor.js';

const WAVES = [
  ['square', 'Square'],
  ['sine', 'Sine'],
  ['sawtooth', 'Saw'],
  ['triangle', 'Tri'],
  ['custom', 'PWM'],
];

// Mounted by tools-panel.js on first expand; the manifest owns the header.
// Edits the ACTIVE track, so the card always shows the instrument of whatever
// you are working on - the tracks panel's picker switches the active track
// and asks the panel to reveal this card.
export function mount(body, { store, uiStore, engine }) {
  const ui = uiStore.state;

  // Uncommitted values while a slider is being dragged.
  let livePatch = null;

  function target() {
    const doc = store.getDoc();
    if (doc.mode !== 'poly') return null;
    return activeTrack(doc);
  }

  function effective(doc, track) {
    return (
      track.instrument ||
      doc.instruments.find((i) => i.id === track.instrumentId) ||
      doc.instruments[0]
    );
  }

  // What the audition loop plays: committed config + any in-drag values.
  function liveInstrument() {
    const track = target();
    if (!track) return null;
    return { ...effective(store.getDoc(), track), ...(livePatch || {}) };
  }

  // Any edit turns the track's instrument into an inline Custom config.
  function applyPatch(patch) {
    const trackId = store.getDoc().activeTrackId;
    livePatch = null;
    store.commit('edit instrument', ['tracks'], (doc) => {
      const t = getTrack(doc, trackId);
      if (!t) return;
      const base = structuredClone(effective(doc, t));
      t.instrument = { ...base, ...patch, id: 'track:' + trackId, name: 'Custom' };
    });
  }

  // Store the cheapest representation that is faithful: four numbers while
  // the shape is ADSR, an explicit envelope block once it is not. Keeps
  // ordinary projects free of a field they do not need, and means "reset to
  // ADSR" is just clearing it.
  function envPatch(env) {
    const adsr = envToAdsr(env);
    return adsr ? { adsr, env: null } : { env };
  }

  function auditionOnce() {
    if (engine.isAuditioning()) return; // the loop already plays the latest values
    const track = target();
    if (!track) return;
    engine.previewNote(69, track.instrument ? 'track:' + track.id : track.instrumentId);
  }

  function setAuditionLoop(on) {
    engine.setAudition(on ? liveInstrument : null);
    const btn = body.querySelector('#in-audition');
    if (btn) btn.classList.toggle('active', engine.isAuditioning());
  }

  const fmtS = formatSeconds; // same formatter the automation lanes use

  function render() {
    const doc = store.getDoc();
    const track = target();
    if (!track) {
      livePatch = null;
      if (engine.isAuditioning()) engine.setAudition(null);
      return;
    }

    const inst = effective(doc, track);
    const isCustom = !!track.instrument;
    const duty = inst.duty ?? 0.25;
    // One shape, two ways to edit it. While it is still ADSR-shaped the
    // sliders drive it; once it is drawn into something they cannot express,
    // they grey out rather than silently rounding the curve back to four
    // numbers.
    const env = effectiveEnvelope(inst);
    const adsrView = envToAdsr(env) || { a: 0, d: 0, s: 1, r: 0 };
    const drawn = !isAdsrShaped(env);
    // Read from the built-in presets, not the document: a project whose stored
    // gains have drifted still resets to the level the wave was calibrated at.
    const gainDefault = defaultGainForWave(inst.wave);
    // The reset link and its explanation appear only when there is something
    // to reset - at the calibrated level they would be noise on every track.
    const gainDrifted = Math.abs(inst.gain - gainDefault) > 1e-9;

    body.innerHTML = `
      <div class="harm-field">Wave
        <div class="seg seg-wrap" id="in-wave">
          ${WAVES.map(([id, label]) => `<button class="seg-btn ${inst.wave === id ? 'active' : ''}" data-v="${id}">${label}</button>`).join('')}
        </div>
      </div>
      ${inst.wave === 'custom' ? `
      <div class="harm-field">Duty cycle <span id="in-duty-label">${formatPercent(duty)}</span>
        <div class="harm-row"><input type="range" id="in-duty" min="5" max="50" step="1" value="${Math.round(duty * 100)}" /></div>
      </div>` : ''}
      <div class="harm-field">Envelope
        <span class="tool-ctx" id="in-env-mode">${drawn ? 'drawn' : 'ADSR'}</span>
        <canvas id="in-env" class="env-canvas" title="Drag a point to shape the envelope; double-click the curve to add one, right-click a point to remove it"></canvas>
        ${drawn ? '<button class="btn" id="in-env-reset">Reset to ADSR</button>' : ''}
      </div>
      <div class="harm-field${drawn ? ' disabled' : ''}">Attack <span id="in-a-label">${fmtS(adsrView.a)}</span>
        <div class="harm-row"><input type="range" id="in-a" min="0" max="300" step="1" value="${Math.round(adsrView.a * 1000)}" /></div>
      </div>
      <div class="harm-field${drawn ? ' disabled' : ''}">Decay <span id="in-d-label">${fmtS(adsrView.d)}</span>
        <div class="harm-row"><input type="range" id="in-d" min="0" max="500" step="5" value="${Math.round(adsrView.d * 1000)}" /></div>
      </div>
      <div class="harm-field${drawn ? ' disabled' : ''}">Sustain <span id="in-s-label">${formatPercent(adsrView.s)}</span>
        <div class="harm-row"><input type="range" id="in-s" min="0" max="100" step="1" value="${Math.round(adsrView.s * 100)}" /></div>
      </div>
      <div class="harm-field${drawn ? ' disabled' : ''}">Release <span id="in-r-label">${fmtS(adsrView.r)}</span>
        <div class="harm-row"><input type="range" id="in-r" min="0" max="800" step="5" value="${Math.round(adsrView.r * 1000)}" /></div>
      </div>
      <div class="harm-field">
        <div class="harm-caption">Gain <span id="in-gain-label" class="${isHot(inst.gain) ? 'hot' : ''}">${formatPercent(inst.gain)}</span>${
          gainDrifted ? `<button class="btn-link" id="in-gain-reset"
            title="Back to the calibrated level for a ${inst.wave} wave (${formatPercent(gainDefault)})">reset to default</button>` : ''}</div>
        <div class="harm-row"><input type="range" id="in-gain" min="5" max="150" step="1" value="${Math.round(inst.gain * 100)}"
          title="The instrument's own level, part of how it sounds. To balance this track against the others, use the Mixer's Gain instead. 100% is unity - above that the master limiter starts working." /></div>${
        gainDrifted ? `
        <div class="in-hint">This instrument sits away from the level its wave is
          calibrated at (${formatPercent(gainDefault)}). To balance the track in the mix,
          reach for the <b>Mixer</b> instead.</div>` : ''}
      </div>
      <div class="btn-pair">
        <button class="btn btn-toggle ${engine.isAuditioning() ? 'active' : ''}" id="in-audition"
          title="Loop a reference note - parameter changes are heard live">Audition</button>
        <button class="btn" id="in-save" ${isCustom ? '' : 'disabled'} title="${isCustom ? 'Save as a preset for all tracks of this project' : 'Modify a parameter first'}">Save as preset…</button>
      </div>`;

    // The envelope canvas edits the same shape the sliders do. Dragging feeds
    // a live patch (audible through the audition loop, no undo entries) and
    // only the release commits, exactly like the sliders.
    const envCanvas = body.querySelector('#in-env');
    if (envCanvas) {
      let liveEnv = env;
      initEnvelopeEditor(envCanvas, {
        getEnv: () => liveEnv,
        onChange: (next) => {
          liveEnv = next;
          livePatch = { ...(livePatch || {}), ...envPatch(next) };
          const mode = body.querySelector('#in-env-mode');
          if (mode) mode.textContent = isAdsrShaped(next) ? 'ADSR' : 'drawn';
        },
        onCommit: (next) => applyPatch(envPatch(next)),
      });
    }
    const resetEnv = body.querySelector('#in-env-reset');
    if (resetEnv) {
      resetEnv.addEventListener('click', () => {
        // Just drop the block. envPatch() never overwrites `adsr` while a
        // drawn shape is in force, so the four numbers from before the
        // drawing are still there waiting - resetting must restore those,
        // not the zeros a non-ADSR shape reads back as.
        applyPatch({ env: null });
      });
    }

    body.querySelector('#in-wave').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-v]');
      if (!btn) return;
      const wave = btn.dataset.v;
      applyPatch(wave === 'custom' ? { wave, duty: inst.duty ?? 0.25, harmonics: null } : { wave, duty: null, harmonics: null });
      auditionOnce();
    });

    // Sliders: 'input' updates the live patch + label (audible via the
    // audition loop, no undo entries); 'change' commits once on release.
    // isHotAt: optional - flags a slider value that pushes past unity, so a
    // boosted gain reads as deliberate rather than as a number that happens
    // to be large.
    const slider = (id, toPatch, toLabel, isHotAt = null) => {
      const el = body.querySelector('#' + id);
      if (!el) return;
      const label = body.querySelector('#' + id + '-label');
      el.addEventListener('input', () => {
        livePatch = { ...(livePatch || {}), ...toPatch(Number(el.value)) };
        if (label) {
          label.textContent = toLabel(Number(el.value));
          if (isHotAt) label.classList.toggle('hot', isHotAt(Number(el.value)));
        }
      });
      el.addEventListener('change', () => {
        applyPatch(toPatch(Number(el.value)));
        auditionOnce();
      });
    };
    slider('in-duty', (v) => ({ duty: v / 100 }), (v) => formatPercent(v / 100));
    slider('in-a', (v) => ({ adsr: { ...inst.adsr, a: v / 1000 } }), (v) => fmtS(v / 1000));
    slider('in-d', (v) => ({ adsr: { ...inst.adsr, d: v / 1000 } }), (v) => fmtS(v / 1000));
    slider('in-s', (v) => ({ adsr: { ...inst.adsr, s: v / 100 } }), (v) => formatPercent(v / 100));
    slider('in-r', (v) => ({ adsr: { ...inst.adsr, r: v / 1000 } }), (v) => fmtS(v / 1000));
    slider('in-gain', (v) => ({ gain: v / 100 }), (v) => formatPercent(v / 100), (v) => isHot(v / 100));

    const resetBtn = body.querySelector('#in-gain-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        applyPatch({ gain: gainDefault });
        auditionOnce();
      });
    }

    body.querySelector('#in-audition').addEventListener('click', () => {
      setAuditionLoop(!engine.isAuditioning());
    });

    body.querySelector('#in-save').addEventListener('click', async () => {
      const trackId = store.getDoc().activeTrackId;
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
  store.subscribe(['tracks', 'song', 'doc'], render);
  render();
}
