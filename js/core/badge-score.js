// One track, reduced to what a badge can play.
//
// A badge has a single square-wave voice and plays a flat sequence of
// {pitch, ms} - the same shape js/core/export-h.js writes into a .h file. So
// this produces that same sequence, from the same flattened events, using the
// same monophony rule and the same rounding.
//
// That sameness is the point. If a badge played a track differently from the
// file the exporter writes for it, one of them would be lying, and there
// would be no way to tell which. tests/unit.mjs asserts they agree note for
// note and millisecond for millisecond.
//
// Pure, and therefore in core: it decides what the music IS. Sending it lives
// in js/net/, which is I/O.

import { flattenSong, enforceMonophony } from './flatten.js';
import { tickToSeconds } from './doc.js';

// Rest pitch on the wire. The protocol says 0 means silence, and MIDI 0 is
// C-1 - five octaves below anything a badge can produce - so the collision is
// theoretical.
export const REST = 0;

// [{ pitch, startMs, durMs }] for one track, rests included, from tick 0.
//
// Rests are explicit rather than implied by gaps because the badge plays a
// list: it has no concept of "wait until". This matches the .h layout.
// trimLead drops silence before the first note and rebases to 0. Off by
// default, and the difference matters:
//
//   streaming  - the badge shares the sequencer's timeline, so 1.4 s of
//                silence before the first note must BE 1.4 s of silence, or
//                the badge comes in early.
//   .h export  - a standalone file starts when you press play, so the
//                exporter skips that silence. Same music, different origin.
//
// Passing true here reproduces the exporter exactly, which is how the two are
// tested against each other.
export function badgeScore(doc, trackId, { events = null, includeRests = true, trimLead = false } = {}) {
  const all = events || flattenSong(doc).events;
  const mine = all.filter((e) => e.trackId === trackId);
  // Already sorted by flattenSong; enforceMonophony relies on that.
  const mono = enforceMonophony(mine.map((e) => ({ ...e })));

  // Absolute boundary times, then subtract - so rounding error cannot
  // accumulate across a long song. Rounding each duration independently
  // would drift, which on a three-minute piece is audible.
  const msAt = (tick) => Math.round(tickToSeconds(doc, tick) * 1000);

  const out = [];
  // Where the timeline starts: 0 for streaming, the first onset when trimmed.
  const origin = trimLead && mono.length ? msAt(mono[0].startTick) : 0;
  let cursor = origin;
  for (const ev of mono) {
    const start = msAt(ev.startTick);
    const end = msAt(ev.startTick + ev.durationTicks);
    if (includeRests && start > cursor) {
      out.push({ pitch: REST, startMs: cursor - origin, durMs: start - cursor });
    }
    if (end > start) out.push({ pitch: ev.pitch, startMs: start - origin, durMs: end - start });
    cursor = Math.max(cursor, end);
  }
  return out;
}

// The slice of a score that starts within [fromMs, toMs).
//
// Selected by START time, not by overlap: a note already sounding when the
// window opens was sent with the previous chunk, and sending it again would
// retrigger it.
export function sliceScore(score, fromMs, toMs) {
  return score.filter((n) => n.startMs >= fromMs && n.startMs < toMs);
}

// A `sched` frame's payload: [[offsetMs, pitch, durMs], ...] relative to t0.
export function toSchedNotes(slice, originMs) {
  return slice.map((n) => [n.startMs - originMs, n.pitch, n.durMs]);
}

// Total length, so a player knows when a track is done.
export function scoreLengthMs(score) {
  return score.length ? score[score.length - 1].startMs + score[score.length - 1].durMs : 0;
}
