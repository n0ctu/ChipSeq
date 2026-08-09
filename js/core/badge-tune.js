// .cbt - a song, as a badge stores it.
//
// One file that lives in badge flash, travels over the WebSocket, and travels
// over ESP-NOW between badges. It holds what js/core/badge-score.js produces,
// for N tracks: a flat list of {startMs, durMs, pitch} with the tempo map
// already resolved. The badge does no tempo maths, has no notion of ticks or
// BPM, and needs no clock beyond "how many milliseconds into the song am I".
//
// Two decisions shape the layout, and both exist to serve one rule:
//
//   A badge's playback position is a pure function of time, never an
//   accumulated counter.
//
// The tempting player - sound a note, sleep durMs, advance - accumulates every
// delay it ever suffers, so a 200 ms stall makes a badge 200 ms late for the
// rest of the song and no amount of clock sync recovers it. Deriving the
// position instead means the very next evaluation puts the badge back exactly
// where it belongs, and resynchronising an ensemble is nothing more than
// assigning a new t0.
//
// So:
//
//   1. Notes carry ABSOLUTE startMs, not a chain of durations. Answering
//      "what sounds at time T" must not require replaying the song from the
//      beginning.
//   2. Every structure is fixed-size and 4-byte aligned, so the whole file can
//      be cast in place - `(const CbtNote *)(buf + notePoolOffset)` - and
//      noteAt() is a binary search over flash with no parse pass, no RAM copy
//      and no cursor state. That is what makes reseeking cheap enough to do on
//      every tick rather than only at the start.
//
// Rests are NOT stored. Silence is the absence of a note containing T; an
// explicit rest would be a second answer to the same question. (.h keeps rests
// only because a sequential player has no other way to wait.)
//
// Pure, and therefore in core. The wire format is docs/badge-tune-format.md,
// and tests/unit.mjs holds this file to it.

import { badgeScore } from './badge-score.js';
import { bpmAt } from './doc.js';

export const MAGIC = 0x31544243; // "CBT1" little-endian
export const FMT_VERSION = 1;

// Fixed offsets. Named rather than inlined because the same numbers appear in
// the C struct in the spec, and a mismatch there is invisible until hardware.
export const HEADER_BYTES = 64;
export const TRACK_BYTES = 48;
export const NOTE_BYTES = 8;
export const NAME_BYTES = 32; // both tune and track names, NUL-padded

export const FLAG_LOOP = 1;

// A badge plays 21..108 comfortably; outside that the buzzer is either
// inaudible or indistinguishable. Matches the range export-h.js warns about.
export const PITCH_MIN = 21;
export const PITCH_MAX = 108;

// u16 durations. 65 seconds is far longer than any note a badge should hold,
// so this is a cap that reports rather than one that bites.
export const MAX_DUR_MS = 0xffff;

// ---- CRC-32 (IEEE, reflected) ----
//
// Doubles as the tune id: two badges hold the same tune exactly when their
// crc32 matches, which is what lets a mesh conductor decide who needs a copy
// without comparing contents.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, from = 0, to = bytes.length) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The id as it appears in the UI and on the wire: eight lowercase hex digits.
export function tuneIdHex(crc) {
  return (crc >>> 0).toString(16).padStart(8, '0');
}

// ---- names ----

// Names are a fixed 32 bytes, NUL-padded, so the track table is a castable
// array. Truncation is on a codepoint boundary: half a UTF-8 sequence in a
// fixed field renders as a replacement character on the badge, which looks
// like corruption rather than like a long name.
export function encodeName(name, into, at, max = NAME_BYTES) {
  const bytes = new TextEncoder().encode(String(name || ''));
  let n = Math.min(bytes.length, max);
  while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--; // back off into the sequence
  for (let i = 0; i < n; i++) into[at + i] = bytes[i];
  return n;
}

export function decodeName(bytes, at, max = NAME_BYTES) {
  let end = at;
  while (end < at + max && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(at, end));
}

// ---- writing ----

