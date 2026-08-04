// Harmonics panel: non-destructive arpeggio/chord config on the selected
// note(s) + presets.

import { DEFAULT_HARMONICS, updateNotes, uid } from '../core/doc.js';
import { CHORD_TYPES } from '../core/harmonics.js';
import { explainNoteChord, flattenNote, makeArpContext } from '../core/flatten.js';
import { loadPresets, savePresets } from '../core/persist.js';
import { chordName, PITCH_NAMES } from '../core/music.js';
import { promptDialog, confirmDialog } from './dialogs.js';
import { initSectionFold, updateEmptyHint } from './sections.js';
import { icon } from './icons.js';

const PATTERNS = [
  { id: 'up', label: 'Up' },
  { id: 'down', label: 'Down' },
  { id: 'updown', label: 'U-D' },
  { id: 'random', label: 'Rnd' },
];

// Up to 32 steps/beat: classic C64/NES arps flip notes every video frame,
// i.e. ~25-30 steps per beat at 120 BPM.
const STEPS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

const SOURCE_LABELS = {
  song: 'song chords',
  track: 'from track',
  custom: 'custom chord',
  key: 'diatonic in key',
  'key-chromatic': 'key fallback',
  fixed: 'fixed',
};

// Quality chords for the source menu, ordered common -> exotic.
const QUALITIES = [
  ['', 'Major', [0, 4, 7]],
  ['m', 'Minor', [0, 3, 7]],
  ['5', 'Power', [0, 7]],
  ['7', 'Dominant 7', [0, 4, 7, 10]],
  ['m7', 'Minor 7', [0, 3, 7, 10]],
  ['maj7', 'Major 7', [0, 4, 7, 11]],
  ['sus4', 'Sus4', [0, 5, 7]],
  ['sus2', 'Sus2', [0, 2, 7]],
  ['6', 'Sixth', [0, 4, 7, 9]],
  ['m6', 'Minor 6', [0, 3, 7, 9]],
  ['dim', 'Diminished', [0, 3, 6]],
  ['aug', 'Augmented', [0, 4, 8]],
  ['m7b5', 'Half-diminished', [0, 3, 6, 10]],
];

function pcsEqual(a, b) {
  const sa = [...new Set(a.map((p) => ((p % 12) + 12) % 12))].sort((x, y) => x - y);
  const sb = [...new Set(b.map((p) => ((p % 12) + 12) % 12))].sort((x, y) => x - y);
  return sa.length === sb.length && sa.every((p, i) => p === sb[i]);
}

