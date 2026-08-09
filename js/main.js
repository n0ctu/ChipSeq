// Boot: create stores + engine, wire all UI components. The only place the
// core and UI layers are composed.

import { createProject, applyImport, mergeImport, uid, activeTrack, trackPitchCenter, bpmAt, unsupportedFeatures, PPQ, tickToSeconds } from './core/doc.js';
import { createStore } from './core/store.js';
import {
  attachAutosave, saveProject, importProjectFile, listProjects, loadProject,
  lastOpenId, purgeSeededDemos,
} from './core/persist.js';
import { createEngine } from './core/engine.js';
import { createBadgeStream } from './net/badge-stream.js';
import { getBadgeClient } from './net/badges.js';
import { parseMidi } from './core/midi-import.js';

import { createUiStore } from './ui/ui-store.js';
import { initStartScreen } from './ui/start-screen.js';
import { initPianoRoll } from './ui/piano-roll/piano-roll.js';
import { initToolbar } from './ui/toolbar.js';
import { initStatusBar } from './ui/status-bar.js';
import { initTracksPanel } from './ui/tracks-panel.js';
import { initToolsPanel } from './ui/tools-panel.js';
import { initKeymap } from './ui/keymap.js';
import { initExportDialog } from './ui/export-dialog.js';
import { midiImportDialog } from './ui/midi-import-dialog.js';
import { createConflicts } from './ui/conflicts.js';
import { initPanelResizers } from './ui/panel-resize.js';

// openDemoFile != null while an unmodified demo is open: the first edit
// forks it into a personal project (copy-on-write), so demos themselves are
// never stored and always load fresh from demos/.
let openDemoFile = null;

const store = createStore(createProject());
const uiStore = createUiStore();
const engine = createEngine(store);
const conflicts = createConflicts(store);
const flushSave = attachAutosave(store, { shouldSave: () => !openDemoFile });

// Keep the live snap mirror in sync with the project's saved grid preference
// (project open, undo/redo).
function syncGridFromDoc() {
  const grid = store.getDoc().grid;
  uiStore.update('view', (s) => {
    s.snapTicks = grid ? grid.snapTicks : PPQ / 2;
    s.triplet = grid ? !!grid.triplet : false;
  });
}
store.subscribe(['doc'], syncGridFromDoc);

const screenStart = document.getElementById('screen-start');
const screenEditor = document.getElementById('screen-editor');

function showScreen(name) {
  uiStore.update('view', (s) => {
    s.screen = name;
  });
  screenStart.hidden = name !== 'start';
  screenEditor.hidden = name !== 'editor';
  if (name === 'start') startScreen.render();
}

function openProject(doc, { demo = null } = {}) {
  engine.stop();
  engine.setAudition(null); // never carry an audition loop into another project
  openDemoFile = demo;
  store.setDoc(doc);
  uiStore.update('selection', (s) => {
    s.selection.clear();
    s.selectionTrackId = doc.activeTrackId;
    s.scrollTick = 0;
  });
  if (!demo) saveProject(doc);
  showScreen('editor');
  // Put the viewport back where this project was left; only fall back to
  // centring on the track's notes for one that has never been opened.
  if (!roll.restoreView(store.getView())) {
    roll.centerOnPitch(trackPitchCenter(activeTrack(doc)));
  }
  announceUnsupported(doc);
}

// A file written by a newer build can carry features this one cannot play.
// It is never dropped - unknown blocks round-trip untouched - but staying
// silent about it would mean playing the project wrong without saying so.
function announceUnsupported(doc) {
  const missing = unsupportedFeatures(doc);
  const save = document.getElementById('st-save');
  if (!missing.length || !save) return;
  save.textContent =
    `this project uses ${missing.join(', ')}, which this version can't play - it is preserved, not lost`;
  setTimeout(() => (save.textContent = ''), 8000);
}

// Editing a demo creates your own copy (same name, not a demo).
const EDIT_SCOPES = ['song', 'notes', 'tracks', 'harmonics', 'automation', 'loop', 'grid'];
store.subscribe(EDIT_SCOPES, (ev) => {
  if (!openDemoFile) return;
  // opening/undoing is not an edit (setDoc emits the same scopes)
  if (ev.label === 'open' || ev.label === 'undo' || ev.label === 'redo') return;
  openDemoFile = null;
  const doc = store.getDoc();
  doc.id = uid();
  doc.createdAt = new Date().toISOString();
  saveProject(doc);
  const save = document.getElementById('st-save');
  if (save) {
    save.textContent = `copy of the demo created - "${doc.name}" is yours now`;
    setTimeout(() => (save.textContent = ''), 4000);
  }
});

// Demos: fetched fresh on every visit so updates reach everyone.
// The manifest order in demos/index.json is the display order.
let demos = [];
async function loadDemos() {
  const files = await (await fetch('demos/index.json')).json();
  const loaded = [];
  for (const file of files) {
    try {
      const doc = importProjectFile(await (await fetch('demos/' + file)).text());
      loaded.push(doc);
    } catch (err) {
      console.warn('demo load failed:', file, err);
    }
  }
  return loaded;
}

