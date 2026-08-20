// Tracks panel: list, active selection, roles, instruments, add/remove.

import { createTrack, duplicateTrack, moveTrack, pickTrackColor, TRACK_COLORS } from '../core/doc.js';
import { confirmDialog, contextMenu, trackDialog } from './dialogs.js';
import { icon } from './icons.js';
import { readTheme, trackColor } from './piano-roll/render.js';

export function initTracksPanel({ store, uiStore, onInstrumentPicker, onImportTracks }) {
  const list = document.getElementById('track-list');
  const theme = readTheme();

  function setActive(trackId) {
    if (store.getDoc().activeTrackId === trackId) return;
    store.commit('switch track', ['tracks'], (d) => {
      d.activeTrackId = trackId;
    });
    uiStore.update('selection', (s) => {
      s.selection.clear();
      s.selectionTrackId = trackId;
    });
  }

  // Reordering: grab anywhere on a row. Pointer-based like every other drag in
  // the app - and so the smoke tests can drive it with the synthetic events
  // they already use.
  //
  // The row is also a click target (select) and holds buttons, a select and a
  // double-click rename, so the drag ARMS on mousedown and only begins after
  // the pointer has actually moved. Under the threshold nothing happens and
  // the click runs as normal; over it, the click is swallowed so one drag is
  // one undo entry rather than a reorder plus a track switch.
  const DRAG_THRESHOLD = 4;
  let drag = null;
  let suppressClick = false;

  function rowsGeometry() {
    return [...list.children].map((li) => {
      const r = li.getBoundingClientRect();
      return { id: li.dataset.track, top: r.top, bottom: r.bottom, mid: r.top + r.height / 2 };
    });
  }

  function armReorder(e, trackId) {
    // Controls own their own gestures - dragging a slider or opening the
    // instrument menu must not start a reorder.
    if (e.button !== 0 || e.target.closest('button, select, input, textarea')) return;
    drag = { trackId, startY: e.clientY, rows: null, moved: false, to: null };
    window.addEventListener('mousemove', onReorderMove);
    window.addEventListener('mouseup', endReorder);
  }

  function onReorderMove(e) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.moved = true;
      // Geometry is captured once the drag is real, so rows measured here are
      // the ones the pointer will actually be compared against.
      drag.rows = rowsGeometry();
      list.classList.add('reordering');
    }
    // Land after every row whose midpoint is above the pointer.
    let to = 0;
    for (const r of drag.rows) {
      if (e.clientY > r.mid) to++;
    }
    const from = drag.rows.findIndex((r) => r.id === drag.trackId);
    drag.to = to > from ? to - 1 : to;
    for (const [i, li] of [...list.children].entries()) {
      li.classList.toggle('drop-target', i === drag.to && drag.to !== from);
    }
  }

  function endReorder() {
    window.removeEventListener('mousemove', onReorderMove);
    window.removeEventListener('mouseup', endReorder);
    list.classList.remove('reordering');
    const d = drag;
    drag = null;
    if (!d || !d.moved || d.to == null) return; // a plain click - leave it alone
    suppressClick = true;
    store.commit('reorder tracks', ['tracks'], (doc) => moveTrack(doc, d.trackId, d.to));
  }

  async function renameTrack(track) {
    const result = await trackDialog(track, TRACK_COLORS);
    if (!result) return;
    store.commit('edit track', ['tracks'], (d) => {
      const t = d.tracks.find((x) => x.id === track.id);
      if (!t) return;
      t.name = result.name;
      // null = follow the row's position, which is how it worked before
      // colours could be set - so it is stored by REMOVING the field.
      if (result.color === null) delete t.color;
      else t.color = result.color;
    });
  }

  async function deleteTrack(track) {
    const doc = store.getDoc();
    if (doc.tracks.length <= 1) return;
    if (track.notes.length && !(await confirmDialog('Delete track', `Delete track “${track.name}” and its ${track.notes.length} notes?`, 'Delete'))) return;
    store.commit('delete track', ['tracks', 'notes'], (d) => {
      // The active/melody/chord markers are re-pointed by the store's
      // invariant pass - no call site has to remember to do it.
      d.tracks = d.tracks.filter((t) => t.id !== track.id);
    });
    uiStore.update('selection', (s) => s.selection.clear());
  }

  function duplicate(track) {
    let copy = null;
    store.commit('duplicate track', ['tracks', 'notes'], (d) => {
      copy = duplicateTrack(d, track.id);
    });
    // The copy is now the active track; the selection still names notes of
    // the original, so it follows the switch the same way setActive's does.
    if (copy) uiStore.update('selection', (s) => {
      s.selection.clear();
      s.selectionTrackId = copy.id;
    });
  }

  function render() {
    const doc = store.getDoc();
    list.innerHTML = '';
    for (const track of doc.tracks) {
      const li = document.createElement('li');
      li.className = 'track-row' + (track.id === doc.activeTrackId ? ' active' : '');
      li.dataset.track = track.id;

      const color = document.createElement('span');
      color.className = 'track-color';
      color.style.background = trackColor(theme, doc, track);
      li.appendChild(color);

      const name = document.createElement('span');
      name.className = 'track-name';
      name.textContent = track.name;
      name.title = track.name + ' (double-click to rename or recolour)';
      li.appendChild(name);

      // Explicit role buttons (the only way to assign roles in mono mode):
      // M = melody/active track (plays + exports in mono), C = chords source.
      const mBtn = document.createElement('button');
      mBtn.className = 'btn-icon role-btn' + (doc.melodyTrackId === track.id ? ' on' : '');
      mBtn.textContent = 'M';
      mBtn.title = 'Melody marker - this track plays and exports in mono mode (clicking a row only changes which track you edit)';
      mBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.commit('set melody track', ['tracks', 'notes'], (d) => {
          d.melodyTrackId = track.id;
        });
      });
      li.appendChild(mBtn);

      const cBtn = document.createElement('button');
      cBtn.className = 'btn-icon role-btn chords' + (doc.chordTrackId === track.id ? ' on' : '');
      cBtn.textContent = 'C';
      cBtn.title = 'Chords source - feeds “Auto (song chords)” arpeggios and the chord lane';
      cBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.commit('set chord track', ['tracks', 'notes'], (d) => {
          d.chordTrackId = d.chordTrackId === track.id ? null : track.id;
        });
      });
      li.appendChild(cBtn);

      if (doc.mode === 'poly') {
        const inst = document.createElement('select');
        inst.title = 'Instrument (opens the Instrument tool in the sidebar)';
        const isCustom = !!track.instrument;
        inst.innerHTML =
          (isCustom ? '<option value="__custom" selected>Custom</option>' : '') +
          doc.instruments
            .map((i) => `<option value="${i.id}"${!isCustom && i.id === track.instrumentId ? ' selected' : ''}>${i.name}</option>`)
            .join('');
        inst.addEventListener('change', () => {
          if (inst.value !== '__custom') {
            store.commit('set instrument', ['tracks'], (d) => {
              const t = d.tracks.find((x) => x.id === track.id);
              t.instrumentId = inst.value;
              t.instrument = null; // picking a preset discards the custom config
            });
          }
          if (onInstrumentPicker) onInstrumentPicker(track.id);
        });
        inst.addEventListener('mousedown', () => {
          if (onInstrumentPicker) onInstrumentPicker(track.id);
        });
        inst.addEventListener('click', (e) => e.stopPropagation());
        li.appendChild(inst);

        const mute = document.createElement('button');
        mute.className = 'btn-icon' + (track.role === 'muted' ? '' : ' on');
        // Always the same glyph, state carried by the class. It used to read
        // "M" when muted, which sat two buttons from the M that marks the
        // melody track - one letter, two meanings, in the same row.
        mute.textContent = '♪';
        mute.title = track.role === 'muted'
          ? 'Unmute'
          : 'Mute - silences the track and hides its notes from the grid';
        mute.addEventListener('click', (e) => {
          e.stopPropagation();
          store.commit('toggle mute', ['tracks', 'notes'], (d) => {
            const t = d.tracks.find((x) => x.id === track.id);
            t.role = t.role === 'muted' ? 'melody' : 'muted';
          });
        });
        li.appendChild(mute);

        const solo = document.createElement('button');
        solo.className = 'btn-icon role-btn solo' + (track.solo ? ' on' : '');
        solo.textContent = 'S';
        solo.title = 'Solo - hear only the soloed tracks. The others stay '
          + 'visible in the grid, and levels are unchanged, so a soloed track '
          + 'sounds exactly as it does in the mix.';
        solo.addEventListener('click', (e) => {
          e.stopPropagation();
          store.commit('toggle solo', ['tracks', 'notes'], (d) => {
            const t = d.tracks.find((x) => x.id === track.id);
            t.solo = !t.solo;
          });
        });
        li.appendChild(solo);
      }

      const del = document.createElement('button');
      del.className = 'btn-icon';
      del.innerHTML = icon('trash');
      del.title = 'Delete track';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTrack(track);
      });
      li.appendChild(del);

      li.title = 'Drag to reorder';
      li.addEventListener('mousedown', (e) => armReorder(e, track.id));
      li.addEventListener('click', () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        setActive(track.id);
      });

      name.addEventListener('dblclick', () => renameTrack(track));

      // Right-click opens a menu. It used to TOGGLE the chord source
      // directly, which meant a stray right-click silently re-tuned every
      // "Auto (song chords)" arpeggio - an action nobody meant, with a
      // symptom (arps sound off) far from its cause. The C button remains
      // the way to set the chord source, visibly.
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Duplicate track', action: () => duplicate(track) },
          { label: 'Rename…', action: () => renameTrack(track) },
          {
            label: 'Delete track',
            disabled: store.getDoc().tracks.length <= 1,
            action: () => deleteTrack(track),
          },
        ]);
      });

      list.appendChild(li);
    }
  }

  document.getElementById('btn-add-track').addEventListener('click', () => {
    store.commit('add track', ['tracks'], (d) => {
      const track = createTrack({
        name: 'Track ' + (d.tracks.length + 1),
        instrumentId: d.mode === 'mono' ? 'badge' : 'sine',
        color: pickTrackColor(d), // the least-used palette entry
      });
      d.tracks.push(track);
      d.activeTrackId = track.id;
    });
  });

  document.getElementById('btn-import-track').addEventListener('click', () => {
    if (onImportTracks) onImportTracks();
  });

  store.subscribe(['tracks', 'song', 'doc'], render);
  render();
}
