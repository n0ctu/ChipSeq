// Project document schema, factories and pure mutation helpers.
// All helpers mutate the given doc in place; callers wrap them in store.commit().

import { PPQ } from './music.js';
import { SCHEMA_VERSION } from './version.js';

export { PPQ };

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export const DEFAULT_INSTRUMENTS = [
  {
    id: 'badge', name: 'Square', wave: 'square',
    harmonics: null, duty: null,
    adsr: { a: 0.002, d: 0, s: 1, r: 0.002 }, gain: 0.35,
  },
  {
    id: 'sine', name: 'Sine', wave: 'sine',
    harmonics: null, duty: null,
    adsr: { a: 0.005, d: 0.03, s: 0.8, r: 0.04 }, gain: 0.5,
  },
  {
    id: 'saw', name: 'Sawtooth', wave: 'sawtooth',
    harmonics: null, duty: null,
    adsr: { a: 0.005, d: 0.03, s: 0.8, r: 0.04 }, gain: 0.35,
  },
];

export const DEFAULT_HARMONICS = {
  mode: 'arp',
  stepsPerBeat: 2,
  pattern: 'up',
  octaves: 1,
  gate: 1,
  chordType: 'autoKey',
  anchor: 'above', // 'above' | 'below' — which side of the note the chord is voiced on
  octaveShift: 0, // whole-sweep transpose in octaves (-3..+3), e.g. bass accompaniment
};

export function createNote({ pitch, startTick, durationTicks, velocity = 100, harmonics = null }) {
  return { id: uid(), pitch, startTick, durationTicks, velocity, harmonics };
}

export function createTrack({ name = 'Track', role = 'melody', instrumentId = 'badge', notes = [] } = {}) {
  return { id: uid(), name, role, instrumentId, notes };
}

export function createProject({ name = 'Untitled', mode = 'mono' } = {}) {
  const track = createTrack({ name: 'Lead', role: 'melody', instrumentId: 'badge' });
  const now = new Date().toISOString();
  return {
    schema: 'chipseq-tune',
    version: SCHEMA_VERSION,
    id: uid(),
    name,
    mode,
    ppq: PPQ,
    song: {
      bpm: 120,
      timeSig: { num: 4, den: 4 },
      key: { tonic: 0, mode: 'major' },
    },
    instruments: structuredClone(DEFAULT_INSTRUMENTS),
    tracks: [track],
    chordTrackId: null,
    activeTrackId: track.id,
    loop: null, // {startTick, endTick, enabled} | null — saved with the project
    grid: { snapTicks: PPQ / 2, triplet: false }, // snap preference, saved too
    createdAt: now,
    updatedAt: now,
  };
}

export function validate(doc) {
  if (!doc || doc.schema !== 'chipseq-tune') throw new Error('Not a chipseq .tune.json file');
  if (typeof doc.version !== 'number' || doc.version > SCHEMA_VERSION) {
    throw new Error(`Unsupported file version ${doc.version} (app supports up to ${SCHEMA_VERSION})`);
  }
  if (!Array.isArray(doc.tracks) || !doc.song) throw new Error('Corrupt project file');
  return doc;
}

// Migrations run on every load (localStorage autosaves and imported
// .tune.json files); the upgraded doc is written back on the next save.
export function migrate(doc) {
  validate(doc);
  if (doc.version === 1) {
    // v2: the note decoration field was renamed arp -> harmonics
    // (the panel is called "Harmonics" now; the config shape is unchanged).
    for (const t of doc.tracks) {
      for (const n of t.notes) {
        if ('arp' in n) {
          n.harmonics = n.arp;
          delete n.arp;
        }
      }
    }
    doc.version = 2;
  }
  if (doc.version === 2) {
    // v3: "Badge Square" display name simplified to "Square"
    for (const inst of doc.instruments || []) {
      if (inst.id === 'badge' && inst.name === 'Badge Square') inst.name = 'Square';
    }
    doc.version = 3;
  }
  return doc;
}

// ---- lookups ----

export function getTrack(doc, trackId) {
  return doc.tracks.find((t) => t.id === trackId) || null;
}

export function getNote(doc, trackId, noteId) {
  const track = getTrack(doc, trackId);
  return track ? track.notes.find((n) => n.id === noteId) || null : null;
}

export function activeTrack(doc) {
  return getTrack(doc, doc.activeTrackId) || doc.tracks[0] || null;
}

// Tracks audible in the current mode.
export function playableTracks(doc) {
  if (doc.mode === 'mono') {
    const t = activeTrack(doc);
    return t ? [t] : [];
  }
  return doc.tracks.filter((t) => t.role !== 'muted');
}

export function ticksPerBeat(doc) {
  // A "beat" is the denominator note of the time signature.
  return Math.round((PPQ * 4) / doc.song.timeSig.den);
}

export function ticksPerBar(doc) {
  return ticksPerBeat(doc) * doc.song.timeSig.num;
}

export function songEndTick(doc) {
  let end = 0;
  for (const t of doc.tracks) {
    for (const n of t.notes) end = Math.max(end, n.startTick + n.durationTicks);
  }
  return end;
}

