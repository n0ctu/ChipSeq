// Mono-mode overlap detection with caching + auto-fix + cycling navigation.

import { melodyTrack, findOverlaps, autoFixOverlaps } from '../core/doc.js';

export function createConflicts(store) {
  let cached = null;

  function invalidate() {
    cached = null;
  }
  store.subscribe(['notes', 'tracks', 'song', 'doc'], invalidate);

  function compute() {
    if (cached) return cached;
    const doc = store.getDoc();
    if (doc.mode !== 'mono') {
      cached = { ids: new Set(), ticks: [] };
      return cached;
    }
    const track = melodyTrack(doc);
    const ids = track ? findOverlaps(track) : new Set();
    const ticks = [];
    if (track) {
      for (const n of track.notes) {
        if (ids.has(n.id)) ticks.push(n.startTick);
      }
    }
    cached = { ids, ticks: [...new Set(ticks)].sort((a, b) => a - b) };
    return cached;
  }

  return {
    ids: () => compute().ids,
    ticks: () => compute().ticks,
    count: () => compute().ids.size,

    // Next conflict tick strictly after `fromTick`, wrapping around.
    nextTick(fromTick) {
      const ticks = compute().ticks;
      if (!ticks.length) return null;
      return ticks.find((t) => t > fromTick) ?? ticks[0];
    },

    autoFix() {
      store.commit('auto-fix overlaps', ['notes'], (doc) => {
        const track = melodyTrack(doc);
        if (track) autoFixOverlaps(track);
      });
    },
  };
}
