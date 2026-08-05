// Toolbar: song settings, transport, snap, undo/redo, trim, export.
// Returns the shared `actions` object also used by the keyboard map.

import { PPQ, PITCH_NAMES, snapTick, detectKey, keyName } from '../core/music.js';
import { activeTrack, updateNotes, setTempo, setTimeSig, bpmAt, timeSigAt } from '../core/doc.js';
import { effectiveSnap } from './piano-roll/coords.js';
import { contextMenu } from './dialogs.js';
import { icon } from './icons.js';
import { trimBeforeAction, trimAfterAction } from './trimmer.js';

const TIME_SIGS = ['2/4', '3/4', '4/4', '5/4', '6/4', '3/8', '6/8', '7/8', '9/8', '12/8'];

const SNAP_OPTIONS = [
  { label: '1/1', ticks: PPQ * 4, triplet: false },
  { label: '1/2', ticks: PPQ * 2, triplet: false },
  { label: '1/4', ticks: PPQ, triplet: false },
  { label: '1/8', ticks: PPQ / 2, triplet: false },
  { label: '1/16', ticks: PPQ / 4, triplet: false },
  { label: '1/32', ticks: PPQ / 8, triplet: false },
  { label: '1/8T', ticks: PPQ / 2, triplet: true },
  { label: '1/16T', ticks: PPQ / 4, triplet: true },
  { label: 'Off', ticks: 0, triplet: false },
];

