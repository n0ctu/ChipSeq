// Imports every ES module to catch syntax/binding errors.
// Run: node tests/check.mjs
// to catch syntax errors and broken import bindings.
const base = new URL('../js/', import.meta.url).href;
const modules = [
  'core/version.js', 'core/music.js', 'core/doc.js', 'core/store.js',
  'core/persist.js', 'core/harmonics.js', 'core/flatten.js', 'core/instruments.js',
  'core/engine.js', 'core/midi-import.js', 'core/export-wav.js', 'core/export-h.js', 'core/automation.js',
  'core/export-fmf.js', 'core/graph.js', 'core/units.js', 'core/modulation.js',
  'ui/ui-store.js', 'ui/dialogs.js', 'ui/conflicts.js', 'ui/trimmer.js',
  'ui/piano-roll/coords.js', 'ui/piano-roll/render.js', 'ui/piano-roll/interactions.js',
  'ui/piano-roll/automation-lane.js',
  'ui/piano-roll/piano-roll.js', 'ui/keymap.js', 'ui/toolbar.js', 'ui/status-bar.js',
  'ui/start-screen.js', 'ui/tracks-panel.js',
  // every tool the manifest can load must import cleanly, or a broken tool
  // would only surface as an empty card at runtime
  'ui/tools-panel.js', 'ui/tools/manifest.js', 'ui/palette.js', 'ui/commands.js',
  'core/exporters.js', 'core/effects.js', 'ui/tools/effects.js',
  'core/badge-score.js', 'net/badges.js', 'net/badge-stream.js', 'ui/tools/badges.js',
  'ui/tools/harmonics.js', 'ui/tools/transpose.js', 'ui/tools/instrument.js',
  'ui/tools/envelope-editor.js', 'ui/tools/mixer.js', 'ui/tools/levels.js',
  'core/normalize.js',
  'ui/midi-import-dialog.js', 'ui/export-dialog.js',
  'ui/icons.js', 'ui/panel-resize.js', 'ui/trimmer.js',
];
let failed = 0;
for (const m of modules) {
  try {
    await import(base + m);
    console.log('OK  ', m);
  } catch (err) {
    failed++;
    console.log('FAIL', m, '-', err.message);
  }
}
process.exit(failed ? 1 : 0);
