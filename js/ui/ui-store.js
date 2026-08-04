// Ephemeral UI state — never persisted, never undoable.

import { createEmitter } from '../core/store.js';
import { PPQ } from '../core/music.js';

export function createUiStore() {
  const emitter = createEmitter();

  const state = {
    screen: 'start', // 'start' | 'editor'
    selection: new Set(), // note ids on the active/edited track
    selectionTrackId: null,
    gridCursor: { tick: 0, pitch: 69 },
    scrollTick: 0, // leftmost visible tick
    scrollPitch: 84, // topmost visible pitch (higher = up)
    pxPerTick: 0.5, // horizontal zoom
    rowHeight: 14,
    snapTicks: PPQ / 2, // 1/8 note by default
    triplet: false,
    lastNoteLen: PPQ / 2,
    panels: { tracks: true, harmonics: true },
  };

  return {
    state,
    // update(scope, fn) — mutate state, notify subscribers of scope.
    update(scope, fn) {
      fn(state);
      emitter.emit('ui', { scope });
    },
    subscribe(scopes, cb) {
      const want = new Set(scopes);
      return emitter.on('ui', (ev) => {
        if (want.has(ev.scope)) cb(ev);
      });
    },
  };
}