export function initHarmonicsPanel({ store, uiStore, roll, engine }) {
  const body = document.getElementById('harmonics-body');
  const section = document.getElementById('sec-harmonics');
  const ctxLabel = section.querySelector('.tool-ctx');
  const ui = uiStore.state;

  function selectedNotes() {
    return roll.interactions.selectedNotes();
  }

  // Shared arp value across the selection: value, null (none) or 'mixed' per field.
  function commonArp(notes) {
    const arps = notes.map((n) => n.harmonics);
    if (arps.every((a) => !a)) return null;
    const fields = ['mode', 'stepsPerBeat', 'pattern', 'octaves', 'gate', 'chordType', 'chordSource', 'anchor', 'octaveShift'];
    const first = arps.find(Boolean);
    const out = {};
    for (const f of fields) {
      const vals = new Set(arps.map((a) => (a ? JSON.stringify(a[f]) : 'null')));
      out[f] = vals.size === 1 ? first[f] : 'mixed';
    }
    out._partial = arps.some((a) => !a);
    return out;
  }

  function applyArp(patch) {
    const notes = selectedNotes();
    if (!notes.length) return;
    const trackId = ui.selectionTrackId || store.getDoc().activeTrackId;
    store.commit('edit arpeggio', ['notes', 'harmonics'], (doc) => {
      updateNotes(doc, trackId, notes.map((n) => n.id), (n) => {
        const base = n.harmonics ? { ...n.harmonics } : { ...DEFAULT_HARMONICS };
        n.harmonics = { ...base, ...patch };
      });
    });
  }

  function removeArp() {
    const notes = selectedNotes();
    if (!notes.length) return;
    const trackId = ui.selectionTrackId || store.getDoc().activeTrackId;
    store.commit('remove arpeggio', ['notes', 'harmonics'], (doc) => {
      updateNotes(doc, trackId, notes.map((n) => n.id), (n) => {
        n.harmonics = null;
      });
    });
  }

  function render() {
    const doc = store.getDoc();
    const notes = selectedNotes();

    // Context-sensitive section: only shown while notes are selected.
    section.hidden = !notes.length;
    updateEmptyHint();
    if (!notes.length) return;
    ctxLabel.textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}`;

    const arp = commonArp(notes);
    const has = !!arp;
    const val = (f, dflt) => (arp && arp[f] !== 'mixed' && arp[f] !== undefined ? arp[f] : dflt);
    const isMixed = (f) => arp && arp[f] === 'mixed';

    // Transparency: what chord does the (first) selected note resolve to?
    const trackId = ui.selectionTrackId || doc.activeTrackId;
    const first = notes.find((n) => n.harmonics);
    const info = first ? explainNoteChord(doc, trackId, first.id) : null;
    const srcLabel = info
      ? info.source === 'track'
        ? `from “${info.trackName ?? '?'}”`
        : SOURCE_LABELS[info.source] || info.source
      : '';
    const infoHtml = info
      ? `<div class="harm-info${info.detail ? ' warn' : ''}">
           <span class="harm-chord-name">${info.name ?? '-'}</span>
           <span class="harm-chord-src">${srcLabel}${notes.length > 1 ? ' - first of ' + notes.length : ''}</span>
           ${info.detail ? `<div class="harm-chord-detail">⚠ ${info.detail}</div>` : ''}
         </div>`
      : '';

    // ---- chord source menu (only for "Auto (song chords)") ----
    // Ordered by familiarity: track-derived chords first, then quality
    // chords (common -> exotic), free note picking last.
    let sourceHtml = '';
    const srcVal = val('chordSource', null);
    const srcMixed = isMixed('chordSource');
    if (has && val('chordType', '') === 'autoSong') {
      const ctx = makeArpContext(doc);
      const refNote = first || notes[0];
      const recTrack = doc.chordTrackId ? doc.tracks.find((t) => t.id === doc.chordTrackId) : null;
      const recPcs = refNote ? ctx.getChordPitchClassesAt(refNote.startTick) : null;
      const recLabel = recTrack
        ? `Recommended - “${recTrack.name}”${recPcs ? ': ' + chordName(recPcs) : ''}`
        : 'Recommended - song key (no chords track)';

      let selectValue = 'rec';
      if (srcMixed) selectValue = '';
      else if (srcVal && srcVal.trackId) selectValue = 'track:' + srcVal.trackId;
      else if (srcVal && srcVal.pcs) {
        selectValue = 'pick';
        outer: for (const [q, , ivs] of QUALITIES) {
          for (let root = 0; root < 12; root++) {
            if (pcsEqual(srcVal.pcs, ivs.map((iv) => (root + iv) % 12))) {
              selectValue = `q:${root}:${q}`;
              break outer;
            }
          }
        }
      }

      const trackOpts = doc.tracks
        .filter((t) => t.notes.length && t.id !== doc.chordTrackId)
        .map((t) => {
          const pcs = refNote ? ctx.getChordPitchClassesFromTrack(t.id, refNote.startTick) : null;
          const label = `From “${t.name}”${pcs ? ' - ' + chordName(pcs) : ''}`;
          return `<option value="track:${t.id}" ${selectValue === 'track:' + t.id ? 'selected' : ''}>${label}</option>`;
        })
        .join('');

      const tonic = doc.song.key.tonic;
      const qualityGroups = QUALITIES.map(([q, groupLabel]) => {
        const opts = [...Array(12)]
          .map((_, i) => {
            const root = (tonic + i) % 12;
            const v = `q:${root}:${q}`;
            return `<option value="${v}" ${selectValue === v ? 'selected' : ''}>${PITCH_NAMES[root]}${q}</option>`;
          })
          .join('');
        return `<optgroup label="${groupLabel}">${opts}</optgroup>`;
      }).join('');

      sourceHtml = `
        <div class="harm-field">Chord source
          <select id="harm-source">
            ${srcMixed ? '<option value="" selected>-</option>' : ''}
            <option value="rec" ${selectValue === 'rec' ? 'selected' : ''}>${recLabel}</option>
            ${trackOpts}
            ${qualityGroups}
            <option value="pick" ${selectValue === 'pick' ? 'selected' : ''}>Pick notes…</option>
          </select>
        </div>
        ${!srcMixed && srcVal && srcVal.pcs ? `
        <div class="harm-field">Chord notes
          <div class="pc-picker" id="harm-pcs">
            ${PITCH_NAMES.map((n, pc) => `<button type="button" data-pc="${pc}" class="pc-key${srcVal.pcs.some((p) => ((p % 12) + 12) % 12 === pc) ? ' on' : ''}">${n}</button>`).join('')}
          </div>
        </div>` : ''}`;
    }

    body.innerHTML = `
      <div class="harm-row">
        <span style="flex:1"></span>
        ${has ? `<button class="btn btn-icon" id="harm-audition" title="Audition this arpeggio">${icon('player-play')}</button>` : ''}
        <label class="tb-field"><input type="checkbox" id="harm-on" ${has ? 'checked' : ''}/> On</label>
      </div>
      ${infoHtml}
      <div id="harm-controls" style="display:${has ? 'contents' : 'none'}">
        ${doc.mode === 'poly' ? `
        <div class="harm-field">Mode
          <div class="seg" id="harm-mode">
            <button class="seg-btn ${val('mode', 'arp') === 'arp' ? 'active' : ''}" data-v="arp">Arpeggio</button>
            <button class="seg-btn ${val('mode', 'arp') === 'chord' ? 'active' : ''}" data-v="chord">Chord</button>
          </div>
        </div>` : ''}
        <div class="harm-field">Chord
          <select id="harm-chord">
            ${isMixed('chordType') ? '<option value="" selected>-</option>' : ''}
            ${CHORD_TYPES.map((c) => `<option value="${c.id}" ${val('chordType', '') === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
        </div>
        ${sourceHtml}
        <div class="harm-field">Steps per beat
          <div class="seg seg-wrap" id="harm-steps">
            ${STEPS.map((s) => `<button class="seg-btn ${val('stepsPerBeat', 0) === s ? 'active' : ''}" data-v="${s}">${s}</button>`).join('')}
          </div>
        </div>
        <div class="harm-field">Pattern
          <div class="seg" id="harm-pattern">
            ${PATTERNS.map((p) => `<button class="seg-btn ${val('pattern', '') === p.id ? 'active' : ''}" data-v="${p.id}">${p.label}</button>`).join('')}
          </div>
        </div>
        <div class="harm-field">Octaves
          <div class="stepper">
            <button class="btn btn-icon" id="harm-oct-dec">−</button>
            <span class="val">${isMixed('octaves') ? '-' : val('octaves', 1)}</span>
            <button class="btn btn-icon" id="harm-oct-inc">+</button>
          </div>
        </div>
        <div class="harm-field">Voicing
          <div class="seg" id="harm-anchor" title="Which side of the note the chord is voiced on">
            <button class="seg-btn ${val('anchor', 'above') === 'above' ? 'active' : ''}" data-v="above">↑ Above</button>
            <button class="seg-btn ${val('anchor', 'above') === 'below' ? 'active' : ''}" data-v="below">↓ Below</button>
          </div>
        </div>
        <div class="harm-field">Octave shift
          <div class="stepper" title="Transpose the whole sweep, e.g. −1 to put it in the bass register">
            <button class="btn btn-icon" id="harm-shift-dec">−</button>
            <span class="val">${isMixed('octaveShift') ? '-' : (val('octaveShift', 0) > 0 ? '+' : '') + val('octaveShift', 0)}</span>
            <button class="btn btn-icon" id="harm-shift-inc">+</button>
          </div>
        </div>
        <div class="harm-field">Step gap <span id="harm-gate-label">${isMixed('gate') ? '-' : Math.round((1 - val('gate', 1)) * 100) + '%'}</span>
          <div class="harm-row">
            <input type="range" id="harm-gate" min="0" max="90" step="5"
              value="${isMixed('gate') ? 0 : Math.round((1 - val('gate', 1)) * 100)}" />
          </div>
        </div>
        <button class="btn" id="harm-remove">Remove arpeggio</button>
      </div>
      <div class="harm-field" style="margin-top:8px">Presets
        <div class="harm-presets">
          <select id="harm-preset"><option value="">- preset -</option></select>
          <button class="btn btn-icon" id="harm-preset-save" title="Save current as preset">${icon('device-floppy')}</button>
          <button class="btn btn-icon" id="harm-preset-del" title="Delete selected preset">${icon('trash')}</button>
        </div>
      </div>`;

    // ---- wire controls ----
    body.querySelector('#harm-on').addEventListener('change', (e) => {
      if (e.target.checked) applyArp({});
      else removeArp();
    });

    const audition = body.querySelector('#harm-audition');
    if (audition) {
      audition.addEventListener('click', () => {
        const target = selectedNotes().find((n) => n.harmonics);
        if (!target) return;
        const track = store.getDoc().tracks.find((t) => t.id === (ui.selectionTrackId || store.getDoc().activeTrackId));
        engine.previewEvents(flattenNote(store.getDoc(), track.id, target.id), track.instrumentId);
      });
    }

    const seg = (id, field, map = (v) => v) => {
      const el = body.querySelector(id);
      if (!el) return;
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-v]');
        if (btn) applyArp({ [field]: map(btn.dataset.v) });
      });
    };
    seg('#harm-mode', 'mode');
    seg('#harm-steps', 'stepsPerBeat', Number);
    seg('#harm-pattern', 'pattern');
    seg('#harm-anchor', 'anchor');

    body.querySelector('#harm-chord').addEventListener('change', (e) => {
      if (e.target.value) applyArp({ chordType: e.target.value });
    });

    const sourceSel = body.querySelector('#harm-source');
    if (sourceSel) {
      sourceSel.addEventListener('change', () => {
        const v = sourceSel.value;
        if (v === 'rec') {
          applyArp({ chordSource: null });
        } else if (v.startsWith('track:')) {
          applyArp({ chordSource: { trackId: v.slice(6) } });
        } else if (v.startsWith('q:')) {
          const [, root, q] = v.split(':');
          const quality = QUALITIES.find(([id]) => id === q);
          const pcs = quality[2].map((iv) => (Number(root) + iv) % 12);
          applyArp({ chordSource: { pcs, label: PITCH_NAMES[Number(root)] + q } });
        } else if (v === 'pick') {
          // start the picker from the currently resolved chord
          const target = selectedNotes().find((n) => n.harmonics);
          const resolved = target ? explainNoteChord(store.getDoc(), ui.selectionTrackId || store.getDoc().activeTrackId, target.id) : null;
          const pcs = resolved
            ? [...new Set(resolved.intervals.map((iv) => (target.pitch + iv) % 12))]
            : [0, 4, 7];
          applyArp({ chordSource: { pcs, label: chordName(pcs) } });
        }
      });
    }

    const pcPicker = body.querySelector('#harm-pcs');
    if (pcPicker) {
      pcPicker.addEventListener('click', (e) => {
        const key = e.target.closest('.pc-key');
        if (!key) return;
        const pc = Number(key.dataset.pc);
        const cur = new Set((val('chordSource', {}).pcs || []).map((p) => ((p % 12) + 12) % 12));
        cur.has(pc) ? cur.delete(pc) : cur.add(pc);
        const pcs = [...cur].sort((a, b) => a - b);
        if (!pcs.length) applyArp({ chordSource: null });
        else applyArp({ chordSource: { pcs, label: chordName(pcs) } });
      });
    }
    body.querySelector('#harm-oct-dec').addEventListener('click', () => {
      const cur = val('octaves', 1);
      applyArp({ octaves: Math.max(1, (cur === 'mixed' ? 1 : cur) - 1) });
    });
    body.querySelector('#harm-oct-inc').addEventListener('click', () => {
      const cur = val('octaves', 1);
      applyArp({ octaves: Math.min(4, (cur === 'mixed' ? 1 : cur) + 1) });
    });
    body.querySelector('#harm-shift-dec').addEventListener('click', () => {
      const cur = val('octaveShift', 0);
      applyArp({ octaveShift: Math.max(-3, (cur === 'mixed' ? 0 : cur) - 1) });
    });
    body.querySelector('#harm-shift-inc').addEventListener('click', () => {
      const cur = val('octaveShift', 0);
      applyArp({ octaveShift: Math.min(3, (cur === 'mixed' ? 0 : cur) + 1) });
    });
    body.querySelector('#harm-gate').addEventListener('input', (e) => {
      applyArp({ gate: 1 - Number(e.target.value) / 100 });
    });
    body.querySelector('#harm-remove').addEventListener('click', removeArp);

    // ---- presets ----
    const presetSel = body.querySelector('#harm-preset');
    const presets = loadPresets();
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      presetSel.appendChild(opt);
    }
    presetSel.addEventListener('change', () => {
      const p = presets.find((x) => x.id === presetSel.value);
      if (p) applyArp({ ...p.config });
    });
    body.querySelector('#harm-preset-save').addEventListener('click', async () => {
      const notes2 = selectedNotes();
      const src = notes2.find((n) => n.harmonics);
      if (!src) return;
      const name = await promptDialog('Preset name', '');
      if (!name) return;
      // Presets carry no chord-source info (track ids are project-specific,
      // custom chords are note-specific) - applied presets stay "Recommended".
      const { chordSource, ...config } = src.harmonics;
      void chordSource;
      const list = loadPresets();
      const existing = list.find((p) => p.name === name);
      if (existing) {
        if (!(await confirmDialog('Overwrite preset', `A preset named “${name}” exists. Overwrite it?`, 'Overwrite'))) return;
        existing.config = config;
      } else {
        list.push({ id: uid(), name, config });
      }
      savePresets(list);
      render();
    });
    body.querySelector('#harm-preset-del').addEventListener('click', async () => {
      if (!presetSel.value) return;
      const list = loadPresets();
      const p = list.find((x) => x.id === presetSel.value);
      if (!p) return;
      if (!(await confirmDialog('Delete preset', `Delete preset “${p.name}”? Notes using it keep their arpeggio.`, 'Delete'))) return;
      savePresets(list.filter((x) => x.id !== p.id));
      render();
    });
  }

  store.subscribe(['notes', 'tracks', 'arp', 'song', 'doc'], render);
  uiStore.subscribe(['selection'], render);
  initSectionFold(section, 'harmonics');
  render();
}
