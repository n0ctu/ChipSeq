// The single pipeline that turns the document into concrete playable events.
// Live playback, WAV export, .h export and piano-roll ghosts all go through here,
// which is what guarantees preview === export === badge.

import { renderHarmonics, resolveChord } from './harmonics.js';
import {
  unmutedTracks, playableTracks, soloActive, getTrack, getNote, findOverlaps, ticksPerBar,
  trackPan, tickToSeconds,
} from './doc.js';
import { sampleAutomation, sampleGainCurve, quantizeDuty, AUTOMATION_PARAMS } from './automation.js';
import { applyNormalization } from './normalize.js';

// Segment the chords track into a timeline of chord EVENTS that hold until
// the next change (like a DAW chord track). Sampling "what sounds at exactly
// this tick" breaks on staccato/arpeggiated chord tracks - a melody note
// starting in a gap would silently lose its chord.
export function buildChordEvents(doc, trackId = doc.chordTrackId) {
  const track = trackId ? getTrack(doc, trackId) : null;
  if (!track || !track.notes.length) return [];
  const notes = track.notes;

  // Change points: quantized note starts (merges slightly-loose MIDI timing).
  const q = Math.max(1, Math.round(doc.ppq / 8)); // 1/32 note
  const starts = [...new Set(notes.map((n) => Math.round(n.startTick / q) * q))].sort((a, b) => a - b);
  const tpBar = ticksPerBar(doc);

  const events = [];
  for (const start of starts) {
    // Stack: notes starting here (quantized together) plus notes still held.
    const stack = new Set();
    for (const n of notes) {
      if (Math.abs(n.startTick - start) < q || (n.startTick <= start && start < n.startTick + n.durationTicks)) {
        stack.add(n.pitch % 12);
      }
    }
    let pcs = stack;
    if (stack.size < 2) {
      // Single note at this change point: the chord is probably played broken
      // (arpeggiated accompaniment) - gather the whole figure of the bar this
      // point falls in, so A-C-E eighths resolve to Am, not three "chords".
      const barStart = Math.floor(start / tpBar) * tpBar;
      pcs = new Set(stack);
      for (const n of notes) {
        if (n.startTick >= barStart && n.startTick < barStart + tpBar) pcs.add(n.pitch % 12);
      }
    }
    if (!pcs.size) continue;
    const prev = events[events.length - 1];
    const list = [...pcs].sort((a, b) => a - b);
    // Merge consecutive identical chords into one held event.
    if (prev && prev.pcs.length === list.length && prev.pcs.every((p, i) => p === list[i])) continue;
    events.push({ startTick: start, pcs: list });
  }
  return events;
}

export function makeChordLookup(doc, trackId = doc.chordTrackId) {
  const events = buildChordEvents(doc, trackId);
  if (!events.length) return () => null;
  // Last event at or before the tick holds (chord persists until the next).
  return (tick) => {
    let lo = 0;
    let hi = events.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].startTick <= tick) {
        best = events[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best ? best.pcs : null;
  };
}

export function makeArpContext(doc) {
  const chordTrack = doc.chordTrackId ? getTrack(doc, doc.chordTrackId) : null;
  // Per-track chord lookups are built lazily and cached for this context -
  // notes may reference any track as their chord source.
  const lookups = new Map();
  const lookupFor = (trackId) => {
    if (!lookups.has(trackId)) lookups.set(trackId, makeChordLookup(doc, trackId));
    return lookups.get(trackId);
  };
  return {
    ppq: doc.ppq,
    key: doc.song.key,
    getChordPitchClassesAt: (tick) => (doc.chordTrackId ? lookupFor(doc.chordTrackId)(tick) : null),
    getChordPitchClassesFromTrack: (trackId, tick) => lookupFor(trackId)(tick),
    getTrackName: (trackId) => {
      const t = getTrack(doc, trackId);
      return t ? t.name : null;
    },
    hasChordTrack: !!(chordTrack && chordTrack.notes.length),
  };
}

// Clip flattened events to [startTick, endTick) and rebase them to 0 -
// used by the exporters' "loop region only" option. Notes crossing a
// boundary are truncated so the region's total length stays exact.
export function clipEventsToRegion(events, startTick, endTick) {
  const out = [];
  for (const ev of events) {
    const s = Math.max(ev.startTick, startTick);
    const e = Math.min(ev.startTick + ev.durationTicks, endTick);
    if (e <= s) continue;
    out.push({ ...ev, startTick: s - startTick, durationTicks: e - s });
  }
  return out;
}

// Transparency helper for the UI: what chord does this note's arp resolve to,
// where did it come from, and did any fallback kick in?
export function explainNoteChord(doc, trackId, noteId) {
  const note = getNote(doc, trackId, noteId);
  if (!note || !note.harmonics) return null;
  return resolveChord(note, note.harmonics, makeArpContext(doc));
}

// Render one note's events (used for ghost display and per-note preview).
export function flattenNote(doc, trackId, noteId) {
  const note = getNote(doc, trackId, noteId);
  if (!note) return [];
  const ctx = makeArpContext(doc);
  if (doc.mode === 'mono' && note.harmonics && note.harmonics.mode === 'chord') {
    // Chord decorations are rejected in mono; render as plain note.
    return [{ pitch: note.pitch, startTick: note.startTick, durationTicks: note.durationTicks, velocity: note.velocity }];
  }
  return renderHarmonics(note, ctx);
}

