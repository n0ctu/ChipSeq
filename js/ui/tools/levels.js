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
  AUTO_ANALYSE_MS, AUTO_ANALYSE_DRIFT_DB,
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
    // dBFS, like the measured peak and the make-up. It was a bare linear
    // amplitude, which made the card speak three unit systems at once.
    const db = (p) => (p.peak > 0 ? (20 * Math.log10(p.peak)).toFixed(1) + ' dBFS' : '-∞');
    el.innerHTML = `
      <div class="lv-row"><span>without</span>
        <b class="${cls(off)}">${db(off)}</b><span>${verdict(off)}</span></div>
      <div class="lv-row"><span>with</span>
        <b class="${cls(on)}">${db(on)}</b><span>${verdict(on)}</span></div>
      <div class="lv-note">loudest moment: bar ${bar(on.tick)}, ${on.voices} voice${on.voices === 1 ? '' : 's'}</div>`;
  }

  function render() {
    const doc = store.getDoc();
    const cfg = normalizeConfig(doc);
    const makeup = makeupConfig(doc);
    const measuredText = makeup.measuredDb == null
      ? '--'
      : (makeup.measuredDb + makeup.db).toFixed(1) + ' dBFS';
    const slider = (id, label, value, max, step, fmt) => `
      <div class="mix-ctl">
        <label>${label}</label>
        <input type="range" data-k="${id}" min="0" max="${max}" step="${step}" value="${value}" />
        <span class="mix-val">${fmt}</span>
      </div>`;

    body.innerHTML = `
      <label class="tb-field"><input type="checkbox" id="lv-on" ${cfg.enabled ? 'checked' : ''} />
        <span>Normalize polyphony</span></label>
      ${slider('song', 'Song', Math.round(cfg.song * 100), 100, 5, Math.round(cfg.song * 100) + '%')}
      ${slider('track', 'Track', Math.round(cfg.track * 100), 100, 5, Math.round(cfg.track * 100) + '%')}
      ${slider('smoothMs', 'Smooth', cfg.smoothMs, 60, 1, cfg.smoothMs + ' ms')}
      <div class="lv-legend">How hard to normalize: 0% off &middot; 50% equal power &middot; 100% constant sum</div>

      <div class="lv-output">
        <div class="lv-out-head">Output level
          <span class="lv-mode">${makeup.auto ? 'auto' : 'manual'}</span></div>
        <div class="lv-out-peak">
          <b>${measuredText}</b>
          <span>${makeup.measuredDb == null ? 'not measured yet' : 'measured peak'}</span>
        </div>
        <div class="lv-out-sub">make-up <b id="lv-makeup-label">${
          makeup.db === 0 ? 'none' : (makeup.db > 0 ? '+' : '') + makeup.db.toFixed(1) + ' dB'}</b></div>
        <input type="range" id="lv-makeup" min="${MAKEUP_MIN_DB * 10}" max="${MAKEUP_MAX_DB * 10}" step="1"
          value="${Math.round(makeup.db * 10)}"
          title="The master gain. Drag to set it yourself - that switches this to manual." />
        <button class="btn" id="lv-analyse">${makeup.measuredDb == null ? 'Analyse' : 'Re-analyse'}</button>
        <div class="lv-note" id="lv-makeup-note">${
          makeup.auto
            ? `Renders the song and sets the level so it peaks at ${MAKEUP_TARGET_DB} dBFS. Re-checks every 5 minutes.`
            : `Set by hand. Press Analyse to measure again and return to auto.`}</div>
      </div>

      <div class="lv-legend">Estimate - an upper bound, not a measurement:</div>
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
        key === 'smoothMs' ? raw + ' ms' : Math.round(value * 100) + '%';
      patch(() => ({ [key]: value }));
      scheduleReadout();
    }
  });

  body.addEventListener('change', (e) => {
    if (e.target.id === 'lv-makeup') {
      const db = Number(e.target.value) / 10;
      store.commit('set make-up', ['song'], (d) => {
        d.master = d.master || {};
        const prev = makeupConfig(d);
        // Dragging the slider is a decision, so it switches off auto - the
        // app must not quietly replace a number you chose.
        d.master.makeup = { ...DEFAULT_MAKEUP, db, auto: false, measuredDb: prev.measuredDb };
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
  // Analyse: render once, read the PRE-limiter peak, set the gain that lands
  // it on target. `derived` marks it as a measurement the app made rather
  // than a number the user chose, so it does not enter undo history.
  let analysing = false;
  let lastEstimateDb = null;
  let lastAnalyseAt = 0;

  function estimateDb() {
    const doc = store.getDoc();
    if (doc.mode !== 'poly') return null;
    const events = flattenSong(doc).events;
    if (!events.length) return null;
    const p = predictPeak(doc, events, (ev) => getInstrument(doc, ev.instrumentId));
    return p.peak > 0 ? 20 * Math.log10(p.peak) : null;
  }

  async function analyse({ derived = false } = {}) {
    if (analysing) return;
    const btn = body.querySelector('#lv-analyse');
    analysing = true;
    const label = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Rendering…';
    }
    try {
      const doc = store.getDoc();
      const before = makeupConfig(doc).db;
      const { level } = await renderWav(doc);
      if (!Number.isFinite(level.peakDb)) return;
      const next = Math.max(MAKEUP_MIN_DB, Math.min(MAKEUP_MAX_DB,
        before + (MAKEUP_TARGET_DB - level.peakDb)));
      const write = (d) => {
        d.master = d.master || {};
        d.master.makeup = {
          ...DEFAULT_MAKEUP,
          db: Math.round(next * 10) / 10,
          auto: true,
          // What the render peaked at BEFORE this make-up, so the card can
          // keep showing the measurement instead of a number that vanishes.
          measuredDb: Math.round((level.peakDb - before) * 10) / 10,
        };
      };
      if (derived) store.commitDerived('re-measure output', ['song'], write);
      else store.commit('analyse output', ['song'], write);
      lastEstimateDb = estimateDb();
      lastAnalyseAt = Date.now();
    } finally {
      analysing = false;
      const b = body.querySelector('#lv-analyse');
      if (b) {
        b.disabled = false;
        if (label) b.textContent = label;
      }
    }
  }

  // Cheap estimate as the trigger, expensive measurement as the action: only
  // spend a render when the arrangement has actually moved.
  function maybeReanalyse() {
    const doc = store.getDoc();
    if (doc.mode !== 'poly' || analysing) return;
    if (!makeupConfig(doc).auto) return; // hand-set: not ours to change
    if (engine && engine.isPlaying && engine.isPlaying()) return; // not mid-playback
    if (Date.now() - lastAnalyseAt < AUTO_ANALYSE_MS) return;
    const now = estimateDb();
    if (now == null || lastEstimateDb == null) return;
    if (Math.abs(now - lastEstimateDb) < AUTO_ANALYSE_DRIFT_DB) return;
    analyse({ derived: true });
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

  // On activation: measure once, so the card opens with a real number rather
  // than a dash. Then reconsider on a timer, gated on the cheap estimate.
  lastEstimateDb = estimateDb();
  if (store.getDoc().mode === 'poly' && makeupConfig(store.getDoc()).auto) {
    setTimeout(() => analyse({ derived: true }), 0);
  }
  setInterval(maybeReanalyse, 30_000);

  store.subscribe(['tracks', 'notes', 'song', 'doc'], () => {
    render();
    scheduleReadout();
  });
  render();
  // ...and fill the estimate in straight away. Without this the card opened
  // with an empty bordered panel and only populated once something else
  // changed, which reads as broken rather than as pending.
  scheduleReadout();
}
