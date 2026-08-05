// Tracks panel: list, active selection, roles, instruments, add/remove.

import { createTrack } from '../core/doc.js';
import { promptDialog, confirmDialog } from './dialogs.js';
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

  function render() {
    const doc = store.getDoc();
    list.innerHTML = '';
    for (const track of doc.tracks) {
      const li = document.createElement('li');
      li.className = 'track-row' + (track.id === doc.activeTrackId ? ' active' : '');

      const color = document.createElement('span');
      color.className = 'track-color';
      color.style.background = trackColor(theme, doc, track.id);
      li.appendChild(color);

      const name = document.createElement('span');
      name.className = 'track-name';
      name.textContent = track.name;
      name.title = track.name + ' (double-click to rename)';
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
        mute.textContent = track.role === 'muted' ? 'M' : '♪';
        mute.title = track.role === 'muted' ? 'Unmute' : 'Mute';
        mute.addEventListener('click', (e) => {
          e.stopPropagation();
          store.commit('toggle mute', ['tracks', 'notes'], (d) => {
            const t = d.tracks.find((x) => x.id === track.id);
            t.role = t.role === 'muted' ? 'melody' : 'muted';
          });
        });
        li.appendChild(mute);
      }

      const del = document.createElement('button');
      del.className = 'btn-icon';
      del.innerHTML = icon('trash');
      del.title = 'Delete track';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const doc2 = store.getDoc();
        if (doc2.tracks.length <= 1) return;
        if (track.notes.length && !(await confirmDialog('Delete track', `Delete track “${track.name}” and its ${track.notes.length} notes?`, 'Delete'))) return;
        store.commit('delete track', ['tracks', 'notes'], (d) => {
          // The active/melody/chord markers are re-pointed by the store's
          // invariant pass - no call site has to remember to do it.
          d.tracks = d.tracks.filter((t) => t.id !== track.id);
        });
        uiStore.update('selection', (s) => s.selection.clear());
      });
      li.appendChild(del);

      li.addEventListener('click', () => setActive(track.id));

      name.addEventListener('dblclick', async () => {
        const newName = await promptDialog('Rename track', track.name);
        if (newName) {
          store.commit('rename track', ['tracks'], (d) => {
            d.tracks.find((t) => t.id === track.id).name = newName;
          });
        }
      });

      // right-click: set/unset as chord source
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        store.commit('set chord track', ['tracks', 'notes'], (d) => {
          d.chordTrackId = d.chordTrackId === track.id ? null : track.id;
        });
      });

      list.appendChild(li);
    }
  }

  document.getElementById('btn-add-track').addEventListener('click', () => {
    store.commit('add track', ['tracks'], (d) => {
      const track = createTrack({
        name: 'Track ' + (d.tracks.length + 1),
        instrumentId: d.mode === 'mono' ? 'badge' : 'sine',
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