// ---- note mutations (keep notes sorted by startTick) ----

export function sortNotes(track) {
  track.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
}

export function addNote(doc, trackId, note) {
  const track = getTrack(doc, trackId);
  track.notes.push(note);
  sortNotes(track);
  return note;
}

export function deleteNotes(doc, trackId, noteIds) {
  const track = getTrack(doc, trackId);
  const ids = new Set(noteIds);
  track.notes = track.notes.filter((n) => !ids.has(n.id));
}

export function updateNotes(doc, trackId, noteIds, fn) {
  const track = getTrack(doc, trackId);
  const ids = new Set(noteIds);
  for (const n of track.notes) if (ids.has(n.id)) fn(n);
  sortNotes(track);
}

// ---- mono validation ----

// Returns Set of note ids participating in time overlaps within a track.
export function findOverlaps(track) {
  const notes = [...track.notes].sort((a, b) => a.startTick - b.startTick);
  const bad = new Set();
  let maxEnd = -1;
  let maxEndNote = null;
  for (const n of notes) {
    if (n.startTick < maxEnd) {
      bad.add(n.id);
      if (maxEndNote) bad.add(maxEndNote.id);
    }
    const end = n.startTick + n.durationTicks;
    if (end > maxEnd) {
      maxEnd = end;
      maxEndNote = n;
    }
  }
  return bad;
}

// Auto-fix overlaps: truncate earlier notes at the next note's start,
// delete notes fully swallowed by an earlier longer note.
export function autoFixOverlaps(track) {
  sortNotes(track);
  const keep = [];
  for (const n of track.notes) {
    const prev = keep[keep.length - 1];
    if (prev && n.startTick < prev.startTick + prev.durationTicks) {
      if (n.startTick === prev.startTick) {
        // Simultaneous: keep the higher pitch (chords collapse to top voice).
        if (n.pitch > prev.pitch) keep[keep.length - 1] = n;
        continue;
      }
      prev.durationTicks = n.startTick - prev.startTick;
      if (prev.durationTicks <= 0) keep.pop();
    }
    keep.push(n);
  }
  track.notes = keep;
}

// ---- global trimmer ----

export function countTrimBefore(doc, tick) {
  let removed = 0;
  for (const t of doc.tracks) {
    for (const n of t.notes) if (n.startTick + n.durationTicks <= tick) removed++;
  }
  return removed;
}

export function countTrimAfter(doc, tick) {
  let removed = 0;
  for (const t of doc.tracks) {
    for (const n of t.notes) if (n.startTick >= tick) removed++;
  }
  return removed;
}

// Delete everything before tick, truncate spanning notes, shift song to start at 0.
export function trimBefore(doc, tick) {
  for (const t of doc.tracks) {
    t.notes = t.notes.filter((n) => n.startTick + n.durationTicks > tick);
    for (const n of t.notes) {
      if (n.startTick < tick) {
        n.durationTicks -= tick - n.startTick;
        n.startTick = tick;
      }
      n.startTick -= tick;
    }
    sortNotes(t);
  }
  if (doc.loop) {
    doc.loop.startTick = Math.max(0, doc.loop.startTick - tick);
    doc.loop.endTick = Math.max(0, doc.loop.endTick - tick);
    if (doc.loop.endTick <= doc.loop.startTick) doc.loop = null;
  }
}

// Delete everything at/after tick, truncate spanning notes.
export function trimAfter(doc, tick) {
  for (const t of doc.tracks) {
    t.notes = t.notes.filter((n) => n.startTick < tick);
    for (const n of t.notes) {
      if (n.startTick + n.durationTicks > tick) n.durationTicks = tick - n.startTick;
    }
  }
  if (doc.loop) {
    doc.loop.endTick = Math.min(doc.loop.endTick, tick);
    if (doc.loop.endTick <= doc.loop.startTick) doc.loop = null;
  }
}

// ---- MIDI import application ----

// assignments: [{index, role: "melody"|"chords"|"muted"|"skip", name}]
export function applyImport(doc, parsed, assignments) {
  doc.song.bpm = parsed.song.bpm ?? doc.song.bpm;
  if (parsed.song.timeSig) doc.song.timeSig = parsed.song.timeSig;
  if (parsed.song.key) doc.song.key = parsed.song.key;

  const newTracks = [];
  for (const a of assignments) {
    if (a.role === 'skip') continue;
    const src = parsed.tracks[a.index];
    const track = createTrack({
      name: a.name || src.name || `Track ${a.index + 1}`,
      role: a.role,
      instrumentId: doc.mode === 'mono' ? 'badge' : 'sine',
    });
    track.notes = src.notes.map((n) => createNote(n));
    sortNotes(track);
    newTracks.push({ track, role: a.role });
  }
  if (!newTracks.length) return;

  doc.tracks = newTracks.map((x) => x.track);
  const chords = newTracks.find((x) => x.role === 'chords');
  doc.chordTrackId = chords ? chords.track.id : null;
  const melody = newTracks.find((x) => x.role === 'melody') || newTracks[0];
  doc.activeTrackId = melody.track.id;
}
