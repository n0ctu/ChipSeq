// Pure arpeggio renderer. No DOM, no audio, no store access.
// renderHarmonics(note, ctx) -> [{pitch, startTick, durationTicks, velocity}]
// ctx = { ppq, key, getChordPitchClassesAt(tick) -> [pc...]|null }

import { diatonicTriadIntervals, mulberry32, hashString, PPQ, chordName, keyName, noteName, PITCH_NAMES } from './music.js';

export const CHORD_TYPES = [
  { id: 'autoSong', label: 'Auto (song chords)' },
  { id: 'autoKey', label: 'Auto (diatonic)' },
  { id: 'major', label: 'Major' },
  { id: 'minor', label: 'Minor' },
  { id: 'power', label: 'Power chord' },
  { id: 'sus4', label: 'Sus4' },
  { id: 'octaves', label: 'Whole octaves' },
];

const FIXED_INTERVALS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  power: [0, 7],
  sus4: [0, 5, 7],
  octaves: [0],
};

// Resolve the chord for a note: intervals (semitones above the note, before
// octave expansion) plus a transparent explanation of what was chosen and why.
// Voicing rule (like FamiTracker's 0xy effect): chord tones are stacked
// upward from the note. The note itself is only included when it IS a chord
// tone — anchoring a non-chord melody note inside the sweep produces the
// semitone clusters that made auto modes sound broken.
//
// For chordType 'autoSong', arp.chordSource refines where the chord comes
// from (the C-marked track is only the RECOMMENDATION):
//   null / undefined  -> the recommended chords track (live)
//   { trackId }       -> analyzed live from that specific track
//   { pcs, label? }   -> a fixed user-defined chord (absolute pitch classes)
export function resolveChord(note, arp, ctx) {
  const type = arp.chordType;
  if (FIXED_INTERVALS[type]) {
    return {
      intervals: FIXED_INTERVALS[type],
      name: type === 'octaves' ? noteName(note.pitch) : chordName(FIXED_INTERVALS[type].map((iv) => (note.pitch + iv) % 12)),
      source: 'fixed',
      detail: null,
    };
  }

  if (type === 'autoSong') {
    const src = arp.chordSource;

    if (src && Array.isArray(src.pcs) && src.pcs.length) {
      return chordFromPcs(note, src.pcs, src.label || chordName(src.pcs), 'custom');
    }

    if (src && src.trackId) {
      const pcs = ctx.getChordPitchClassesFromTrack
        ? ctx.getChordPitchClassesFromTrack(src.trackId, note.startTick)
        : null;
      if (pcs && pcs.length) {
        const res = chordFromPcs(note, pcs, chordName(pcs), 'track');
        res.trackName = ctx.getTrackName ? ctx.getTrackName(src.trackId) : null;
        return res;
      }
      const fallback = resolveRecommended(note, ctx);
      fallback.detail = 'chord source track is missing or empty here — using the recommendation';
      return fallback;
    }

    return resolveRecommended(note, ctx);
  }

  return resolveFromKey(note, ctx);
}

function resolveRecommended(note, ctx) {
  const pcs = ctx.getChordPitchClassesAt ? ctx.getChordPitchClassesAt(note.startTick) : null;
  if (pcs && pcs.length) return chordFromPcs(note, pcs, chordName(pcs), 'song');
  const fromKey = resolveFromKey(note, ctx);
  fromKey.detail = ctx.hasChordTrack
    ? 'no chord found at this position — using the song key'
    : 'no chords track set (mark one with its C button) — using the song key';
  return fromKey;
}

function chordFromPcs(note, pcs, name, source) {
  const rootPc = note.pitch % 12;
  const norm = (pc) => ((pc % 12) + 12) % 12;
  const set = new Set();
  if (pcs.some((pc) => norm(pc) === rootPc)) set.add(0); // note is a chord tone
  for (const pc of pcs) set.add((norm(pc) - rootPc + 12) % 12);
  const intervals = [...set].sort((a, b) => a - b);
  return {
    intervals,
    name,
    source,
    detail: set.has(0) ? null : `${noteName(note.pitch)} is not a chord tone — sweeping ${name} above it`,
  };
}

