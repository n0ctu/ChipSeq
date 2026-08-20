// The commands table: one entry per action that has both a shortcut and a
// button, or that belongs in the palette.
//
// These used to be defined twice - once in toolbar.js as a click handler and
// once in keymap.js as a switch case - so a shortcut and its button could
// drift apart, and nothing could enumerate what the app can do. One array
// fixes all three: the toolbar binds to it, the keymap dispatches through it,
// and Ctrl+K lists it.
//
// Deliberately NOT everything. Grid editing - arrows, delete, note nudging,
// snap digits - stays in keymap.js: those are positional, contextual, and
// meaningless as palette entries. A table you have to lie to is worse than
// two honest handlers.

// Keys are written as they are matched: modifiers in a fixed order, then the
// KeyboardEvent `code`. Using code rather than key means the bindings do not
// move when the keyboard layout does.
export const COMMANDS = [
  {
    id: 'play', label: 'Play / stop', keys: ['Space'], button: 'btn-play',
    run: (ctx) => ctx.actions.togglePlay(),
  },
  {
    id: 'pause', label: 'Pause', keys: ['Shift+Space'],
    run: (ctx) => ctx.actions.togglePause(),
  },
  {
    id: 'loop', label: 'Toggle loop', keys: ['KeyL'], button: 'btn-loop',
    run: (ctx) => ctx.actions.toggleLoop(),
  },
  {
    id: 'metronome', label: 'Toggle metronome', keys: ['KeyM'], button: 'btn-metro',
    run: (ctx) => ctx.actions.toggleMetronome(),
  },
  {
    id: 'quantize', label: 'Quantize selection', keys: ['KeyQ'], button: 'btn-quantize',
    run: (ctx) => ctx.actions.quantize(),
  },
  {
    id: 'undo', label: 'Undo', keys: ['Ctrl+KeyZ'], button: 'btn-undo',
    when: (ctx) => ctx.store.canUndo(),
    run: (ctx) => ctx.store.undo(),
  },
  {
    id: 'redo', label: 'Redo', keys: ['Ctrl+Shift+KeyZ', 'Ctrl+KeyY'], button: 'btn-redo',
    when: (ctx) => ctx.store.canRedo(),
    run: (ctx) => ctx.store.redo(),
  },
  {
    id: 'export', label: 'Export…', keys: ['Ctrl+KeyE'], button: 'btn-export',
    run: (ctx) => ctx.actions.openExport(),
  },
  {
    id: 'save', label: 'Save now', keys: ['Ctrl+KeyS'],
    run: (ctx) => ctx.actions.forceSave(),
  },
  {
    id: 'trim-before', label: 'Trim before cursor', keys: ['Ctrl+BracketLeft'],
    run: (ctx) => ctx.actions.trimBefore(),
  },
  {
    id: 'trim-after', label: 'Trim after cursor', keys: ['Ctrl+BracketRight'],
    run: (ctx) => ctx.actions.trimAfter(),
  },
  {
    id: 'next-conflict', label: 'Jump to next overlap', keys: ['KeyN'],
    when: (ctx) => ctx.conflicts && ctx.conflicts.count() > 0,
    run: (ctx) => ctx.jumpToConflict(),
  },
  {
    id: 'panel-tracks', label: 'Show/hide the tracks panel', keys: ['KeyT'],
    run: (ctx) => {
      ctx.uiStore.update('view', (s) => { s.panels.tracks = !s.panels.tracks; });
      ctx.actions.applyPanels();
    },
  },
  {
    id: 'home', label: 'Back to the start page', button: 'btn-home',
    run: (ctx) => ctx.goHome(),
  },
];

// The event, written the way `keys` is written. Letters go by e.key - what
// the keycap SAYS - not e.code, which names the key's position on a US
// board. On QWERTZ (the Swiss and German layouts) Z and Y trade places, so
// code-based matching swapped undo and redo: the key labeled Z arrived as
// KeyY and "Ctrl+Z does nothing" was Ctrl+Z faithfully running a redo on an
// empty stack. Non-letter keys keep their codes; those name positions on
// purpose.
export function chordOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  parts.push(/^[a-z]$/i.test(e.key) ? 'Key' + e.key.toUpperCase() : e.code);
  return parts.join('+');
}

export function commandForChord(chord) {
  return COMMANDS.find((c) => (c.keys || []).includes(chord)) || null;
}

export function commandById(id) {
  return COMMANDS.find((c) => c.id === id) || null;
}

export function available(ctx) {
  return COMMANDS.filter((c) => !c.when || c.when(ctx));
}

// Run a command if its guard allows. Returns whether it ran, so the keymap
// can tell "handled" from "fall through to the editing keys".
export function runCommand(cmd, ctx) {
  if (!cmd || (cmd.when && !cmd.when(ctx))) return false;
  cmd.run(ctx);
  return true;
}

// Two commands sharing a chord is a bug that used to be invisible - one
// handler would simply win. An array can be checked, so it is, at startup.
export function duplicateChords() {
  const seen = new Map();
  const clashes = [];
  for (const cmd of COMMANDS) {
    for (const chord of cmd.keys || []) {
      if (seen.has(chord)) clashes.push(`${chord}: ${seen.get(chord)} and ${cmd.id}`);
      else seen.set(chord, cmd.id);
    }
  }
  return clashes;
}