export function initToolbar({ store, uiStore, engine, roll, openExport, goHome, forceSave }) {
  const $ = (id) => document.getElementById(id);
  const ui = uiStore.state;

  // --- populate selects ---
  const selSig = $('sel-timesig');
  selSig.innerHTML = TIME_SIGS.map((s) => `<option value="${s}">${s}</option>`).join('');
  const selTonic = $('sel-key-tonic');
  selTonic.innerHTML = PITCH_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  const selSnap = $('sel-snap');
  selSnap.innerHTML = SNAP_OPTIONS.map((o, i) => `<option value="${i}">${o.label}</option>`).join('');

  // --- render from state ---
  function render() {
    const doc = store.getDoc();
    if (document.activeElement !== $('inp-name')) $('inp-name').value = doc.name;
    if (document.activeElement !== $('inp-bpm')) $('inp-bpm').value = bpmAt(doc, 0);
    const sig = timeSigAt(doc, 0);
    selSig.value = `${sig.num}/${sig.den}`;
    selTonic.value = String(doc.song.key.tonic);
    $('sel-key-mode').value = doc.song.key.mode;
    for (const btn of $('seg-mode').querySelectorAll('.seg-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === doc.mode);
    }
    $('btn-undo').disabled = !store.canUndo();
    $('btn-redo').disabled = !store.canRedo();
    $('btn-play').innerHTML = icon(engine.isPlaying() ? 'player-stop' : 'player-play');
    $('btn-loop').classList.toggle('active', !!(store.getLoop() && store.getLoop().enabled));
    $('btn-metro').classList.toggle('active', store.session.metronome);
    const snapIdx = SNAP_OPTIONS.findIndex((o) => o.ticks === ui.snapTicks && o.triplet === ui.triplet);
    if (snapIdx >= 0) selSnap.value = String(snapIdx);
  }

  store.subscribe(['song', 'notes', 'tracks', 'doc', 'loop', 'history'], render);
  uiStore.subscribe(['view', 'transport'], render);
  engine.on('playstate', render);

  // --- song settings ---
  $('inp-name').addEventListener('change', (e) => {
    const name = e.target.value.trim() || 'Untitled';
    store.commit('rename project', ['song'], (doc) => {
      doc.name = name;
    });
  });
  // Enter commits the project name immediately (change fires on blur)
  $('inp-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });

  $('inp-bpm').addEventListener('change', (e) => {
    const bpm = Math.max(20, Math.min(400, Number(e.target.value) || 120));
    store.commit('set BPM', ['song'], (doc) => {
      setTempo(doc, bpm); // writes the map; the legacy scalar is derived
    });
  });

  selSig.addEventListener('change', (e) => {
    const [num, den] = e.target.value.split('/').map(Number);
    store.commit('set time signature', ['song'], (doc) => {
      setTimeSig(doc, num, den);
    });
  });

  const setKey = () => {
    const tonic = Number(selTonic.value);
    const mode = $('sel-key-mode').value;
    store.commit('set key', ['song'], (doc) => {
      doc.song.key = { tonic, mode };
    });
  };
  selTonic.addEventListener('change', setKey);
  $('sel-key-mode').addEventListener('change', setKey);

  // Retroactive key detection from the song's notes (e.g. after importing a
  // MIDI file without a key-signature event).
  $('btn-detect-key').addEventListener('click', () => {
    const doc = store.getDoc();
    let notes = doc.tracks.filter((t) => t.role !== 'muted').flatMap((t) => t.notes);
    if (!notes.length) notes = doc.tracks.flatMap((t) => t.notes);
    const guess = detectKey(notes);
    if (!guess) return;
    store.commit('detect key', ['song'], (d) => {
      d.song.key = { tonic: guess.tonic, mode: guess.mode };
    });
    const save = document.getElementById('st-save');
    save.textContent = `key detected: ${keyName(guess)}`;
    setTimeout(() => (save.textContent = ''), 2500);
  });

  // --- mode switch ---
  $('seg-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    const mode = btn.dataset.mode;
    const doc = store.getDoc();
    if (doc.mode === mode) return;
    if (mode === 'mono') {
      const nonEmpty = doc.tracks.filter((t) => t.notes.length);
      if (nonEmpty.length > 1) {
        const rect = btn.getBoundingClientRect();
        contextMenu(rect.left, rect.bottom + 4, nonEmpty.map((t) => ({
          label: `Use “${t.name}” as the mono track`,
          action: () => switchMode('mono', t.id),
        })));
        return;
      }
      switchMode('mono', nonEmpty[0] ? nonEmpty[0].id : doc.activeTrackId);
    } else {
      switchMode('poly', null);
    }
  });

  function switchMode(mode, activeId) {
    store.commit('switch mode', ['song', 'tracks', 'notes'], (doc) => {
      doc.mode = mode;
      if (activeId) {
        doc.activeTrackId = activeId;
        doc.melodyTrackId = activeId;
      }
    });
  }

  // --- snap ---
  selSnap.addEventListener('change', (e) => {
    const opt = SNAP_OPTIONS[Number(e.target.value)];
    setSnap(opt.ticks, opt.triplet);
    selSnap.blur();
  });

  // Updates the live UI state and persists the preference into the project.
  function setSnap(ticks, triplet) {
    uiStore.update('view', (s) => {
      s.snapTicks = ticks;
      s.triplet = triplet;
    });
    store.setGrid({ snapTicks: ticks, triplet });
  }

  // --- actions (shared with keymap) ---
  const actions = {
    // Space: play from the placed cursor; stop reverts the playhead there.
    togglePlay() {
      if (engine.isPlaying()) {
        engine.stop();
        store.session.cursorTick = store.session.originTick;
        uiStore.update('transport', () => {});
      } else {
        store.session.cursorTick = store.session.originTick;
        engine.play(store.session.originTick);
      }
    },
    // Shift+Space: pause where playback is; unpause resumes from there.
    togglePause() {
      if (engine.isPlaying()) {
        store.session.cursorTick = Math.round(engine.getPlayheadTick());
        engine.stop();
        uiStore.update('transport', () => {});
      } else {
        engine.play(store.session.cursorTick);
      }
    },
    toggleLoop() {
      const loop = store.getLoop();
      if (loop) store.setLoop({ ...loop, enabled: !loop.enabled });
      uiStore.update('transport', () => {});
    },
    toggleMetronome() {
      store.session.metronome = !store.session.metronome;
      uiStore.update('transport', () => {});
    },
    quantize() {
      const grid = effectiveSnap(ui);
      if (!grid) return;
      const sel = roll.interactions.selectedNotes();
      if (!sel.length) return;
      store.commit('quantize', ['notes'], (doc) => {
        updateNotes(doc, ui.selectionTrackId || doc.activeTrackId, sel.map((n) => n.id), (n) => {
          n.startTick = Math.max(0, snapTick(n.startTick, grid));
        });
      });
    },
    zoom(factor) {
      const { W } = roll.getSize();
      uiStore.update('view', (s) => {
        const centerTick = s.scrollTick + W / s.pxPerTick / 2;
        s.pxPerTick = Math.min(8, Math.max(0.04, s.pxPerTick * factor));
        s.scrollTick = Math.max(0, centerTick - W / s.pxPerTick / 2);
      });
    },
    applyPanels() {
      document.getElementById('tracks-panel').classList.toggle('collapsed', !ui.panels.tracks);
      document.getElementById('harmonics-panel').classList.toggle('collapsed', !ui.panels.harmonics);
    },
    setSnap,
    trimBefore: () => trimBeforeAction(store, uiStore),
    trimAfter: () => trimAfterAction(store, uiStore),
    openExport,
    forceSave,
  };

  // --- transport buttons ---
  $('btn-play').addEventListener('click', () => actions.togglePlay());
  $('btn-loop').addEventListener('click', () => actions.toggleLoop());
  $('btn-metro').addEventListener('click', () => actions.toggleMetronome());
  $('btn-quantize').addEventListener('click', () => actions.quantize());
  $('btn-undo').addEventListener('click', () => store.undo());
  $('btn-redo').addEventListener('click', () => store.redo());
  $('btn-export').addEventListener('click', () => openExport());
  $('btn-home').addEventListener('click', () => goHome());

  // --- trim dropdown ---
  const trimMenu = $('menu-trim');
  $('btn-trim').addEventListener('click', () => {
    trimMenu.hidden = !trimMenu.hidden;
  });
  document.addEventListener('mousedown', (e) => {
    if (!trimMenu.hidden && !e.target.closest('.dropdown')) trimMenu.hidden = true;
  });
  $('btn-trim-before').addEventListener('click', () => {
    trimMenu.hidden = true;
    actions.trimBefore();
  });
  $('btn-trim-after').addEventListener('click', () => {
    trimMenu.hidden = true;
    actions.trimAfter();
  });

  // --- save dot ---
  const dot = $('save-dot');
  store.subscribe(['notes', 'tracks', 'song', 'harmonics'], () => dot.classList.add('dirty'));
  store.on('saved', () => dot.classList.remove('dirty'));

  render();
  return actions;
}
