// Project document schema, factories and pure mutation helpers.
// All helpers mutate the given doc in place; callers wrap them in store.commit().
//
// ---------------------------------------------------------------------------
// THREE RULES FOR GROWING THE FORMAT
//
// The point of all three: a build that meets a file it does not fully
// understand must still open it, say what it cannot honour, and - above all -
// not quietly destroy the parts it could not read.
//
// Note the direction this works in. A v3 build REFUSES a v4 file outright:
// its validate() predates these rules and throws on any newer version. From
// v4 onward that is fixed (see validate below), so the guarantee holds going
// forward, not backward.
//
// 1. Extension blocks are namespaced and self-versioned.
//    Anything a feature owns lives in its own object carrying `kind` and `v`:
//      master.limiter = { kind: 'limiter', v: 1, ceilingDb: -0.1, … }
//      buses[].chain  = [{ kind: 'delay', v: 1, params: {…} }]
//    A block can then evolve on its own `v` without touching SCHEMA_VERSION.
//    Bump SCHEMA_VERSION only for renames or changed meaning - never for
//    additions, which default on load.
//
// 2. Unknown keys are preserved verbatim.
//    migrate() MUTATES the parsed JSON rather than rebuilding a document from
//    known fields, so a block this build has never heard of survives a load
//    and save untouched. Never reconstruct a document field-by-field; that is
//    what silently drops a newer build's data. (tests/golden.mjs pins this.)
//
// 3. doc.uses declares what a reader must understand.
//    A list like ['harmonics', 'automation', 'tempoMap'] naming the features
//    the document actually relies on. A build that meets an entry it does not
//    know says so - "this project uses X, which this version can't play; it
//    is preserved, not lost" - instead of playing the file wrong in silence.
// ---------------------------------------------------------------------------

import { PPQ } from './music.js';
import { SCHEMA_VERSION } from './version.js';
import { sampleAutomation, AUTOMATION_PARAMS } from './automation.js';

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

// The calibrated level for a wave, read from the built-in presets rather than
// from the document - a project whose stored presets have drifted (or were
// flattened by a build that no longer exists) still gets the right answer.
// A wave with no built-in of its own falls back to the square's level, which
// is what the two brightest built-ins already use.
export function defaultGainForWave(wave) {
  const built = DEFAULT_INSTRUMENTS.find((i) => i.wave === wave);
  return built ? built.gain : DEFAULT_INSTRUMENTS[0].gain;
}

export const DEFAULT_HARMONICS = {
  mode: 'arp',
  stepsPerBeat: 2,
  pattern: 'up',
  octaves: 1,
  gate: 1,
  chordType: 'autoKey',
  anchor: 'above', // 'above' | 'below' - which side of the note the chord is voiced on
  octaveShift: 0, // whole-sweep transpose in octaves (-3..+3), e.g. bass accompaniment
};

export function createNote({ pitch, startTick, durationTicks, velocity = 100, harmonics = null }) {
  return { id: uid(), pitch, startTick, durationTicks, velocity, harmonics };
}

// The colour is generated here and baked into the track, so it is part of the
// saved configuration in localStorage and in an export rather than something
// each view re-derives. Pass `doc` to get the least-used palette entry;
// without one the caller either supplied a colour or gets the first. A caller
// may also pass a literal "#rrggbb" - see trackColorHex below.
export function createTrack({ name = 'Track', role = 'melody', instrumentId = 'badge', notes = [], color, doc } = {}) {
  const baked = hasTrackColor({ color }) ? color : doc ? pickTrackColor(doc) : 0;
  return { id: uid(), name, role, instrumentId, color: baked, notes };
}

export function createProject({ name = 'Untitled', mode = 'mono' } = {}) {
  const track = createTrack({ name: 'Lead', role: 'melody', instrumentId: 'badge' });
  const now = new Date().toISOString();
  return {
    // The in-file format id, NOT the file extension. Renaming the extension
    // to .chipseq.json deliberately left this alone: changing it would make
    // validate() reject every project anyone has already saved.
    schema: 'chipseq-tune',
    version: SCHEMA_VERSION,
    id: uid(),
    name,
    mode,
    ppq: PPQ,
    song: {
      key: { tonic: 0, mode: 'major' },
      // Tempo and meter are MAPS even though the editing UI only ever writes
      // one entry. Everything reads them through bpmAt/timeSigAt/tickToSeconds,
      // so adding mid-song changes later is a UI job, not a rewrite of the
      // engine and all four exporters.
      tempo: [{ tick: 0, bpm: 120 }],
      meter: [{ tick: 0, num: 4, den: 4 }],
      // Derived mirrors of the first map entry, kept in sync by
      // syncLegacyFields(). Two jobs: a future build that restructures the
      // maps can still read a tempo out of a file written here, and this
      // build can read one out of that file (see tempoMap/meterMap).
      // Output-only - nothing in this build reads them directly.
      bpm: 120,
      timeSig: { num: 4, den: 4 },
    },
    instruments: structuredClone(DEFAULT_INSTRUMENTS),
    tracks: [track],
    chordTrackId: null,
    activeTrackId: track.id, // editing focus (highlighted row)
    melodyTrackId: track.id, // the M marker: plays and exports in mono mode
    loop: null, // {startTick, endTick, enabled} | null - saved with the project
    grid: { snapTicks: PPQ / 2, triplet: false }, // snap preference, saved too
    createdAt: now,
    updatedAt: now,
  };
}

