// The tool registry: one entry per card in the right sidebar.
//
// Adding a tool is one file plus one entry here. Nothing looks a tool up by
// string - the panel iterates this array - so a typo is a missing card at
// load time rather than a card that silently renders nothing.
//
// Three functions per tool, and the split between them matters:
//
//   when(ctx)   is this tool applicable at all? false hides the card.
//   status(ctx) what does its indicator say? MUST be cheap and pure: it runs
//               for COLLAPSED cards on every relevant change, which is the
//               whole point - a closed card still tells you whether the tool
//               is in play. It therefore lives here, not in the tool module,
//               so nothing has to be loaded to answer it.
//   load()      the only dynamic import. Runs on first expand, never before.
//
// status() returns { on, label }:
//   on    - the tool is actually configured//in effect here. Drives the dot,
//           and (while the user has not said otherwise) whether the card
//           starts open.
//   label - short context line, shown open or closed.

import { activeTrack, getTrack } from '../../core/doc.js';

// Selected notes, computed straight from the stores. Deliberately not routed
// through roll.interactions so status() has no dependency on the piano roll
// having been created yet.
function selectedNotes(ctx) {
  const doc = ctx.store.getDoc();
  const ui = ctx.uiStore.state;
  const track = getTrack(doc, ui.selectionTrackId || doc.activeTrackId);
  if (!track) return [];
  return track.notes.filter((n) => ui.selection.has(n.id));
}

// The track the Transpose tool would act on: the selection, else the whole
// active track.
function transposeScope(ctx) {
  const notes = selectedNotes(ctx);
  if (notes.length) return { label: `${notes.length} note${notes.length === 1 ? '' : 's'}` };
  const track = activeTrack(ctx.store.getDoc());
  if (track && track.notes.length) return { label: `whole “${track.name}”` };
  return null;
}

export const TOOLS = [
  {
    id: 'harmonics',
    name: 'Harmonics',
    when: (ctx) => selectedNotes(ctx).length > 0,
    status: (ctx) => {
      const notes = selectedNotes(ctx);
      const decorated = notes.filter((n) => n.harmonics).length;
      return {
        on: decorated > 0,
        label: decorated
          ? `${decorated}/${notes.length} arp`
          : `${notes.length} note${notes.length === 1 ? '' : 's'}`,
      };
    },
    load: () => import('./harmonics.js'),
  },
  {
    id: 'transpose',
    name: 'Transpose',
    when: (ctx) => !!transposeScope(ctx),
    // Stateless: it performs an action and keeps nothing, so there is never
    // anything to light up - it just says what it would act on, and stays
    // closed until asked for.
    status: (ctx) => ({ on: false, label: (transposeScope(ctx) || {}).label || '' }),
    load: () => import('./transpose.js'),
  },
  {
    id: 'instrument',
    name: 'Instrument',
    when: (ctx) => {
      const doc = ctx.store.getDoc();
      return doc.mode === 'poly' && !!getTrack(doc, ctx.uiStore.state.instrumentTrackId);
    },
    status: (ctx) => {
      const doc = ctx.store.getDoc();
      const track = getTrack(doc, ctx.uiStore.state.instrumentTrackId);
      if (!track) return { on: false, label: '' };
      const custom = !!track.instrument;
      const inst = custom
        ? track.instrument
        : doc.instruments.find((i) => i.id === track.instrumentId) || doc.instruments[0];
      return { on: custom, label: `${track.name} - ${custom ? 'Custom' : inst.name}` };
    },
    load: () => import('./instrument.js'),
  },
];

// Ids are used as storage keys for fold state and as reveal() targets, so a
// duplicate would make one tool shadow another. Cheap to check, impossible to
// debug later.
const seen = new Set();
for (const tool of TOOLS) {
  if (seen.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
  seen.add(tool.id);
}
