// Levels card: tune the polyphony normalization and see what it does.
//
// The whole point is that the right exponent is a taste decision and the
// right smoothing depends on how short the material's notes are - neither is
// something the app can decide for you. So every parameter is exposed, and
// the predicted peak is shown with and without normalization so a setting can
// be judged by number as well as by ear.

import { getTrack } from '../../core/doc.js';
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

  body.addEventListener('click', (e) => {
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