// A file from a NEWER build is opened, not refused.
//
// This used to throw on any version above SCHEMA_VERSION, which made rules 2
// and 3 above unreachable: a newer file never got far enough for its unknown
// blocks to be preserved or for doc.uses to explain itself. Refusing to open
// is also the worst outcome for the user - the project is right there, and
// most of it is perfectly playable.
//
// So a higher version loads, its unknown parts ride along untouched, and
// unsupportedFeatures() reports it as schema@N for the UI to surface.
export function validate(doc) {
  if (!doc || doc.schema !== 'chipseq-tune') throw new Error('Not a ChipSeq project file');
  if (typeof doc.version !== 'number') throw new Error('Corrupt project file: no version');
  if (!Array.isArray(doc.tracks) || !doc.song) throw new Error('Corrupt project file');
  return doc;
}

// Migrations run on every load (localStorage autosaves and imported
// .chipseq.json files); the upgraded doc is written back on the next save.
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
  if (doc.version === 3) {
    // v4: the single bpm/timeSig scalars became tick-indexed MAPS. The old
    // fields stay behind as derived mirrors (see syncLegacyFields) so any
    // reader that does not know the maps can still find a tempo.
    if (!Array.isArray(doc.song.tempo)) {
      doc.song.tempo = [{ tick: 0, bpm: doc.song.bpm ?? 120 }];
    }
    if (!Array.isArray(doc.song.meter)) {
      const sig = doc.song.timeSig || { num: 4, den: 4 };
      doc.song.meter = [{ tick: 0, num: sig.num, den: sig.den }];
    }
    doc.version = 4;
  }
  // Cleanup (no version bump): instrument-switch automation existed briefly
  // and was replaced by per-control lanes - drop stray lanes on load.
  for (const t of doc.tracks) {
    if (t.automation && 'instrument' in t.automation) delete t.automation.instrument;
  }
  // Additive default: melody marker used to be fused with the active track.
  if (!doc.melodyTrackId) doc.melodyTrackId = doc.activeTrackId;
  // Colours used to be derived from row position. Baking the current position
  // in keeps every existing project looking exactly as it did, while making
  // the colour survive the reordering that position-derived colours could not.
  doc.tracks.forEach((t, i) => {
    if (!hasTrackColor(t)) t.color = i % TRACK_COLORS;
  });
  // A newer file keeps its own version number: this build did not upgrade it
  // and must not claim it did. Its unknown parts ride along untouched.
  normalizeDoc(doc);
  return doc;
}

// ---- tempo and meter maps ----
//
// Both are sorted, non-empty, and start at tick 0. Nothing outside this file
// should index them directly - go through the accessors, so multi-entry maps
// become a no-op for every caller.

const sortMap = (map) => map.sort((a, b) => a.tick - b.tick);

// Last entry at or before tick (the maps are short; a scan beats a binary
// search and stays readable).
function entryAt(map, tick) {
  let found = map[0];
  for (const e of map) {
    if (e.tick > tick) break;
    found = e;
  }
  return found;
}

// The maps, or a one-entry map rebuilt from the legacy scalars.
//
// This is the other half of what makes the mirrors worth carrying: a document
// from a future version that restructured song.tempo still yields a usable
// tempo here instead of crashing on an undefined map. Same trick in reverse
// as an older build reading song.bpm out of a file this one wrote.
function tempoMap(doc) {
  const map = doc.song.tempo;
  if (Array.isArray(map) && map.length) return map;
  return [{ tick: 0, bpm: doc.song.bpm ?? 120 }];
}