// Import MIDI tracks INTO the open project (tracks panel button).
const trackImportInput = document.getElementById('track-import-input');
trackImportInput.addEventListener('change', async () => {
  const file = trackImportInput.files[0];
  if (!file) return;
  try {
    const parsed = parseMidi(await file.arrayBuffer());
    const doc = store.getDoc();
    const assignments = await midiImportDialog(parsed, { merge: true, projectBpm: bpmAt(doc, 0) });
    if (!assignments) return;
    let addedIds = [];
    store.commit('import MIDI tracks', ['tracks', 'notes'], (d) => {
      addedIds = mergeImport(d, parsed, assignments);
    });
    uiStore.update('selection', (s) => {
      s.selection.clear();
      s.selectionTrackId = addedIds[0] || s.selectionTrackId;
    });
  } catch (err) {
    console.error(err);
    alert('Import failed: ' + err.message);
  }
});

async function handleFile(file) {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.mid') || name.endsWith('.midi')) {
      const parsed = parseMidi(await file.arrayBuffer());
      // Decide mode before showing the dialog: default to mono (badge-first).
      const assignments = await midiImportDialog(parsed);
      if (!assignments) return;
      const doc = createProject({ name: file.name.replace(/\.(mid|midi)$/i, ''), mode: 'mono' });
      applyImport(doc, parsed, assignments);
      openProject(doc);
    } else if (name.endsWith('.json')) {
      const doc = importProjectFile(await file.text());
      openProject(doc);
    } else {
      alert('Unsupported file type - drop a .mid or .chipseq.json file.');
    }
  } catch (err) {
    console.error(err);
    alert('Import failed: ' + err.message);
  }
}

// ---- init UI ----

const startScreen = initStartScreen({
  onOpenProject: openProject,
  onNewProject: () => openProject(createProject()),
  onFilePicked: handleFile,
  getDemos: () => demos,
  // open a fresh clone so the cached demo stays pristine across opens
  onOpenDemo: (demo) => openProject(structuredClone(demo), { demo: demo.id }),
});

const roll = initPianoRoll(store, uiStore, engine, conflicts);
const exportDialog = initExportDialog({ store, conflicts });

const actions = initToolbar({
  store,
  uiStore,
  engine,
  roll,
  openExport: () => exportDialog.open(),
  goHome: () => {
    flushSave();
    engine.stop();
    engine.setAudition(null);
    showScreen('start');
  },
  forceSave: () => {
    saveProject(store.getDoc());
    store.emit('saved', { at: Date.now() });
  },
});

// ---- badge streaming ----
//
// The transport drives it: pressing play starts the stream, stopping stops it.
// Without this the Badges card could adopt and map a badge and then send it
// absolutely nothing, which is exactly how it behaved before.
const badgeStream = createBadgeStream({ client: getBadgeClient(), store });

engine.on('playstate', ({ playing, fromTick }) => {
  if (playing) {
    const doc = store.getDoc();
    badgeStream.start(tickToSeconds(doc, fromTick || 0) * 1000);
  } else {
    badgeStream.stop();
  }
});

// Live mode mirrors the engine's own scheduling decisions rather than making
// its own, so the badges play the performance the speakers are playing.
engine.on('scheduled', (ev) => badgeStream.onEngineEvents([ev]));

// Auditioning: a note played by hand in the roll sounds on every badge too.
// Hooked to the engine rather than to the roll because ten call sites across
// the roll, the keymap and three tool cards all audition through it.
engine.on('preview', ({ notes }) => badgeStream.preview(notes));

initStatusBar({ store, uiStore, conflicts, roll, engine });
// The sidebar builds its cards from js/ui/tools/manifest.js and imports a
// tool's module only when its card first opens.
// badgeStream goes in so the Badges card can offer the live/scheduled switch:
// the stream owns that decision, and two places holding it would drift.
const toolsPanel = initToolsPanel({ store, uiStore, engine, roll, badgeStream });
initTracksPanel({
  store,
  uiStore,
  onInstrumentPicker: (trackId) => {
    // The Instrument card edits the active track, so picking an instrument
    // for a row focuses that row too - otherwise the sidebar would show one
    // track's sound while you edited another's.
    if (store.getDoc().activeTrackId !== trackId) {
      store.commit('switch track', ['tracks'], (d) => {
        d.activeTrackId = trackId;
      });
    }
    toolsPanel.reveal('instrument');
  },
  onImportTracks: () => {
    trackImportInput.value = '';
    trackImportInput.click();
  },
});
initKeymap({ store, uiStore, engine, roll, conflicts, actions });
initPanelResizers();

// ---- boot ----
// Returning users land directly in their most recently edited project;
// brand-new users get the bundled demo projects (demos/ subfolder) seeded
// into "Recent projects" and are greeted with the start page.
async function boot() {
  try {
    demos = await loadDemos();
    // older builds copied demos into storage - drop those stale copies
    purgeSeededDemos(demos.map((d) => d.id));
  } catch (err) {
    console.warn('demos unavailable:', err);
  }
  // Resume the LAST-OPENED project (viewing counts as "where I left off").
  const resumeId = lastOpenId() || (listProjects()[0] || {}).id || null;
  if (resumeId) {
    const doc = loadProject(resumeId);
    if (doc) {
      openProject(doc);
      return;
    }
  }
  startScreen.render();
  showScreen('start');
}
boot();

// Console/debugging handle (also used by the smoke tests).
window.__chipseq = { store, uiStore, engine, conflicts, openProject };