// doc -> Uint8Array.
//
// trackIds of length 1 is the mono case: a badge that stores it has exactly
// one part and no choice to make. Poly is the same code path with more ids, so
// there is one format and one writer rather than two that can disagree.
export function buildTune(doc, { trackIds = null, name = null, loop = false, loopStartMs = 0, loopEndMs = 0 } = {}) {
  const ids = trackIds && trackIds.length
    ? trackIds
    : (doc.tracks || []).map((t) => t.id);
  if (!ids.length) throw new Error('a tune needs at least one track');
  if (ids.length > 16) throw new Error('a tune holds at most 16 tracks');

  const warnings = [];
  const outOfRange = new Set();

  const tracks = ids.map((id) => {
    const track = (doc.tracks || []).find((t) => t.id === id);
    // includeRests false: silence is a gap here, not a record.
    const score = badgeScore(doc, id, { includeRests: false });
    const notes = score.map((n) => {
      if (n.pitch < PITCH_MIN || n.pitch > PITCH_MAX) outOfRange.add(n.pitch);
      return {
        startMs: n.startMs,
        durMs: Math.min(n.durMs, MAX_DUR_MS),
        pitch: Math.max(0, Math.min(255, n.pitch)),
        flags: 0,
      };
    });
    const clamped = score.filter((n) => n.durMs > MAX_DUR_MS).length;
    if (clamped) {
      warnings.push(`“${track ? track.name : id}”: ${clamped} note(s) longer than 65 s were shortened.`);
    }
    const lengthMs = notes.length ? notes[notes.length - 1].startMs + notes[notes.length - 1].durMs : 0;
    return { id, name: track ? track.name : '', notes, lengthMs };
  });

  if (outOfRange.size) {
    const list = [...outOfRange].sort((a, b) => a - b).join(', ');
    warnings.push(`Notes outside the badge's range (MIDI ${PITCH_MIN}..${PITCH_MAX}): ${list}.`);
  }

  const noteCount = tracks.reduce((a, t) => a + t.notes.length, 0);
  const notePoolOffset = HEADER_BYTES + tracks.length * TRACK_BYTES;
  const bytes = new Uint8Array(notePoolOffset + noteCount * NOTE_BYTES);
  const view = new DataView(bytes.buffer);
  const totalMs = tracks.reduce((a, t) => Math.max(a, t.lengthMs), 0);

  view.setUint32(0, MAGIC, true);
  bytes[4] = FMT_VERSION;
  bytes[5] = loop ? FLAG_LOOP : 0;
  bytes[6] = tracks.length;
  bytes[7] = 0;
  // 8..11 is the crc, filled in last - it covers everything after itself.
  view.setUint32(12, totalMs, true);
  view.setUint32(16, Math.max(0, loopStartMs) >>> 0, true);
  view.setUint32(20, Math.max(0, loopEndMs) >>> 0, true);
  view.setUint32(24, notePoolOffset, true);
  // Display only. The badge never computes anything from it - every duration
  // in the file is already in milliseconds - but a library listing that cannot
  // say "128 BPM" is harder to navigate than one that can.
  view.setUint16(28, Math.min(0xffff, Math.round(bpmAt(doc, 0))), true);
  view.setUint16(30, 0, true);
  encodeName(name || doc.name, bytes, 32);

  let firstNote = 0;
  tracks.forEach((t, i) => {
    const at = HEADER_BYTES + i * TRACK_BYTES;
    encodeName(t.name, bytes, at);
    view.setUint32(at + 32, firstNote, true);
    view.setUint32(at + 36, t.notes.length, true);
    view.setUint32(at + 40, t.lengthMs, true);
    view.setUint32(at + 44, 0, true);
    firstNote += t.notes.length;
  });

  let at = notePoolOffset;
  for (const t of tracks) {
    for (const n of t.notes) {
      view.setUint32(at, n.startMs, true);
      view.setUint16(at + 4, n.durMs, true);
      bytes[at + 6] = n.pitch;
      bytes[at + 7] = n.flags;
      at += NOTE_BYTES;
    }
  }

  const crc = crc32(bytes, 12);
  view.setUint32(8, crc, true);

  return {
    bytes,
    id: tuneIdHex(crc),
    crc,
    totalMs,
    warnings,
    tracks: tracks.map((t) => ({ name: t.name, notes: t.notes.length, lengthMs: t.lengthMs })),
  };
}