function meterMap(doc) {
  const map = doc.song.meter;
  if (Array.isArray(map) && map.length) return map;
  const sig = doc.song.timeSig || { num: 4, den: 4 };
  return [{ tick: 0, num: sig.num, den: sig.den }];
}

export function bpmAt(doc, tick = 0) {
  return entryAt(tempoMap(doc), tick).bpm;
}

export function timeSigAt(doc, tick = 0) {
  return entryAt(meterMap(doc), tick);
}

// Absolute position of a tick in seconds, integrating across tempo changes.
// A plain tick * secondsPerTick would be wrong the moment a second tempo
// entry exists, so the multiplication lives here once rather than in the
// engine, the WAV renderer and two text exporters.
export function tickToSeconds(doc, tick) {
  const map = tempoMap(doc);
  const ppq = doc.ppq || PPQ;
  let seconds = 0;
  for (let i = 0; i < map.length; i++) {
    const from = map[i].tick;
    if (from >= tick) break;
    const nextTick = i + 1 < map.length ? map[i + 1].tick : Infinity;
    const to = Math.min(tick, nextTick);
    seconds += ((to - from) * 60) / (map[i].bpm * ppq);
  }
  return seconds;
}

// Inverse of tickToSeconds - the playhead reads back from the audio clock.
export function secondsToTick(doc, seconds) {
  const map = tempoMap(doc);
  const ppq = doc.ppq || PPQ;
  let acc = 0;
  for (let i = 0; i < map.length; i++) {
    const from = map[i].tick;
    const nextTick = i + 1 < map.length ? map[i + 1].tick : Infinity;
    const secPerTick = 60 / (map[i].bpm * ppq);
    const segment = (nextTick - from) * secPerTick;
    if (seconds <= acc + segment || nextTick === Infinity) {
      return from + (seconds - acc) / secPerTick;
    }
    acc += segment;
  }
  return 0;
}

export function setTempo(doc, bpm, tick = 0) {
  const entry = doc.song.tempo.find((e) => e.tick === tick);
  if (entry) {
    entry.bpm = bpm;
  } else {
    doc.song.tempo.push({ tick, bpm });
    sortMap(doc.song.tempo);
  }
  syncLegacyFields(doc);
}

export function setTimeSig(doc, num, den, tick = 0) {
  const entry = doc.song.meter.find((e) => e.tick === tick);
  if (entry) {
    entry.num = num;
    entry.den = den;
  } else {
    doc.song.meter.push({ tick, num, den });
    sortMap(doc.song.meter);
  }
  syncLegacyFields(doc);
}

// ---- derived fields ----

// The v3 scalars, recomputed from the maps. They are output only: nothing in
// this build reads them, they exist so the previously deployed version can
// still open a file written here.
export function syncLegacyFields(doc) {
  if (!doc.song) return;
  if (Array.isArray(doc.song.tempo) && doc.song.tempo.length) {
    doc.song.bpm = doc.song.tempo[0].bpm;
  }
  if (Array.isArray(doc.song.meter) && doc.song.meter.length) {
    const m = doc.song.meter[0];
    doc.song.timeSig = { num: m.num, den: m.den };
  }
}

// Features a reader must understand to play this document correctly, and the
// highest major version of each that this build supports.
export const KNOWN_FEATURES = {
  harmonics: 1,
  automation: 1,
  tempoMap: 1,
  meterMap: 1,
  effects: 1,
};

// Recompute doc.uses from what the document actually contains. Only features
// whose absence would make a reader play the file WRONG belong here - not
// every field in use. A multi-entry tempo map qualifies precisely because an
// older build would fall back to the mirrored scalar and play one tempo
// throughout, which sounds fine and is wrong.
export function updateUses(doc) {
  const uses = [];
  if (doc.tracks.some((t) => t.notes.some((n) => n.harmonics))) uses.push('harmonics');
  if (doc.tracks.some((t) => t.automation && Object.values(t.automation).some((l) => l && l.length))) {
    uses.push('automation');
  }
  if (doc.song.tempo && doc.song.tempo.length > 1) uses.push('tempoMap');
  // Effects change what the mix SOUNDS like, so a reader that ignores them
  // plays the file wrong rather than merely plainly - which is the bar for
  // being declared here.
  if (hasEffects(doc)) uses.push('effects@1');
  if (doc.song.meter && doc.song.meter.length > 1) uses.push('meterMap');

  // Entries this build cannot evaluate are CARRIED OVER rather than
  // recomputed away. Rebuilding the list from scratch would quietly strip a
  // newer build's declaration - the exact data loss doc.uses exists to
  // prevent. Over-declaring is the safe direction: we cannot verify a
  // feature we do not understand, so we keep its claim.
  for (const entry of doc.uses || []) {
    if (unsupportedFeatures({ uses: [entry] }).length && !uses.includes(entry)) uses.push(entry);
  }
  doc.uses = uses.sort();
}

