// Levels card: tune the polyphony normalization and see what it does.
//
// The whole point is that the right exponent is a taste decision and the
// right smoothing depends on how short the material's notes are - neither is
// something the app can decide for you. So every parameter is exposed, and
// the predicted peak is shown with and without normalization so a setting can
// be judged by number as well as by ear.

import { getTrack } from '../../core/doc.js';
import {
  makeupConfig, DEFAULT_MAKEUP, MAKEUP_TARGET_DB, MAKEUP_MIN_DB, MAKEUP_MAX_DB,
} from '../../core/graph.js';
import { renderWav } from '../../core/export-wav.js';
import { trackColorCss } from '../piano-roll/render.js';
import { flattenSong } from '../../core/flatten.js';
import { getInstrument } from '../../core/instruments.js';
import { ticksPerBar } from '../../core/doc.js';
import {
  DEFAULT_NORMALIZE, normalizeConfig, trackExempt, predictPeak,
} from '../../core/normalize.js';

const KNEE = 0.708; // where the master soft clipper starts shaping

export function mount(body, { store }) {
  let timer = null;

  // Flattening a big song twice is not something to do on every keystroke,
  // so the readout lags slightly behind the sliders rather than fighting them.
  function scheduleReadout() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(renderReadout, 250);
  }

  function patch(fn) {
    store.commit('set normalization', ['song', 'tracks'], (doc) => {
      doc.master = doc.master || {};
      doc.master.normalize = { ...normalizeConfig(doc), ...fn(normalizeConfig(doc)) };
    });
  }

  function renderReadout() {
    const el = body.querySelector('#lv-readout');
    if (!el) return;
    const doc = store.getDoc();
    if (doc.mode !== 'poly') return;
    const measure = (enabled) => {
      const probe = { ...doc, master: { ...(doc.master || {}), normalize: { ...normalizeConfig(doc), enabled } } };
      const events = flattenSong(probe).events;
      return predictPeak(probe, events, (ev) => getInstrument(probe, ev.instrumentId));
    };
    const off = measure(false);
    const on = measure(normalizeConfig(doc).enabled);
    const tpBar = ticksPerBar(doc);
    const bar = (t) => Math.floor(t / tpBar) + 1;
    const verdict = (p) => (p.peak > 1 ? 'over full scale' : p.peak > KNEE ? 'into the limiter' : 'clean');
    const cls = (p) => (p.peak > 1 ? 'hot' : p.peak > KNEE ? 'warm' : 'ok');
    el.innerHTML = `
      <div class="lv-row"><span>without</span>
        <b class="${cls(off)}">${off.peak.toFixed(2)}</b><span>${verdict(off)}</span></div>
      <div class="lv-row"><span>with</span>
        <b class="${cls(on)}">${on.peak.toFixed(2)}</b><span>${verdict(on)}</span></div>
      <div class="lv-note">loudest moment: bar ${bar(on.tick)}, ${on.voices} voice${on.voices === 1 ? '' : 's'}</div>`;
  }

  function render() {
    const doc = store.getDoc();
    const cfg = normalizeConfig(doc);
    const makeup = makeupConfig(doc);
    const slider = (id, label, value, max, step, fmt) => `
      <div class="mix-ctl">
        <label>${label}</label>
        <input type="range" data-k="${id}" min="0" max="${max}" step="${step}" value="${value}" />
        <span class="mix-val">${fmt}</span>
      </div>`;

    body.innerHTML = `
      <label class="tb-field"><input type="checkbox" id="lv-on" ${cfg.enabled ? 'checked' : ''} />
        <span>Normalize polyphony</span></label>
      ${slider('song', 'Song', Math.round(cfg.song * 100), 100, 5, cfg.song.toFixed(2))}
      ${slider('track', 'Track', Math.round(cfg.track * 100), 100, 5, cfg.track.toFixed(2))}
      ${slider('smoothMs', 'Smooth', cfg.smoothMs, 60, 1, cfg.smoothMs + ' ms')}
      <div class="lv-legend">0 = off (voices sum) &middot; 0.5 = equal power &middot; 1 = constant sum</div>

      <div class="harm-field">
        <div class="harm-caption">Make-up <span class="mix-val" id="lv-makeup-label">${
          makeup.db === 0 ? 'none' : (makeup.db > 0 ? '+' : '') + makeup.db.toFixed(1) + ' dB'}</span>${
          makeup.db !== 0 ? '<button class="btn-link" id="lv-makeup-reset" title="Back to no make-up">reset to default</button>' : ''}</div>
        <div class="harm-row">
          <input type="range" id="lv-makeup" min="${MAKEUP_MIN_DB * 10}" max="${MAKEUP_MAX_DB * 10}" step="1"
            value="${Math.round(makeup.db * 10)}"
            title="A single gain on the master. Levels only ever turns things down, so this is what brings the finished mix back up." />
          <button class="btn" id="lv-analyse" title="Render once, measure the true peak, and set the make-up so it lands at ${MAKEUP_TARGET_DB} dBFS">Analyse</button>
        </div>
        <div class="lv-legend" id="lv-makeup-note">Analyse renders the song once and aims the peak at
          ${MAKEUP_TARGET_DB} dBFS. The result is stored, so preview and export apply the same gain -
          adjust it by hand afterwards if you prefer.</div>
      </div>
      <div id="lv-readout" class="lv-readout"></div>
      <div class="lv-tracks">${doc.tracks
        .map((t) => `<label class="lv-track"><input type="checkbox" data-track="${t.id}"
          ${trackExempt(t) ? '' : 'checked'} />
          <span class="track-color" style="background:${trackColorCss(doc, t)}"></span>
          <span>${t.name}</span></label>`)
        .join('')}</div>
      <button class="btn" id="lv-reset">Reset to defaults</button>`;
    renderReadout();
  }

  body.addEventListener('input', (e) => {
    if (e.target.id === 'lv-makeup') {
      const label = body.querySelector('#lv-makeup-label');
      const v = Number(e.target.value) / 10;
      if (label) label.textContent = v === 0 ? 'none' : (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
      return;
    }
    const el = e.target;
    if (el.dataset && el.dataset.k) {
      const key = el.dataset.k;
      const raw = Number(el.value);
      const value = key === 'smoothMs' ? raw : raw / 100;
      el.parentElement.querySelector('.mix-val').textContent =
        key === 'smoothMs' ? raw + ' ms' : value.toFixed(2);
      patch(() => ({ [key]: value }));
      scheduleReadout();
    }
  });

  body.addEventListener('change', (e) => {
    if (e.target.id === 'lv-makeup') {
      const db = Number(e.target.value) / 10;
      store.commit('set make-up', ['song'], (d) => {
        d.master = d.master || {};
        if (db === 0) delete d.master.makeup;
        else d.master.makeup = { ...DEFAULT_MAKEUP, db };
      });
      return;
    }
    const el = e.target;
    if (el.id === 'lv-on') {
      patch(() => ({ enabled: el.checked }));
      scheduleReadout();
    } else if (el.dataset && el.dataset.track) {
      // A track opts out by storing false - exempt from BOTH stages, so the
      // box means exactly "this track is normalized". Opting back in clears
      // the field so it follows the song setting again rather than freezing
      // today's value.
      const id = el.dataset.track;
      const on = el.checked;
      store.commit('set track normalization', ['tracks'], (doc) => {
        const t = getTrack(doc, id);
        if (!t) return;
        if (on) delete t.normalize;
        else t.normalize = false;
      });
      scheduleReadout();
    }
  });

  // Analyse: one render, one measurement, one stored number.
  //
  // renderWav reports the PRE-limiter peak, so the correction is exact even
  // when the current setting is already driving the limiter - which a peak
  // read off the shaped output could not be.
  async function analyse() {
    const btn = body.querySelector('#lv-analyse');
    const note = body.querySelector('#lv-makeup-note');
    if (!btn) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      const doc = store.getDoc();
      const before = makeupConfig(doc).db;
      const { level } = await renderWav(doc);
      if (!Number.isFinite(level.peakDb)) {
        if (note) note.textContent = 'Nothing to measure - the song rendered silent.';
        return;
      }
      const next = Math.max(MAKEUP_MIN_DB, Math.min(MAKEUP_MAX_DB, before + (MAKEUP_TARGET_DB - level.peakDb)));
      store.commit('set make-up', ['song'], (d) => {
        d.master = d.master || {};
        d.master.makeup = { ...DEFAULT_MAKEUP, db: Math.round(next * 10) / 10 };
      });
      if (note) {
        note.textContent = `Measured ${level.peakDb.toFixed(1)} dBFS at ${before.toFixed(1)} dB make-up`
          + ` - set to ${next.toFixed(1)} dB to land at ${MAKEUP_TARGET_DB} dBFS.`;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  body.addEventListener('click', (e) => {
    if (e.target.closest('#lv-analyse')) {
      analyse();
      return;
    }
    if (e.target.closest('#lv-makeup-reset')) {
      store.commit('clear make-up', ['song'], (d) => {
        if (d.master) delete d.master.makeup;
      });
      return;
    }
    if (!e.target.closest('#lv-reset')) return;
    store.commit('reset normalization', ['song', 'tracks'], (doc) => {
      doc.master = doc.master || {};
      doc.master.normalize = { ...DEFAULT_NORMALIZE };
      for (const t of doc.tracks) delete t.normalize;
    });
  });

  store.subscribe(['tracks', 'notes', 'song', 'doc'], () => {
    render();
    scheduleReadout();
  });
  render();
}
