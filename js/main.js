// Boot: create stores + engine, wire all UI components. The only place the
// core and UI layers are composed.

import { createProject, applyImport, PPQ } from './core/doc.js';
import { createStore } from './core/store.js';
import {
  attachAutosave, saveProject, importTuneJson, listProjects, loadProject,
  demosSeeded, markDemosSeeded,
} from './core/persist.js';
import { createEngine } from './core/engine.js';
import { parseMidi } from './core/midi-import.js';

import { createUiStore } from './ui/ui-store.js';
import { initStartScreen } from './ui/start-screen.js';
import { initPianoRoll } from './ui/piano-roll/piano-roll.js';
import { initToolbar } from './ui/toolbar.js';
import { initStatusBar } from './ui/status-bar.js';
import { initTracksPanel } from './ui/tracks-panel.js';
import { initHarmonicsPanel } from './ui/harmonics-panel.js';
import { initKeymap } from './ui/keymap.js';
import { initExportDialog } from './ui/export-dialog.js';
import { midiImportDialog } from './ui/midi-import-dialog.js';
import { createConflicts } from './ui/conflicts.js';
import { initPanelResizers } from './ui/panel-resize.js';

const store = createStore(createProject());
const uiStore = createUiStore();
const engine = createEngine(store);
const conflicts = createConflicts(store);
const flushSave = attachAutosave(store);

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

function openProject(doc) {
  engine.stop();
  store.setDoc(doc);
  uiStore.update('selection', (s) => {
    s.selection.clear();
    s.selectionTrackId = doc.activeTrackId;
    s.scrollTick = 0;
  });
  saveProject(doc);
  showScreen('editor');
}

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
      const doc = importTuneJson(await file.text());
      openProject(doc);
    } else {
      alert('Unsupported file type — drop a .mid or .tune.json file.');
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
    showScreen('start');
  },
  forceSave: () => {
    saveProject(store.getDoc());
    store.emit('saved', { at: Date.now() });
  },
});

initStatusBar({ store, uiStore, conflicts, roll });
initTracksPanel({ store, uiStore });
initHarmonicsPanel({ store, uiStore, roll, engine });
initKeymap({ store, uiStore, engine, roll, conflicts, actions });
initPanelResizers();

// ---- boot ----
// Returning users land directly in their most recently edited project;
// brand-new users get the bundled demo projects (demos/ subfolder) seeded
// into "Recent projects" and are greeted with the start page.
async function seedDemos() {
  const files = await (await fetch('demos/index.json')).json();
  const docs = [];
  for (const file of files) {
    try {
      const doc = importTuneJson(await (await fetch('demos/' + file)).text());
      saveProject(doc);
      docs.push(doc);
    } catch (err) {
      console.warn('demo import failed:', file, err);
    }
  }
  return docs;
}

async function boot() {
  const recent = listProjects()[0];
  if (recent) {
    const doc = loadProject(recent.id);
    if (doc) {
      openProject(doc);
      return;
    }
  }
  if (!demosSeeded()) {
    try {
      await seedDemos();
      markDemosSeeded();
    } catch (err) {
      console.warn('demo projects unavailable:', err);
    }
  }
  showScreen('start');
}
boot();

// Console/debugging handle (also used by the smoke tests).
window.__chipseq = { store, uiStore, engine, conflicts, openProject };