function resolveFromKey(note, ctx) {
  const diatonic = diatonicTriadIntervals(note.pitch, ctx.key);
  if (diatonic) {
    return {
      intervals: diatonic,
      name: chordName(diatonic.map((iv) => (note.pitch + iv) % 12)),
      source: 'key',
      detail: null,
    };
  }
  // Chromatic note: use the key mode's quality on the note itself (a major
  // key gets a major triad, a minor key a minor triad) — and say so.
  const intervals = ctx.key.mode === 'minor' ? FIXED_INTERVALS.minor : FIXED_INTERVALS.major;
  return {
    intervals,
    name: chordName(intervals.map((iv) => (note.pitch + iv) % 12)),
    source: 'key-chromatic',
    detail: `${PITCH_NAMES[note.pitch % 12]} is not in ${keyName(ctx.key)} — using a ${ctx.key.mode} triad on it`,
  };
}

// Convenience for callers that only need the intervals.
export function chordIntervals(note, arp, ctx) {
  return resolveChord(note, arp, ctx).intervals;
}

// Voice the chord relative to the note. 'above' stacks upward from the note
// (FamiTracker 0xy style); 'below' voices the chord downward so the note is
// the TOP tone — the classic shape for bass-register accompaniment. Octave
// expansion extends in the anchor direction; octaveShift transposes the
// whole voicing (e.g. -1 to drop a sweep into the bass register).
function voicePitches(note, arp, intervals) {
  const below = arp.anchor === 'below';
  const shift = 12 * (arp.octaveShift || 0);
  const pitches = [];
  for (let o = 0; o < (arp.octaves || 1); o++) {
    for (const iv of intervals) {
      const voiced = below ? note.pitch - ((12 - iv) % 12) - 12 * o : note.pitch + iv + 12 * o;
      const p = voiced + shift;
      if (p >= 0 && p <= 127 && !pitches.includes(p)) pitches.push(p);
    }
  }
  pitches.sort((a, b) => a - b);
  return pitches;
}

export function renderHarmonics(note, ctx) {
  const base = {
    pitch: note.pitch,
    startTick: note.startTick,
    durationTicks: note.durationTicks,
    velocity: note.velocity,
  };
  if (!note.harmonics) return [base];

  const arp = note.harmonics;
  const intervals = chordIntervals(note, arp, ctx);
  const pitches = voicePitches(note, arp, intervals);

  if (arp.mode === 'chord') {
    // Simultaneous chord (poly mode) with the same voicing rules.
    return pitches.map((pitch) => ({ ...base, pitch }));
  }

  if (!pitches.length) return [base];

  let sequence;
  switch (arp.pattern) {
    case 'down':
      sequence = [...pitches].reverse();
      break;
    case 'updown': {
      // ascending then descending, no double-hit at either turnaround
      const down = pitches.slice(1, -1).reverse();
      sequence = pitches.concat(down);
      break;
    }
    case 'random':
      sequence = null; // picked per step below, seeded by note id
      break;
    default:
      sequence = pitches;
  }

  const ppq = ctx.ppq || PPQ;
  const stepTicks = Math.max(1, Math.round(ppq / (arp.stepsPerBeat || 1)));
  const gate = arp.gate == null ? 1 : arp.gate;
  const rand = mulberry32(hashString(note.id));

  const events = [];
  const end = note.startTick + note.durationTicks;
  for (let i = 0; ; i++) {
    const start = note.startTick + i * stepTicks;
    if (start >= end) break;
    const soundTicks = Math.max(1, Math.round(stepTicks * gate));
    const durationTicks = Math.min(soundTicks, end - start);
    const pitch = sequence
      ? sequence[i % sequence.length]
      : pitches[Math.floor(rand() * pitches.length)];
    events.push({ pitch, startTick: start, durationTicks, velocity: note.velocity });
  }
  return events;
}