// ---- effects: buses and sends ----
//
// Routing is per-track node + sends, chosen over an insert chain per track
// because sends map 1:1 onto MIDI (CC91 reverb, CC93 chorus) while inserts
// map onto nothing, and because one reverb shared by six tracks is one
// convolver rather than six.
//
// track.sends is an ARRAY, so the matrix is already expressible even though
// the shipped UI edits one send at a time.

export function createBus({ name = 'Bus', chain = [] } = {}) {
  return { id: uid(), name, chain };
}

export function buses(doc) {
  return Array.isArray(doc && doc.buses) ? doc.buses : [];
}

export function busById(doc, id) {
  return buses(doc).find((b) => b.id === id) || null;
}

// Sends whose bus actually exists. A send to a missing bus is PRESERVED in the
// document (it may belong to a build that knows more than this one) but is not
// routed, because there is nothing to route it to.
export function trackSends(doc, track) {
  const list = Array.isArray(track && track.sends) ? track.sends : [];
  return list
    .filter((s) => s && busById(doc, s.busId))
    .map((s) => ({ busId: s.busId, level: Math.max(0, Math.min(2, Number(s.level) || 0)) }))
    .filter((s) => s.level > 0);
}

export function hasEffects(doc) {
  return buses(doc).some((b) => Array.isArray(b.chain) && b.chain.length)
    || (doc.tracks || []).some((t) => Array.isArray(t.sends) && t.sends.length)
    || !!(doc.master && Array.isArray(doc.master.chain) && doc.master.chain.length);
}

// Set (or clear, with level 0) one track's send to one bus, leaving its other
// sends alone - the array is a matrix even while the UI shows one row.
export function setSend(track, busId, level) {
  // A send needs somewhere to go. Without this guard the Effects card could
  // write { busId: null } - it commits against the selected bus, which is
  // null between deleting one and the next render - and that lands in the
  // saved file as permanent, inert junk.
  if (!busId) return;
  const list = Array.isArray(track.sends) ? track.sends.filter((s) => s && s.busId !== busId) : [];
  if (level > 0) list.push({ busId, level: Math.max(0, Math.min(2, level)) });
  if (list.length) track.sends = list;
  else delete track.sends;
}

// Entries of doc.uses this build cannot honour: an unknown name, or a known
// one at a higher major than we support.
export function unsupportedFeatures(doc) {
  const out = [];
  // A whole file from the future: report the schema level itself, so the user
  // is told the document is newer than the app rather than left guessing why
  // something looks off.
  if (typeof doc.version === 'number' && doc.version > SCHEMA_VERSION) {
    out.push(`schema@${doc.version}`);
  }
  return out.concat((doc.uses || []).filter((entry) => {
    const [name, major] = String(entry).split('@');
    const supported = KNOWN_FEATURES[name];
    return supported === undefined || Number(major || 1) > supported;
  }));
}

