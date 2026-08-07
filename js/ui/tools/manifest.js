// The tool registry: one entry per card in the right sidebar.
//
// Every load() carries ?v=APP_VERSION. GitHub Pages serves JS with
// cache-control: max-age=600, and these modules are fetched LAZILY - long
// after the page loaded - so a visitor can hold a fresh main.js next to a
// tool card from the previous release for up to ten minutes. Tagging the URL
// makes a release invalidate every lazily-loaded module at once: main.js is
// what carries the new version string, so the moment it is fresh, so is
// everything it asks for.
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

import { APP_VERSION } from '../../core/version.js';
import { activeTrack, getTrack, trackGain, trackPan, DEFAULT_INSTRUMENTS } from '../../core/doc.js';
import { DEFAULT_NORMALIZE, normalizeConfig } from '../../core/normalize.js';

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
    load: () => import(`./harmonics.js?v=${APP_VERSION}`),
  },
  {
    id: 'transpose',
    name: 'Transpose',
    when: (ctx) => !!transposeScope(ctx),
    // Stateless: it performs an action and keeps nothing, so there is never
    // anything to light up - it just says what it would act on, and stays
    // closed until asked for.
    status: (ctx) => ({ on: false, label: (transposeScope(ctx) || {}).label || '' }),
    load: () => import(`./transpose.js?v=${APP_VERSION}`),
  },
  {
    id: 'mixer',
    name: 'Mixer',
    // Poly only: mono plays one voice, so there is nothing to balance.
    when: (ctx) => ctx.store.getDoc().mode === 'poly' && ctx.store.getDoc().tracks.length > 0,
    status: (ctx) => {
      const tracks = ctx.store.getDoc().tracks;
      const touched = tracks.filter((t) => trackGain(t) !== 1 || trackPan(t) !== 0 || t.solo);
      const solo = tracks.filter((t) => t.solo).length;
      return {
        on: touched.length > 0,
        label: solo
          ? `${solo} soloed`
          : touched.length
            ? `${touched.length} adjusted`
            : `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
      };
    },
    load: () => import(`./mixer.js?v=${APP_VERSION}`),
  },
  {
    id: 'effects',
    name: 'Effects',
    // Poly only: mono is the badge voice, and .h/.fmf carry no effects, so
    // there is nothing here that a mono project could use.
    when: (ctx) => ctx.store.getDoc().mode === 'poly',
    status: (ctx) => {
      const doc = ctx.store.getDoc();
      const list = Array.isArray(doc.buses) ? doc.buses : [];
      const sending = doc.tracks.filter((t) => Array.isArray(t.sends) && t.sends.length).length;
      if (!list.length) return { on: false, label: 'none' };
      return {
        on: sending > 0,
        label: sending
          ? `${sending} track${sending === 1 ? '' : 's'} sending`
          : `${list.length} bus${list.length === 1 ? '' : 'es'}, unused`,
      };
    },
    load: () => import(`./effects.js?v=${APP_VERSION}`),
  },
  {
    id: 'levels',
    name: 'Levels',
    when: (ctx) => ctx.store.getDoc().mode === 'poly',
    // Same rule as every other card: at defaults there is nothing to look at,
    // so it stays collapsed. Deliberately does NOT flatten the song to report
    // a peak here - status() runs on every change, and flattening Bad Apple
    // takes ~150 ms. The readout lives in the body, where it is only computed
    // while the card is actually open.
    status: (ctx) => {
      const doc = ctx.store.getDoc();
      const cfg = normalizeConfig(doc);
      const tuned = ['enabled', 'song', 'track', 'smoothMs'].filter((k) => cfg[k] !== DEFAULT_NORMALIZE[k]);
      const optedOut = doc.tracks.filter((t) => t.normalize !== undefined).length;
      if (!cfg.enabled) return { on: true, label: 'off' };
      return {
        on: tuned.length > 0 || optedOut > 0,
        label: optedOut
          ? `${optedOut} track${optedOut === 1 ? '' : 's'} excluded`
          : tuned.length
            ? `${cfg.song.toFixed(2)} / ${cfg.track.toFixed(2)}`
            : 'default',
      };
    },
    load: () => import(`./levels.js?v=${APP_VERSION}`),
  },
  {
    id: 'instrument',
    name: 'Instrument',
    // Always available in poly - there is always an active track, and the
    // card costs nothing while collapsed. It edits the ACTIVE track, so it
    // follows the editing focus rather than a separate "which one did I last
    // pick for" pointer.
    when: (ctx) => {
      const doc = ctx.store.getDoc();
      return doc.mode === 'poly' && !!activeTrack(doc);
    },
    // "In play" means the sound has been taken somewhere of its own: either
    // fine-tuned into a Custom config, or switched to a saved preset. The
    // three stock instruments are the baseline, so a track using one has
    // nothing to show and the card stays out of the way.
    status: (ctx) => {
      const doc = ctx.store.getDoc();
      const track = activeTrack(doc);
      if (!track) return { on: false, label: '' };
      const custom = !!track.instrument;
      const inst = custom
        ? track.instrument
        : doc.instruments.find((i) => i.id === track.instrumentId) || doc.instruments[0];
      const stock = DEFAULT_INSTRUMENTS.some((i) => i.id === track.instrumentId);
      return { on: custom || !stock, label: `${track.name} - ${custom ? 'Custom' : inst.name}` };
    },
    load: () => import(`./instrument.js?v=${APP_VERSION}`),
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