// flattenSong(doc) -> { events: [{pitch,startTick,durationTicks,velocity,instrumentId}], warnings: [] }
// Mono mode: only the active track, badge instrument forced, overlaps truncated
// (earlier note cut at the later note's start - matches firmware semantics).

export function flattenSong(doc) {
  const ctx = makeArpContext(doc);
  const warnings = [];
  const events = [];

  // Everything UNMUTED is rendered, including tracks that solo will silence
  // in a moment. Levels has to weigh the whole piece: a soloed track must
  // preview at the level it has in the mix, not at the louder level it would
  // reach with the others removed. Solo is applied after normalization, below.
  for (const track of unmutedTracks(doc)) {
    const instrumentId =
      doc.mode === 'mono' ? 'badge' : track.instrument ? 'track:' + track.id : track.instrumentId;

    // Automation lanes (poly only): sampled per rendered event, AFTER
    // harmonics expansion so every arp step reads the curve independently.
    const auto = doc.mode === 'poly' ? track.automation : null;
    const gainLane = auto && auto.gain && auto.gain.length ? auto.gain : null;
    const dutyLane = auto && auto.duty && auto.duty.length ? auto.duty : null;
    const panLane = auto && auto.pan && auto.pan.length ? auto.pan : null;
    const adsrLanes = [];
    if (auto) {
      for (const [param, meta] of Object.entries(AUTOMATION_PARAMS)) {
        if (meta.adsrKey && auto[param] && auto[param].length) adsrLanes.push([meta.adsrKey, auto[param]]);
      }
    }

    for (const note of track.notes) {
      let rendered;
      if (doc.mode === 'mono' && note.harmonics && note.harmonics.mode === 'chord') {
        warnings.push({ type: 'chord-in-mono', noteId: note.id, trackId: track.id });
        rendered = [{ pitch: note.pitch, startTick: note.startTick, durationTicks: note.durationTicks, velocity: note.velocity }];
      } else {
        rendered = renderHarmonics(note, ctx);
      }
      for (const ev of rendered) {
        const extra = {};
        if (gainLane) {
          Object.assign(extra, sampleGainCurve(gainLane, ev.startTick, ev.startTick + ev.durationTicks, 1));
        }
        if (dutyLane) {
          const d = sampleAutomation(dutyLane, ev.startTick, NaN);
          if (!Number.isNaN(d)) extra.duty = quantizeDuty(d);
        }
        // A pan lane makes position per-event, so the voice pans itself and
        // the track's static pan steps aside (same rule as every other lane:
        // the lane overrides the static value rather than stacking with it).
        if (panLane) extra.pan = sampleAutomation(panLane, ev.startTick, trackPan(track));
        if (adsrLanes.length) {
          const adsr = {};
          for (const [key, lane] of adsrLanes) {
            const v = sampleAutomation(lane, ev.startTick, NaN);
            if (!Number.isNaN(v)) adsr[key] = v;
          }
          if (Object.keys(adsr).length) extra.adsr = adsr;
        }
        // Fine pitch in cents, carried per event so every arp step inherits
        // it. Only attached when actually set, so a document without detune
        // flattens to exactly the same stream it always did.
        if (note.detune) extra.detune = note.detune;
        if (note.lfo) extra.lfo = note.lfo;
        events.push({ ...ev, trackId: track.id, instrumentId, noteId: note.id, ...extra });
      }
    }
  }

  events.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);

  if (doc.mode === 'mono') {
    const track = playableTracks(doc)[0];
    if (track) {
      for (const id of findOverlaps(track)) {
        warnings.push({ type: 'overlap', noteId: id, trackId: track.id });
      }
    }
    // Enforce monophony on the flattened events themselves.
    for (let i = 0; i < events.length - 1; i++) {
      const cur = events[i];
      const next = events[i + 1];
      const end = cur.startTick + cur.durationTicks;
      if (next.startTick < end) {
        cur.durationTicks = Math.max(0, next.startTick - cur.startTick);
      }
    }
    // Simultaneous starts: keep the higher pitch (last after sort), drop the rest.
    const filtered = [];
    for (const ev of events) {
      const prev = filtered[filtered.length - 1];
      if (prev && prev.startTick === ev.startTick) {
        filtered[filtered.length - 1] = ev; // higher pitch wins (sorted by pitch)
        continue;
      }
      if (ev.durationTicks > 0) filtered.push(ev);
    }
    return { events: filtered, warnings };
  }

  // Polyphony normalization runs LAST, on the finished stream: it needs to
  // know what is actually sounding together, which is only true once
  // harmonics have expanded and the automation lanes have been sampled.
  // Poly only - mono returned above, so badge output is untouched.
  applyNormalization(doc, events, (tick) => tickToSeconds(doc, tick));

  // Solo last: it decides what you HEAR, not what the piece is, so it must
  // not have been able to influence the levels computed above.
  if (soloActive(doc)) {
    const heard = new Set(doc.tracks.filter((t) => t.solo && t.role !== 'muted').map((t) => t.id));
    return { events: events.filter((e) => heard.has(e.trackId)), warnings };
  }

  return { events, warnings };
}
