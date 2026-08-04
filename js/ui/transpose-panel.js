// Transpose section of the tools sidebar: bulk pitch operations on the
// selection, or the whole active track when nothing is selected.

import { updateNotes, activeTrack, getTrack } from '../core/doc.js';
import { keyName, transposeDiatonic, snapToKey, isInKey } from '../core/music.js';
import { PITCH_MIN, PITCH_MAX } from './piano-roll/coords.js';
import { initSectionFold, updateEmptyHint } from './sections.js';

export function initTransposePanel({ store, uiStore, engine }) {
  const section = document.getElementById('sec-transpose');
  const body = document.getElementById('transpose-body');
  const ctxLabel = section.querySelector('.tool-ctx');
  const ui = uiStore.state;
  const clamp = (p) => Math.max(PITCH_MIN, Math.min(PITCH_MAX, p));

  // Selection first; otherwise every note of the active track.
  function scope() {
    const doc = store.getDoc();
    if (ui.selection.size) {
      const track = getTrack(doc, ui.selectionTrackId || doc.activeTrackId);
      const notes = track ? track.notes.filter((n) => ui.selection.has(n.id)) : [];
      if (notes.length) {
        return { track, notes, label: `${notes.length} note${notes.length === 1 ? '' : 's'}` };
      }
    }
    const track = activeTrack(doc);
    if (track && track.notes.length) return { track, notes: track.notes, label: `whole “${track.name}”` };
    return null;
  }

  function apply(label, fn) {
    const s = scope();
    if (!s) return;
    const ids = s.notes.map((n) => n.id);
    store.commit(label, ['notes'], (doc) => updateNotes(doc, s.track.id, ids, fn));
    // audition the (new) pitch of the first affected note
    const doc = store.getDoc();
    const track = getTrack(doc, s.track.id);
    const first = track && track.notes.find((n) => n.id === ids[0]);
    if (first) engine.previewNote(first.pitch, track.instrumentId);
  }

  function render() {
    const s = scope();
    section.hidden = !s;
    updateEmptyHint();
    if (!s) return;
    ctxLabel.textContent = s.label;
    const key = store.getDoc().song.key;

    body.innerHTML = `
      <div class="harm-field">Octave
        <div class="btn-pair">
          <button class="btn" id="tp-oct-down">− 1 oct</button>
          <button class="btn" id="tp-oct-up">+ 1 oct</button>
        </div>
      </div>
      <div class="harm-field">Semitone
        <div class="btn-pair">
          <button class="btn" id="tp-semi-down">− 1 st</button>
          <button class="btn" id="tp-semi-up">+ 1 st</button>
        </div>
      </div>
      <div class="harm-field">In key - ${keyName(key)}
        <div class="btn-pair">
          <button class="btn" id="tp-deg-down" title="Down one scale degree (stays in key)">− 1 degree</button>
          <button class="btn" id="tp-deg-up" title="Up one scale degree (stays in key)">+ 1 degree</button>
        </div>
        <button class="btn" id="tp-snap" title="Conform chromatic notes to the nearest in-key pitch">Snap chromatic notes to key</button>
      </div>`;

    const wire = (id, label, fn) => body.querySelector('#' + id).addEventListener('click', () => apply(label, fn));
    wire('tp-oct-down', 'transpose -1 octave', (n) => { n.pitch = clamp(n.pitch - 12); });
    wire('tp-oct-up', 'transpose +1 octave', (n) => { n.pitch = clamp(n.pitch + 12); });
    wire('tp-semi-down', 'transpose -1 semitone', (n) => { n.pitch = clamp(n.pitch - 1); });
    wire('tp-semi-up', 'transpose +1 semitone', (n) => { n.pitch = clamp(n.pitch + 1); });
    wire('tp-deg-down', 'transpose -1 degree', (n) => { n.pitch = clamp(transposeDiatonic(n.pitch, key, -1)); });
    wire('tp-deg-up', 'transpose +1 degree', (n) => { n.pitch = clamp(transposeDiatonic(n.pitch, key, 1)); });

    const snapBtn = body.querySelector('#tp-snap');
    snapBtn.disabled = s.notes.every((n) => isInKey(n.pitch, key));
    snapBtn.addEventListener('click', () => apply('snap notes to key', (n) => { n.pitch = clamp(snapToKey(n.pitch, key)); }));
  }

  store.subscribe(['notes', 'tracks', 'song', 'doc'], render);
  uiStore.subscribe(['selection'], render);
  initSectionFold(section, 'transpose');
  render();
}