// The single after-commit pass: everything that must hold for EVERY snapshot
// rather than being remembered at each call site.
// Referential integrity, repaired rather than assumed.
//
// Every id in the document must name something that exists. Checking that at
// each call site means every future call site has to remember; doing it here
// makes "well-formed" a property of every snapshot instead. Undo restores a
// snapshot that was already repaired, so this cannot fight the history.
//
// Only ACTUAL repairs are reported - a pass that changed nothing returns an
// empty list, so this can run on every commit without becoming noise.
//
// Deliberately NOT enforced: a muted melody track. It is a legitimate thing
// to do, and silently moving the M marker in response would repeat an
// annoyance we already fixed once (clicking a row used to move it).
export function enforceInvariants(doc) {
  const warnings = [];

  // Something must be playable. A zero-track document would break every
  // consumer that reasonably assumes tracks[0] exists.
  if (!Array.isArray(doc.tracks) || !doc.tracks.length) {
    doc.tracks = [createTrack({ name: 'Lead', role: 'melody', instrumentId: 'badge', color: 0 })];
    warnings.push('the project had no tracks - an empty one was added');
  }
  if (!Array.isArray(doc.instruments) || !doc.instruments.length) {
    doc.instruments = structuredClone(DEFAULT_INSTRUMENTS);
    warnings.push('the instrument list was empty - the defaults were restored');
  }
  // Mono forces the badge square, so it has to exist whatever else was lost.
  if (!doc.instruments.some((i) => i.id === 'badge')) {
    doc.instruments.unshift(structuredClone(DEFAULT_INSTRUMENTS[0]));
    warnings.push('the "Square" instrument was missing - it was restored');
  }

  // Track ids must be unique. A duplicate is not cosmetic: every lookup by id
  // resolves to the FIRST match, so the second track answers to the first
  // one's selection, notes and colour. Re-issue rather than merge - the
  // tracks are distinct, only their labels collided.
  const seen = new Set();
  for (const track of doc.tracks) {
    if (!seen.has(track.id)) { seen.add(track.id); continue; }
    const old = track.id;
    track.id = uid();
    // A per-track instrument is addressed as "track:<id>", so the reference
    // has to follow the rename or the check below would reset it to Square.
    if (track.instrumentId === 'track:' + old) track.instrumentId = 'track:' + track.id;
    seen.add(track.id);
    warnings.push(`two tracks shared an id - "${track.name}" was given a new one`);
  }

  // Every track owns its colour explicitly, so it survives reordering and
  // means the same thing in the grid, the tracks panel and the Mixer. Baked
  // here as well as at creation, because imports and hand-written files also
  // have to come out the other side with one.
  for (const track of doc.tracks) {
    if (!hasTrackColor(track)) track.color = pickTrackColor(doc);
  }

  const byId = new Set(doc.tracks.map((t) => t.id));
  const fallback = doc.tracks[0].id;

  // Instrument references: an orphan id falls back to the badge rather than
  // dangling. getInstrument() would quietly land on instruments[0] anyway -
  // this makes the document say what actually plays.
  for (const track of doc.tracks) {
    const own = String(track.instrumentId || '');
    if (own.startsWith('track:')) {
      // the virtual id only resolves through the track's own inline config
      if (own !== 'track:' + track.id || !track.instrument) {
        track.instrumentId = 'badge';
        track.instrument = null;
        warnings.push(`track "${track.name}" pointed at a missing custom instrument - reset to Square`);
      }
    } else if (!doc.instruments.some((i) => i.id === own)) {
      track.instrumentId = 'badge';
      warnings.push(`track "${track.name}" used an instrument that no longer exists - reset to Square`);
    }
  }

  // Editing focus and the mono voice must both name a real track.
  if (!byId.has(doc.activeTrackId)) {
    doc.activeTrackId = fallback;
    warnings.push('the selected track no longer exists - selection moved');
  }
  if (!byId.has(doc.melodyTrackId)) {
    // prefer something audible, so mono does not resolve to a muted track
    const audible = doc.tracks.find((t) => t.role !== 'muted');
    doc.melodyTrackId = (audible || doc.tracks[0]).id;
    warnings.push(`the melody track no longer exists - "${getTrack(doc, doc.melodyTrackId).name}" is now the mono voice`);
  }
  // chordTrackId is a SOFT reference: null is a valid state, and chord
  // resolution already falls through to its per-note recommendation chain.
  if (doc.chordTrackId && !byId.has(doc.chordTrackId)) {
    doc.chordTrackId = null;
    warnings.push('the chords track no longer exists - chords now resolve from the key');
  }

  return warnings;
}