// ---- reading ----
//
// Exists so a round-trip test can prove the writer and the documented layout
// agree. A firmware author reading docs/badge-tune-format.md and this function
// should be unable to find a disagreement.

export function parseTune(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < HEADER_BYTES) throw new Error('too short to be a tune');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('not a .cbt file');
  const fmtVersion = bytes[4];
  if (fmtVersion !== FMT_VERSION) throw new Error(`unsupported .cbt version ${fmtVersion}`);

  const flags = bytes[5];
  const trackCount = bytes[6];
  const stored = view.getUint32(8, true);
  const actual = crc32(bytes, 12);
  if (stored !== actual) throw new Error('crc mismatch: the tune is damaged');

  const notePoolOffset = view.getUint32(24, true);
  if (notePoolOffset % 4 !== 0) throw new Error('note pool is not 4-byte aligned');
  if (notePoolOffset < HEADER_BYTES + trackCount * TRACK_BYTES) throw new Error('note pool overlaps the track table');
  if ((bytes.length - notePoolOffset) % NOTE_BYTES !== 0) throw new Error('note pool is not a whole number of notes');
  const poolNotes = (bytes.length - notePoolOffset) / NOTE_BYTES;

  const tracks = [];
  let counted = 0;
  for (let i = 0; i < trackCount; i++) {
    const at = HEADER_BYTES + i * TRACK_BYTES;
    const firstNote = view.getUint32(at + 32, true);
    const noteCount = view.getUint32(at + 36, true);
    if (firstNote + noteCount > poolNotes) throw new Error(`track ${i} runs past the note pool`);
    const notes = [];
    for (let n = 0; n < noteCount; n++) {
      const p = notePoolOffset + (firstNote + n) * NOTE_BYTES;
      notes.push({
        startMs: view.getUint32(p, true),
        durMs: view.getUint16(p + 4, true),
        pitch: bytes[p + 6],
        flags: bytes[p + 7],
      });
    }
    counted += noteCount;
    tracks.push({ name: decodeName(bytes, at), lengthMs: view.getUint32(at + 40, true), notes });
  }
  if (counted !== poolNotes) throw new Error('track note counts do not fill the pool');

  return {
    fmtVersion,
    flags,
    loop: (flags & FLAG_LOOP) !== 0,
    crc: stored,
    id: tuneIdHex(stored),
    totalMs: view.getUint32(12, true),
    loopStartMs: view.getUint32(16, true),
    loopEndMs: view.getUint32(20, true),
    bpmHint: view.getUint16(28, true),
    name: decodeName(bytes, 32),
    tracks,
  };
}

// ---- the seek ----

export const NONE = -1;

// Index of the note sounding at songMs, or NONE for silence.
//
// This is the whole player. Everything else - standalone, mesh, and scheduled
// streaming - differs only in where `now()` comes from:
//
//   songMs = now() - t0 + fromMs
//   i      = noteAt(notes, songMs)
//   if (i !== sounding) { i === NONE ? off() : on(notes[i].pitch); sounding = i }
//
// Compare by INDEX, never by pitch: two identical pitches back to back must
// re-articulate, and a pitch comparison slurs them into one long note.
//
// Because onsets are looked up rather than consumed, changing t0 mid-song
// cannot skip a note that is still in the future - it can only truncate or
// prolong the one already sounding, which is exactly what resynchronising an
// ensemble should do.
export function noteAt(notes, songMs) {
  let lo = 0;
  let hi = notes.length - 1;
  let found = NONE;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].startMs <= songMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === NONE) return NONE;
  const n = notes[found];
  return songMs < n.startMs + n.durMs ? found : NONE;
}
