// Imports every ES module to catch syntax/binding errors.
// Run: node tests/check.mjs
// to catch syntax errors and broken import bindings.
const base = new URL('../js/', import.meta.url).href;
const modules = [
  'core/version.js', 'core/music.js', 'core/doc.js', 'core/store.js',
  'core/persist.js', 'core/harmonics.js', 'core/flatten.js', 'core/instruments.js',
  'core/engine.js', 'core/midi-import.js', 'core/export-wav.js', 'core/export-h.js',
  'ui/ui-store.js', 'ui/dialogs.js', 'ui/conflicts.js', 'ui/trimmer.js',
  'ui/piano-roll/coords.js', 'ui/piano-roll/render.js', 'ui/piano-roll/interactions.js',
  'ui/piano-roll/piano-roll.js', 'ui/keymap.js', 'ui/toolbar.js', 'ui/status-bar.js',
  'ui/start-screen.js', 'ui/tracks-panel.js', 'ui/harmonics-panel.js',
  'ui/midi-import-dialog.js', 'ui/export-dialog.js',
  'ui/icons.js', 'ui/sections.js', 'ui/transpose-panel.js', 'ui/instrument-panel.js', 'ui/panel-resize.js', 'ui/trimmer.js',
];
let failed = 0;
for (const m of modules) {
  try {
    await import(base + m);
    console.log('OK  ', m);
  } catch (err) {
    failed++;
    console.log('FAIL', m, '—', err.message);
  }
}
process.exit(failed ? 1 : 0);