// The single after-commit pass. Returns the repairs it had to make, so the
// store can tell the user rather than fixing things behind their back.
export function normalizeDoc(doc) {
  if (!doc || !doc.song) return [];
  const warnings = enforceInvariants(doc);
  if (Array.isArray(doc.song.tempo)) sortMap(doc.song.tempo);
  if (Array.isArray(doc.song.meter)) sortMap(doc.song.meter);
  syncLegacyFields(doc);
  updateUses(doc);
  return warnings;
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

// The mono voice: what plays and exports in mono mode (the M marker).
export function melodyTrack(doc) {
  return getTrack(doc, doc.melodyTrackId) || activeTrack(doc);
}

// Tracks audible in the current mode.
// Mute and solo answer different questions, and the difference matters:
//
//   mute  this track is not part of the piece right now. It does not sound,
//         its notes leave the grid, and Levels stops counting it.
//   solo  let me hear this one for a moment. Only soloed tracks sound, but
//         the others stay visible in the grid AND keep counting towards
//         Levels - so a soloed track previews at the level it has in the
//         mix, which is the only level worth judging it at.
//
// Hence two functions. unmutedTracks is what the piece IS; playableTracks is
// what you are hearing at this instant.
//
// Both stay FLATTEN-TIME filters rather than becoming node gains: routing a
// muted track through a zero-gain node would mean scheduling and rendering
// audio nobody hears - 5650 notes of it in the Bad Apple demo - to save a
// re-flatten that costs nothing.
export function unmutedTracks(doc) {
  if (doc.mode === 'mono') {
    const t = melodyTrack(doc);
    return t ? [t] : [];
  }
  return doc.tracks.filter((t) => t.role !== 'muted');
}

// Is anything soloed that could actually be heard? Muting a soloed track
// takes it out of the running, so soloing only the muted track is not "solo".
export function soloActive(doc) {
  return doc.mode === 'poly' && doc.tracks.some((t) => t.solo && t.role !== 'muted');
}

export function playableTracks(doc) {
  const unmuted = unmutedTracks(doc);
  if (!soloActive(doc)) return unmuted;
  return unmuted.filter((t) => t.solo);
}

// ---- track colour and order ----

// Colour is stored as an INDEX into the theme palette, not a hex value, so
// the whole look stays retunable from css/base.css - which is the point of
// the palette existing.
//
// Every track carries one explicitly. Deriving it from row position was
// tidy until rows could be reordered, at which point every track's colour
// shuffled whenever the list did - an identity that moves is not an identity.
// New tracks get a colour baked in at birth and keep it until someone
// changes it.
export const TRACK_COLORS = 8;

// track.color is ONE field in two forms: a palette index (0..7, resolved
// through the theme, so it follows a future light theme) or a literal
// "#rgb"/"#rrggbb" used verbatim. One field means the two can never drift
// out of sync the way a baked index plus a mirrored hex would.
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function trackColorHex(track) {
  if (!track || typeof track.color !== 'string') return null;
  const hex = track.color.trim();
  return HEX_RE.test(hex) ? hex.toLowerCase() : null;
}

// "This track already owns a colour" - either form counts, so baking a
// default must not overwrite a hand-written hex.
export function hasTrackColor(track) {
  return !!track && (Number.isInteger(track.color) || !!trackColorHex(track));
}

// Palette slot only. A track carrying a hex has no index, so callers that can
// render a literal colour must ask trackColorHex() FIRST - this falls back to
// row position, which is a reasonable guess and nothing more.
export function trackColorIndex(doc, track) {
  if (track && Number.isInteger(track.color)) {
    return ((track.color % TRACK_COLORS) + TRACK_COLORS) % TRACK_COLORS;
  }
  // Only reachable for a hand-written document; migrate() bakes colours into
  // everything else on load.
  const idx = doc.tracks.findIndex((t) => t.id === (track && track.id));
  return Math.max(0, idx) % TRACK_COLORS;
}

// The least-used palette entry, so a new track is visually distinct for as
// long as the palette allows and then wraps around evenly. Ties go to the
// lowest index, which keeps the assignment deterministic.
export function pickTrackColor(doc) {
  const used = new Array(TRACK_COLORS).fill(0);
  for (const t of doc.tracks) {
    if (Number.isInteger(t.color)) used[((t.color % TRACK_COLORS) + TRACK_COLORS) % TRACK_COLORS]++;
  }
  let best = 0;
  for (let i = 1; i < TRACK_COLORS; i++) if (used[i] < used[best]) best = i;
  return best;
}

// Move a track to a new position. Reordering is presentational - playback
// reads whichever tracks are playable and sorts events by tick - but it also
// decides the palette position of any track that has not picked a colour,
// which is why setting one explicitly matters once rows can be shuffled.
export function moveTrack(doc, trackId, toIndex) {
  const from = doc.tracks.findIndex((t) => t.id === trackId);
  if (from < 0) return false;
  const to = Math.max(0, Math.min(doc.tracks.length - 1, toIndex));
  if (from === to) return false;
  const [track] = doc.tracks.splice(from, 1);
  doc.tracks.splice(to, 0, track);
  return true;
}

// ---- saved view ----
//
// Where you were looking when you last had the project open: scroll, zoom and
// the cursor. Project data rather than a local preference, so reopening a
// .chipseq.json somewhere else puts you back where you left off, not at bar 1.
//
// A self-versioned block per the extension rules above. Deliberately NOT
// declared in doc.uses: a reader that ignores it still plays the file
// correctly, which is the bar for belonging in that list.
export const VIEW_KIND = 'view';

export function viewOf(doc) {
  const v = doc && doc.view;
  if (!v || typeof v !== 'object') return null;
  return v;
}

// Non-undoable by nature - scrolling is not an edit - so the store exposes
// this the same way it exposes the loop region and the grid preference.
export function setView(doc, view) {
  doc.view = {
    kind: VIEW_KIND,
    v: 1,
    scrollTick: Math.max(0, Math.round(view.scrollTick ?? 0)),
    scrollPitch: Math.round(view.scrollPitch ?? 84),
    pxPerTick: Math.max(0.04, Math.min(8, view.pxPerTick ?? 0.5)),
    cursorTick: Math.max(0, Math.round(view.cursorTick ?? 0)),
    cursorPitch: Math.round(view.cursorPitch ?? 69),
  };
}

// ---- per-track mix ----
// Additive fields with sane defaults, so a project that never touches the
// mixer is byte-identical to one from before it existed.
export const TRACK_GAIN_DEFAULT = 1;
export const TRACK_PAN_DEFAULT = 0;

export function trackGain(track) {
  const g = track && track.gain;
  return typeof g === 'number' ? Math.max(0, Math.min(1.5, g)) : TRACK_GAIN_DEFAULT;
}

export function trackPan(track) {
  const p = track && track.pan;
  return typeof p === 'number' ? Math.max(-1, Math.min(1, p)) : TRACK_PAN_DEFAULT;
}

// Does anything in this project need a stereo field? Mono stays mono, so
// existing exports keep the size and shape they always had.
export function hasPanLane(track) {
  return !!(track && track.automation && track.automation.pan && track.automation.pan.length);
}

export function needsStereo(doc) {
  if (doc.mode !== 'poly') return false;
  return doc.tracks.some((t) => trackPan(t) !== 0 || hasPanLane(t));
}

// Fan tracks across the stereo field: the melody stays centred (it is the
// thing you are listening to) and the rest alternate outward. A starting
// point you then adjust, not a fixed layout - which is why it is a button
// rather than something that happens to you.
export function spreadPan(doc, { width = 0.7 } = {}) {
  const others = doc.tracks.filter((t) => t.id !== doc.melodyTrackId);
  const melody = getTrack(doc, doc.melodyTrackId);
  if (melody) melody.pan = 0;
  others.forEach((track, i) => {
    // -1, +1, -1, +1 ... at growing distance from the centre
    const side = i % 2 === 0 ? -1 : 1;
    const step = Math.floor(i / 2) + 1;
    const depth = Math.min(1, step / Math.max(1, Math.ceil(others.length / 2)));
    track.pan = Math.round(side * width * depth * 100) / 100;
  });
}

// Both take an optional tick so they follow the meter map. Callers that pass
// only the document get the song's opening meter, which is what every caller
// meant back when there could only be one.
export function ticksPerBeat(doc, tick = 0) {
  // A "beat" is the denominator note of the time signature.
  return Math.round((PPQ * 4) / timeSigAt(doc, tick).den);
}

export function ticksPerBar(doc, tick = 0) {
  return ticksPerBeat(doc, tick) * timeSigAt(doc, tick).num;
}

export function songEndTick(doc) {
  let end = 0;
  for (const t of doc.tracks) {
    for (const n of t.notes) end = Math.max(end, n.startTick + n.durationTicks);
  }
  return end;
}

// Where the bulk of a track's notes live: duration-weighted median pitch.
// Used to centre the piano roll when a project opens (mono badge tunes tend
// to sit high, so the default view would cut them off).
export function trackPitchCenter(track) {
  if (!track || !track.notes.length) return null;
  const sorted = [...track.notes].sort((a, b) => a.pitch - b.pitch);
  const total = sorted.reduce((sum, n) => sum + Math.max(1, n.durationTicks), 0);
  let acc = 0;
  for (const n of sorted) {
    acc += Math.max(1, n.durationTicks);
    if (acc >= total / 2) return n.pitch;
  }
  return sorted[sorted.length - 1].pitch;
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

// ---- automation lanes (poly): track.automation = {gain, duty, instrument} ----

export function getLane(track, param) {
  return (track.automation && track.automation[param]) || [];
}

function ensureLane(track, param) {
  if (!track.automation) track.automation = {};
  if (!track.automation[param]) track.automation[param] = [];
  return track.automation[param];
}

// Insert or replace the point at point.tick; lanes stay sorted by tick.
export function setAutomationPoint(doc, trackId, param, point) {
  const track = getTrack(doc, trackId);
  if (!track) return;
  const lane = ensureLane(track, param);
  const existing = lane.findIndex((p) => p.tick === point.tick);
  if (existing >= 0) lane[existing] = point;
  else lane.push(point);
  lane.sort((a, b) => a.tick - b.tick);
}

export function deleteAutomationPoint(doc, trackId, param, tick) {
  const track = getTrack(doc, trackId);
  if (!track || !track.automation || !track.automation[param]) return;
  track.automation[param] = track.automation[param].filter((p) => p.tick !== tick);
}

export function moveAutomationPoint(doc, trackId, param, fromTick, newPoint) {
  deleteAutomationPoint(doc, trackId, param, fromTick);
  setAutomationPoint(doc, trackId, param, newPoint);
}

// Keep lanes consistent when the song is trimmed. mode 'before': drop points
// left of the cut, shift survivors, and seed the value held at the cut so
// the sound doesn't change; mode 'after': drop points at/after the cut.
export function trimAutomation(track, tick, mode) {
  if (!track.automation) return;
  for (const param of Object.keys(track.automation)) {
    const lane = track.automation[param];
    if (!lane || !lane.length) continue;
    if (mode === 'after') {
      track.automation[param] = lane.filter((p) => p.tick < tick);
      continue;
    }
    if (!AUTOMATION_PARAMS[param]) {
      delete track.automation[param];
      continue;
    }
    const dropped = lane.some((p) => p.tick < tick);
    const kept = lane.filter((p) => p.tick >= tick).map((p) => ({ ...p, tick: p.tick - tick }));
    if (dropped && (!kept.length || kept[0].tick > 0)) {
      const held = sampleAutomation(lane, tick, NaN);
      if (!Number.isNaN(held)) kept.unshift({ tick: 0, value: held, curve: 'step' });
    }
    track.automation[param] = kept;
  }
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
    trimAutomation(t, tick, 'before');
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
    trimAutomation(t, tick, 'after');
  }
  if (doc.loop) {
    doc.loop.endTick = Math.min(doc.loop.endTick, tick);
    if (doc.loop.endTick <= doc.loop.startTick) doc.loop = null;
  }
}

// ---- MIDI import application ----

// assignments: [{index, role: "melody"|"chords"|"muted"|"skip", name}]
export function applyImport(doc, parsed, assignments) {
  // The parser hands over whole maps: a MIDI file with mid-song tempo or
  // meter changes keeps them instead of collapsing to its first value.
  if (parsed.song.tempo && parsed.song.tempo.length) doc.song.tempo = parsed.song.tempo.map((e) => ({ ...e }));
  if (parsed.song.meter && parsed.song.meter.length) doc.song.meter = parsed.song.meter.map((e) => ({ ...e }));
  if (parsed.song.key) doc.song.key = parsed.song.key;
  syncLegacyFields(doc);

  const newTracks = [];
  for (const a of assignments) {
    if (a.role === 'skip') continue;
    const src = parsed.tracks[a.index];
    const track = createTrack({
      name: a.name || src.name || `Track ${a.index + 1}`,
      role: a.role,
      instrumentId: doc.mode === 'mono' ? 'badge' : 'sine',
      color: newTracks.length % TRACK_COLORS,
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
  doc.melodyTrackId = melody.track.id;
  // A multi-track file stacked dead centre is a mush; fan it out so the
  // import already sounds like an arrangement. Mono has one voice, so there
  // is nothing to place.
  if (doc.mode === 'poly' && doc.tracks.length > 2) spreadPan(doc);
}

// Merge imported MIDI tracks into the CURRENT project: appends tracks and
// leaves song settings, the melody marker and existing tracks alone. Notes
// keep their musical positions (both sides are tick-based), so an import
// with a different tempo simply plays at the project's BPM.
// Returns the ids of the added tracks.
export function mergeImport(doc, parsed, assignments, { offsetTick = 0 } = {}) {
  const added = [];
  for (const a of assignments) {
    if (a.role === 'skip') continue;
    const src = parsed.tracks[a.index];
    const baseName = a.name || src.name || `Track ${a.index + 1}`;
    // keep names unique so the tracks panel stays readable
    let name = baseName;
    for (let i = 2; doc.tracks.some((t) => t.name === name); i++) name = `${baseName} ${i}`;
    const track = createTrack({
      name,
      role: a.role === 'chords' ? 'chords' : a.role,
      instrumentId: doc.mode === 'mono' ? 'badge' : 'sine',
      color: pickTrackColor(doc),
    });
    track.notes = src.notes.map((n) => createNote({ ...n, startTick: n.startTick + offsetTick }));
    sortNotes(track);
    doc.tracks.push(track);
    added.push(track);
    if (a.role === 'chords') doc.chordTrackId = track.id;
  }
  if (added.length) doc.activeTrackId = added[0].id; // focus the import, don't move the M marker
  return added.map((t) => t.id);
}
