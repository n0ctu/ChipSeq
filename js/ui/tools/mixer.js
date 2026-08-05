// Mixer card: per-track level, pan and solo.
//
// These are mix properties, not instrument properties - two tracks can share
// one instrument and still need different levels - so they live here rather
// than in the Instrument card, and they act on the per-track audio nodes
// built by graph.js rather than being baked into each voice.

import { getTrack, trackGain, trackPan, spreadPan, hasPanLane } from '../../core/doc.js';
import { formatPercent, formatPan, isHot } from '../../core/units.js';

export function mount(body, { store, engine }) {
  function render() {
    const doc = store.getDoc();
    const anySolo = doc.tracks.some((t) => t.solo);

    // A starting point, not a layout: one click fans the tracks out and you
    // adjust from there, which beats dragging four sliders to find out that
    // a wide mix was what you wanted.
    const spread = `<button class="btn" id="mix-spread"
      title="Fan the tracks across the stereo field - melody centred, the rest outward">Spread</button>`;

    body.innerHTML = spread + doc.tracks
      .map((track, i) => {
        const gain = trackGain(track);
        const pan = trackPan(track);
        const muted = track.role === 'muted';
        // While something is soloed, everything else is inaudible - say so,
        // rather than leaving the user wondering why a track went quiet.
        const silenced = muted || (anySolo && !track.solo);
        return `
          <div class="mix-row${silenced ? ' silenced' : ''}" data-track="${track.id}">
            <div class="mix-head">
              <span class="track-color" style="background:var(--track-${(i % 8) + 1})"></span>
              <span class="mix-name">${track.name}</span>
              <button class="btn-icon mix-solo${track.solo ? ' on' : ''}" data-act="solo"
                title="Solo - hear only the soloed tracks">S</button>
            </div>
            <div class="mix-ctl">
              <label>Gain</label>
              <input type="range" data-act="gain" min="0" max="150" step="1" value="${Math.round(gain * 100)}" />
              <span class="mix-val${isHot(gain) ? ' hot' : ''}">${formatPercent(gain)}</span>
            </div>
            <div class="mix-ctl">
              <label>Pan</label>
              <input type="range" data-act="pan" min="-100" max="100" step="1"
                value="${Math.round(pan * 100)}" ${hasPanLane(track) ? 'disabled' : ''} />
              <span class="mix-val">${hasPanLane(track) ? 'lane' : formatPan(pan)}</span>
            </div>
          </div>`;
      })
      .join('');
  }

  // Live drags update the node value straight away so the change is audible
  // mid-drag; only the release commits, matching the instrument sliders.
  function setLive(trackId, patch) {
    const node = engine.trackNode && engine.trackNode(trackId);
    if (!node) return;
    if (patch.gain != null) node.gain.value = patch.gain;
  }

  body.addEventListener('input', (e) => {
    const input = e.target.closest('input[data-act]');
    if (!input) return;
    const row = input.closest('.mix-row');
    const value = Number(input.value);
    const label = input.parentElement.querySelector('.mix-val');
    if (input.dataset.act === 'gain') {
      label.textContent = formatPercent(value / 100);
      label.classList.toggle('hot', isHot(value / 100));
      setLive(row.dataset.track, { gain: value / 100 });
    } else {
      label.textContent = formatPan(value / 100);
    }
  });

  body.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-act]');
    if (!input) return;
    const trackId = input.closest('.mix-row').dataset.track;
    const act = input.dataset.act;
    const value = Number(input.value) / 100;
    store.commit(act === 'gain' ? 'set track gain' : 'set track pan', ['tracks'], (doc) => {
      const t = getTrack(doc, trackId);
      if (t) t[act] = value;
    });
  });

  body.addEventListener('click', (e) => {
    if (e.target.closest('#mix-spread')) {
      store.commit('spread tracks', ['tracks'], (doc) => spreadPan(doc));
      return;
    }
    const btn = e.target.closest('[data-act="solo"]');
    if (!btn) return;
    const trackId = btn.closest('.mix-row').dataset.track;
    store.commit('toggle solo', ['tracks'], (doc) => {
      const t = getTrack(doc, trackId);
      if (t) t.solo = !t.solo;
    });
  });

  store.subscribe(['tracks', 'doc', 'song'], render);
  render();
}
