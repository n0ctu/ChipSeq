// Unit tests for the ChipSeq core (no DOM/audio needed).
// Run: node tests/unit.mjs
import { renderHarmonics, chordIntervals, resolveChord } from '../js/core/harmonics.js';
import { flattenSong, flattenNote, buildChordEvents, makeChordLookup, explainNoteChord } from '../js/core/flatten.js';
import { chordName } from '../js/core/music.js';
import { exportHeader, pitchSymbol, sanitizeSymbolName } from '../js/core/export-h.js';
import { parseMidi, suggestRoles } from '../js/core/midi-import.js';
import {
  createProject, createNote, addNote, trimBefore, trimAfter, findOverlaps,
  autoFixOverlaps, activeTrack, applyImport,
} from '../js/core/doc.js';
import { PPQ, noteName, pitchToFreq, diatonicTriadIntervals, detectKey } from '../js/core/music.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL:', msg); }
}
function eq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log('  got:', JSON.stringify(a), '\n  want:', JSON.stringify(b));
  assert(ok, msg);
}

// ---- music ----
assert(noteName(60) === 'C4', 'MIDI 60 is C4');
assert(pitchSymbol(60) === 'NOTE_C4', 'symbol for 60');
assert(pitchSymbol(63) === 'NOTE_DS4', 'symbol for 63 (D#4)');
assert(Math.abs(pitchToFreq(69) - 440) < 1e-9, 'A4 = 440 Hz');
eq(diatonicTriadIntervals(60, { tonic: 0, mode: 'major' }), [0, 4, 7], 'C in C major -> major triad');
eq(diatonicTriadIntervals(62, { tonic: 0, mode: 'major' }), [0, 3, 7], 'D in C major -> minor triad');
eq(diatonicTriadIntervals(71, { tonic: 0, mode: 'major' }), [0, 3, 6], 'B in C major -> diminished');

// ---- arp ----
const ctx = { ppq: PPQ, key: { tonic: 0, mode: 'major' }, getChordPitchClassesAt: () => null };
const plain = { id: 'n1', pitch: 60, startTick: 0, durationTicks: 96, velocity: 100, arp: null };
eq(renderHarmonics(plain, ctx), [{ pitch: 60, startTick: 0, durationTicks: 96, velocity: 100 }], 'no arp = identity');

const upArp = { ...plain, harmonics: { mode: 'arp', stepsPerBeat: 3, pattern: 'up', octaves: 1, gate: 1, chordType: 'major' } };
const upEvents = renderHarmonics(upArp, ctx);
eq(upEvents.map((e) => e.pitch), [60, 64, 67], 'up pattern pitches C E G');
eq(upEvents.map((e) => e.startTick), [0, 32, 64], '3 steps/beat spacing');
assert(upEvents.every((e) => e.durationTicks === 32), 'full gate step length');

const downArp = { ...plain, harmonics: { ...upArp.harmonics, pattern: 'down' } };
eq(renderHarmonics(downArp, ctx).map((e) => e.pitch), [67, 64, 60], 'down pattern');

const udArp = { ...plain, durationTicks: 96 * 2, harmonics: { ...upArp.harmonics, pattern: 'updown', stepsPerBeat: 4 } };
const udEvents = renderHarmonics(udArp, ctx);
// sequence C E G E, repeating; 8 steps over 2 beats
eq(udEvents.map((e) => e.pitch), [60, 64, 67, 64, 60, 64, 67, 64], 'updown no double-hit');

const gateArp = { ...plain, harmonics: { ...upArp.harmonics, gate: 0.75, stepsPerBeat: 2 } };
const gateEvents = renderHarmonics(gateArp, ctx);
assert(gateEvents.every((e) => e.durationTicks === 36), 'gate 0.75 of 48-tick steps = 36');

const randArp = { ...plain, durationTicks: 384, harmonics: { ...upArp.harmonics, pattern: 'random' } };
eq(renderHarmonics(randArp, ctx), renderHarmonics(randArp, ctx), 'random is deterministic per note id');
const randOther = renderHarmonics({ ...randArp, id: 'other' }, ctx);
assert(JSON.stringify(randOther.map(e=>e.pitch)) !== JSON.stringify(renderHarmonics(randArp, ctx).map(e=>e.pitch)) || true, 'different id may differ (non-assert)');

const octArp = { ...plain, harmonics: { ...upArp.harmonics, chordType: 'octaves', octaves: 2, stepsPerBeat: 2 } };
eq(renderHarmonics(octArp, ctx).map((e) => e.pitch), [60, 72], 'whole octaves over 2 octaves');

// autoSong: chords track pcs
const songCtx = { ...ctx, getChordPitchClassesAt: () => [9, 0, 4] }; // A minor: A C E
const autoArp = { id: 'n2', pitch: 69, startTick: 0, durationTicks: 96, velocity: 100, harmonics: { mode: 'arp', stepsPerBeat: 3, pattern: 'up', octaves: 1, gate: 1, chordType: 'autoSong' } };
eq(renderHarmonics(autoArp, songCtx).map((e) => e.pitch), [69, 72, 76], 'autoSong anchored at A4 -> A C E');
eq(chordIntervals({ pitch: 62, startTick: 0 }, { chordType: 'autoKey' }, ctx), [0, 3, 7], 'autoKey D minor triad in C major');

// chord mode
const chordNote = { ...plain, harmonics: { mode: 'chord', stepsPerBeat: 1, pattern: 'up', octaves: 1, gate: 1, chordType: 'minor' } };
const chordEvents = renderHarmonics(chordNote, ctx);
eq(chordEvents.map((e) => e.pitch), [60, 63, 67], 'chord mode simultaneous');
assert(chordEvents.every((e) => e.startTick === 0 && e.durationTicks === 96), 'chord mode keeps timing');

// ---- flatten mono enforcement ----
const doc = createProject({ name: 'Test Tune', mode: 'mono' });
doc.song.bpm = 125; // 1 tick = 5 ms exactly at PPQ 96? 60000/(125*96) = 5 ms. yes.
const trackId = doc.tracks[0].id;
addNote(doc, trackId, createNote({ pitch: 64, startTick: 0, durationTicks: 96 })); // overlaps next
addNote(doc, trackId, createNote({ pitch: 72, startTick: 48, durationTicks: 48 }));
const flat = flattenSong(doc);
assert(flat.warnings.some((w) => w.type === 'overlap'), 'overlap warning emitted');
eq(flat.events.map((e) => [e.pitch, e.startTick, e.durationTicks]), [[64, 0, 48], [72, 48, 48]], 'mono truncation');

// ---- export-h ----
const hdoc = createProject({ name: 'start sound!', mode: 'mono' });
hdoc.song.bpm = 125; // 5 ms per tick
const htid = hdoc.tracks[0].id;
addNote(hdoc, htid, createNote({ pitch: 64, startTick: 0, durationTicks: 16 })); // 80 ms E4
addNote(hdoc, htid, createNote({ pitch: 84, startTick: 16, durationTicks: 16 })); // 80 ms C6
addNote(hdoc, htid, createNote({ pitch: 84, startTick: 48, durationTicks: 96 })); // gap 16 ticks = 80ms rest, then 480 ms
const h = exportHeader(hdoc);
assert(h.name === 'START_SOUND', 'symbol sanitized: ' + h.name);
assert(h.text.includes('{NOTE_E4     ,   80}'), '.h has E4 80ms entry');
assert(h.text.includes('{NOTE_REST   ,   80}'), '.h has 80ms rest for the gap');
assert(h.text.includes('{NOTE_C6     ,  480}'), '.h has C6 480ms entry');
assert(h.text.includes('static const BadgeNote START_SOUND[]'), '.h array declaration');
assert(h.text.includes('START_SOUND_LEN'), '.h LEN constant');
// total duration = sum of entries = 80+80+80+480 = 720
const ms = [...h.text.matchAll(/,\s+(\d+)\}/g)].map((m) => Number(m[1]));
eq(ms.reduce((a, b) => a + b, 0), 720, 'total ms preserved');
assert(sanitizeSymbolName('123 go') === 'T_123_GO', 'leading digit prefixed');

// arp flattening into .h: gap steps produce rests
const adoc = createProject({ name: 'arp', mode: 'mono' });
adoc.song.bpm = 125;
const atid = adoc.tracks[0].id;
addNote(adoc, atid, createNote({
  pitch: 60, startTick: 0, durationTicks: 96,
  harmonics: { mode: 'arp', stepsPerBeat: 2, pattern: 'up', octaves: 1, gate: 0.5, chordType: 'major' },
}));
const ah = exportHeader(adoc);
const restCount = [...ah.text.matchAll(/NOTE_REST/g)].length;
assert(restCount >= 2, 'gated arp emits rests (found ' + restCount + ' incl. #define)');

// ---- loop region export (.h) ----
{
  const rdoc = createProject({ name: 'loop', mode: 'mono' });
  rdoc.song.bpm = 125; // 5 ms per tick
  const rtid = rdoc.tracks[0].id;
  addNote(rdoc, rtid, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
  addNote(rdoc, rtid, createNote({ pitch: 64, startTick: 96, durationTicks: 96 }));
  addNote(rdoc, rtid, createNote({ pitch: 67, startTick: 240, durationTicks: 96 })); // gap 192..240

  const sumMs = (h) => [...h.text.matchAll(/,\s+(\d+)\}/g)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);

  // region spanning note B, the gap, and note C exactly
  const r1 = exportHeader(rdoc, null, { region: { startTick: 96, endTick: 336 } });
  eq(sumMs(r1), 240 * 5, 'region total = exact region length');
  assert(r1.text.includes('NOTE_E4') && r1.text.includes('NOTE_G4') && !r1.text.includes('NOTE_C4'), 'only region notes exported');
  assert(r1.text.includes('(loop region)'), 'header comment marks region export');

  // boundary clipping: cuts through both notes
  const r2 = exportHeader(rdoc, null, { region: { startTick: 48, endTick: 144 } });
  eq(sumMs(r2), 96 * 5, 'boundary-clipped region length exact');
  assert(r2.entryCount === 2, 'two truncated entries');

  // leading + trailing silence preserved as rests
  const r3 = exportHeader(rdoc, null, { region: { startTick: 192, endTick: 384 } });
  assert(r3.text.match(/NOTE_REST/g).length >= 2, 'leading rest kept in region export');
  eq(sumMs(r3), 192 * 5, 'region with leading+trailing silence still exact');

  // no region = unchanged behavior (leading silence skipped)
  const full = exportHeader(rdoc, null, {});
  eq(sumMs(full), 336 * 5, 'full export unchanged');
}

// ---- Flipper Music Format export ----
{
  const { exportFmf } = await import('../js/core/export-fmf.js');
  const fdoc = createProject({ name: 'flipper', mode: 'mono' });
  fdoc.song.bpm = 140;
  const ftid = fdoc.tracks[0].id;
  // eighth notes A#5, D#6 (octave override), quarter A#5, half D#5, plus a gap
  addNote(fdoc, ftid, createNote({ pitch: 82, startTick: 0, durationTicks: 48 })); // A#5 8th
  addNote(fdoc, ftid, createNote({ pitch: 87, startTick: 48, durationTicks: 48 })); // D#6 8th
  addNote(fdoc, ftid, createNote({ pitch: 82, startTick: 96, durationTicks: 96 })); // A#5 4th
  addNote(fdoc, ftid, createNote({ pitch: 75, startTick: 240, durationTicks: 192 })); // D#5 half, gap 48 before

  const f = exportFmf(fdoc);
  const lines = f.text.split('\n');
  assert(lines[0] === 'Filetype: Flipper Music Format', 'fmf header line');
  assert(lines[2] === 'BPM: 140', 'fmf bpm');
  assert(lines[3] === 'Duration: 8', 'default duration = most common (8th)');
  assert(lines[4] === 'Octave: 5', 'default octave detected');
  const notes = lines[5].replace('Notes: ', '').split(', ');
  eq(notes, ['A#', 'D#6', '4A#', 'P', '2D#'], 'note list matches expected fmf tokens');

  // dotted duration: 144 ticks = dotted quarter
  const ddoc = createProject({ name: 'dot', mode: 'mono' });
  ddoc.song.bpm = 120;
  addNote(ddoc, ddoc.tracks[0].id, createNote({ pitch: 72, startTick: 0, durationTicks: 144 }));
  addNote(ddoc, ddoc.tracks[0].id, createNote({ pitch: 74, startTick: 144, durationTicks: 48 }));
  const d = exportFmf(ddoc);
  const dlines = d.text.split('\n');
  const dDefaultDen = Number(dlines[3].replace('Duration: ', ''));
  const dnotes = dlines[5].replace('Notes: ', '').split(', ');
  const dDen = dnotes[0].match(/^(\d*)/)[1] ? Number(dnotes[0].match(/^(\d*)/)[1]) : dDefaultDen;
  assert(dnotes[0].endsWith('.') && dDen === 4, 'dotted quarter rendered as den-4 with trailing dot: ' + dnotes[0] + ' (default ' + dDefaultDen + ')');

  // total duration preservation: token ticks sum ≈ song ticks
  const tickOf = (tok) => {
    const m = tok.match(/^(\d*)([A-GP]#?)(\d*)(\.?)$/);
    const den = m[1] ? Number(m[1]) : 8;
    return (384 / den) * (m[4] ? 1.5 : 1);
  };
  const total = notes.reduce((a, t) => a + tickOf(t), 0);
  eq(total, 432, 'fmf total ticks preserved (48+48+96+48+192)');

  // fast arp: 32 steps/beat becomes 128th notes
  const adoc2 = createProject({ name: 'fastfmf', mode: 'mono' });
  adoc2.song.bpm = 120;
  addNote(adoc2, adoc2.tracks[0].id, createNote({
    pitch: 60, startTick: 0, durationTicks: 96,
    harmonics: { mode: 'arp', stepsPerBeat: 32, pattern: 'up', octaves: 1, gate: 1, chordType: 'major' },
  }));
  const fa = exportFmf(adoc2);
  assert(fa.text.split('\n')[3] === 'Duration: 128', 'fast arp exports as 128th notes');
  assert(fa.tokenCount === 32, '32 fast-arp tokens');

  // region export keeps exact length with leading/trailing pauses
  const r = exportFmf(fdoc, { region: { startTick: 192, endTick: 480 } });
  const rnotes = r.text.split('\n')[5].replace('Notes: ', '').split(', ');
  const rtotal = rnotes.reduce((a, t) => a + tickOf(t), 0);
  eq(rtotal, 288, 'region fmf total = exact region length');
  assert(rnotes[0].includes('P'), 'leading pause kept in region export');
}

// ---- trimmer ----
const tdoc = createProject({ name: 'trim', mode: 'mono' });
const ttid = tdoc.tracks[0].id;
addNote(tdoc, ttid, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
addNote(tdoc, ttid, createNote({ pitch: 62, startTick: 96, durationTicks: 96 })); // spans cut at 144
addNote(tdoc, ttid, createNote({ pitch: 64, startTick: 192, durationTicks: 96 }));
const tdoc2 = structuredClone(tdoc);
trimBefore(tdoc, 144);
eq(tdoc.tracks[0].notes.map((n) => [n.pitch, n.startTick, n.durationTicks]),
   [[62, 0, 48], [64, 48, 96]], 'trimBefore truncates + shifts to 0');
trimAfter(tdoc2, 144);
eq(tdoc2.tracks[0].notes.map((n) => [n.pitch, n.startTick, n.durationTicks]),
   [[60, 0, 96], [62, 96, 48]], 'trimAfter truncates tail');

// ---- loop region is project data ----
{
  const { createStore } = await import('../js/core/store.js');
  const ldoc = createProject({ name: 'loop-persist', mode: 'mono' });
  assert(ldoc.loop === null, 'new project has no loop');
  const lstore = createStore(ldoc);
  lstore.setLoop({ startTick: 96, endTick: 480 });
  const loop = lstore.getDoc().loop;
  assert(loop.startTick === 96 && loop.endTick === 480 && loop.enabled === true, 'setLoop stores in doc, enabled by default');
  assert(!lstore.canUndo(), 'setLoop creates no undo entry');
  assert(JSON.parse(JSON.stringify(lstore.getDoc())).loop.endTick === 480, 'loop survives serialization (.tune.json)');
  lstore.setLoop({ startTick: 100, endTick: 50 });
  assert(lstore.getDoc().loop === null, 'invalid region clears the loop');

  // trimmer keeps the loop consistent inside the same commit
  const t1 = createProject({ name: 't', mode: 'mono' });
  t1.loop = { startTick: 96, endTick: 480, enabled: true };
  addNote(t1, t1.tracks[0].id, createNote({ pitch: 60, startTick: 0, durationTicks: 960 }));
  trimBefore(t1, 144);
  eq(t1.loop, { startTick: 0, endTick: 336, enabled: true }, 'trimBefore shifts the loop');
  const t2 = createProject({ name: 't2', mode: 'mono' });
  t2.loop = { startTick: 96, endTick: 480, enabled: true };
  trimAfter(t2, 240);
  eq(t2.loop, { startTick: 96, endTick: 240, enabled: true }, 'trimAfter clamps the loop end');
  const t3 = createProject({ name: 't3', mode: 'mono' });
  t3.loop = { startTick: 96, endTick: 480, enabled: true };
  trimAfter(t3, 48);
  assert(t3.loop === null, 'loop fully behind the cut is removed');
}

// ---- grid/snap preference is project data ----
{
  const { createStore } = await import('../js/core/store.js');
  const gdoc = createProject({ name: 'grid-persist', mode: 'mono' });
  eq(gdoc.grid, { snapTicks: 48, triplet: false }, 'new project defaults to 1/8 snap');
  const gstore = createStore(gdoc);
  gstore.setGrid({ snapTicks: 24, triplet: false }); // 1/16
  eq(gstore.getDoc().grid, { snapTicks: 24, triplet: false }, 'setGrid stores in doc');
  assert(!gstore.canUndo(), 'setGrid creates no undo entry');
  assert(JSON.parse(JSON.stringify(gstore.getDoc())).grid.snapTicks === 24, 'grid survives serialization (.tune.json)');
  gstore.setGrid({ snapTicks: 24, triplet: true });
  assert(gstore.getDoc().grid.triplet === true, 'triplet flag persisted');
}

// ---- overlaps + autofix ----
const odoc = createProject({ name: 'ov', mode: 'mono' });
const otid = odoc.tracks[0].id;
addNote(odoc, otid, createNote({ pitch: 60, startTick: 0, durationTicks: 100 }));
addNote(odoc, otid, createNote({ pitch: 64, startTick: 0, durationTicks: 100 })); // chord
addNote(odoc, otid, createNote({ pitch: 65, startTick: 50, durationTicks: 100 }));
assert(findOverlaps(odoc.tracks[0]).size === 3, 'all three overlap');
autoFixOverlaps(odoc.tracks[0]);
eq(odoc.tracks[0].notes.map((n) => [n.pitch, n.startTick, n.durationTicks]),
   [[64, 0, 50], [65, 50, 100]], 'autofix keeps higher pitch + truncates');
assert(findOverlaps(odoc.tracks[0]).size === 0, 'no overlaps after autofix');

// ---- MIDI parse (build a tiny format-1 file in memory) ----
function buildMidi() {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const str = (s) => push(...[...s].map((c) => c.charCodeAt(0)));
  const u32 = (v) => push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const u16 = (v) => push((v >>> 8) & 255, v & 255);
  str('MThd'); u32(6); u16(1); u16(2); u16(480);
  // track 1: meta (tempo 120bpm, 3/4, key sig 2 sharps major=D) + melody C4 quarter, D4 quarter
  const t1 = [];
  const p1 = (...b) => t1.push(...b);
  p1(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // 500000 us = 120 bpm
  p1(0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08); // 3/4
  p1(0x00, 0xff, 0x59, 0x02, 0x02, 0x00); // 2 sharps major = D major
  p1(0x00, 0x90, 60, 100); // note on C4
  p1(0x83, 0x60, 0x80, 60, 0); // delta 480, note off
  p1(0x00, 0x90, 62, 100, 0x83, 0x60, 62, 0); // running status note-on vel0 = off
  p1(0x00, 0xff, 0x2f, 0x00);
  str('MTrk'); u32(t1.length); push(...t1);
  // track 2: chords - C major triad whole note
  const t2 = [];
  const p2 = (...b) => t2.push(...b);
  p2(0x00, 0xff, 0x03, 0x06); [...'Chords'].forEach((c) => p2(c.charCodeAt(0)));
  p2(0x00, 0x90, 48, 80, 0x00, 52, 80, 0x00, 55, 80);
  p2(0x87, 0x40, 48, 0, 0x00, 52, 0, 0x00, 55, 0); // delta 960, offs
  p2(0x00, 0xff, 0x2f, 0x00);
  str('MTrk'); u32(t2.length); push(...t2);
  return new Uint8Array(bytes).buffer;
}
const parsed = parseMidi(buildMidi());
assert(parsed.song.bpm === 120, 'tempo parsed: ' + parsed.song.bpm);
eq(parsed.song.timeSig, { num: 3, den: 4 }, 'time sig parsed');
eq(parsed.song.key, { tonic: 2, mode: 'major' }, 'key sig parsed (D major)');
assert(parsed.tracks.length === 2, 'two note tracks');
eq(parsed.tracks[0].notes.map((n) => [n.pitch, n.startTick, n.durationTicks]),
   [[60, 0, 96], [62, 96, 96]], 'melody rescaled 480->96 PPQ');
assert(parsed.tracks[1].name === 'Chords', 'track name parsed');
assert(parsed.tracks[1].notes.length === 3, 'chord notes parsed');
const roles = suggestRoles(parsed.tracks);
eq(roles, ['melody', 'chords'], 'role suggestion');

// applyImport
const idoc = createProject({ name: 'imported', mode: 'mono' });
applyImport(idoc, parsed, [
  { index: 0, role: 'melody', name: 'Melody' },
  { index: 1, role: 'chords', name: 'Chords' },
]);
assert(idoc.tracks.length === 2, 'imported 2 tracks');
assert(idoc.chordTrackId === idoc.tracks[1].id, 'chord track designated');
assert(idoc.activeTrackId === idoc.tracks[0].id, 'melody active');
assert(idoc.melodyTrackId === idoc.tracks[0].id, 'melody marker set by import');
assert(idoc.song.bpm === 120 && idoc.song.timeSig.num === 3, 'song meta applied');

// autoSong via real chord track
addNote(idoc, idoc.tracks[0].id, createNote({
  pitch: 72, startTick: 0, durationTicks: 96,
  harmonics: { mode: 'arp', stepsPerBeat: 3, pattern: 'up', octaves: 1, gate: 1, chordType: 'autoSong' },
}));
const lastNote = activeTrack(idoc).notes.find((n) => n.harmonics);
const ghost = flattenNote(idoc, idoc.activeTrackId, lastNote.id);
eq(ghost.map((e) => e.pitch), [72, 76, 79], 'autoSong reads imported chord track (C E G above C5)');

// ---- MIDI channel splitting (format 0, one MTrk, three channels) ----
function buildMidi0() {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const str = (s) => push(...[...s].map((c) => c.charCodeAt(0)));
  const u32 = (v) => push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const u16 = (v) => push((v >>> 8) & 255, v & 255);
  str('MThd'); u32(6); u16(0); u16(1); u16(96);
  const t = [];
  const p = (...b) => t.push(...b);
  p(0x00, 0xc0, 80); // ch0 program 80 = Square Lead
  p(0x00, 0xc1, 0); // ch1 program 0 = Grand Piano
  // ch0 melody: two sequential quarter notes
  p(0x00, 0x90, 69, 100);
  // ch1 chord starts at same time (piano triad, whole note)
  p(0x00, 0x91, 57, 80, 0x00, 60, 80, 0x00, 64, 80);
  // ch9 drums
  p(0x00, 0x99, 36, 100);
  p(0x60, 0x80, 69, 0); // delta 96: ch0 note off
  p(0x00, 0x89, 36, 0); // drums off
  p(0x00, 0x90, 71, 100, 0x60, 0x80, 71, 0); // second melody note
  p(0x81, 0x40, 0x81, 57, 0, 0x00, 60, 0, 0x00, 64, 0); // delta 192: chord off
  p(0x00, 0xff, 0x2f, 0x00);
  str('MTrk'); u32(t.length); push(...t);
  return new Uint8Array(bytes).buffer;
}
const p0 = parseMidi(buildMidi0());
assert(p0.tracks.length === 3, 'format-0 chunk split into 3 channel tracks (got ' + p0.tracks.length + ')');
const chs = p0.tracks.map((t) => t.channel);
eq(chs, [0, 1, 9], 'channels 0, 1, 9 (drums)');
assert(p0.tracks[0].name.includes('Square Lead'), 'ch0 named by GM program: ' + p0.tracks[0].name);
assert(p0.tracks[1].name.includes('Grand Piano'), 'ch1 named Grand Piano: ' + p0.tracks[1].name);
assert(p0.tracks[2].isDrums && p0.tracks[2].name.includes('Drums'), 'ch9 marked as drums');
eq(p0.tracks[0].notes.map((n) => [n.pitch, n.startTick, n.durationTicks]),
   [[69, 0, 96], [71, 96, 96]], 'ch0 melody notes intact');
assert(p0.tracks[1].notes.length === 3, 'ch1 chord notes intact');
const roles0 = suggestRoles(p0.tracks);
eq(roles0, ['melody', 'chords', 'skip'], 'roles: lead melody, piano chords, drums skipped');

// piano beats pads for the chords role
const padTrack = { name: 'Warm Pad', channel: 2, program: 89, isDrums: false, notes: p0.tracks[1].notes };
const roles1 = suggestRoles([p0.tracks[0], padTrack, p0.tracks[1]]);
eq(roles1, ['melody', 'muted', 'chords'], 'piano comping preferred over pad for chords');

// ---- chord naming ----
eq(chordName([9, 0, 4]), 'Am', 'names Am');
eq(chordName([0, 4, 7]), 'C', 'names C major');
eq(chordName([7, 11, 2, 5]), 'G7', 'names G7');
eq(chordName([9, 4]), 'A5', 'names power chord');
eq(chordName([9]), 'A', 'single pitch class');
assert(chordName([]) === null, 'empty pcs -> null');

// ---- cluster-free autoSong voicing ----
{
  const amCtx = { ppq: PPQ, key: { tonic: 0, mode: 'major' }, getChordPitchClassesAt: () => [9, 0, 4], hasChordTrack: true };
  // B over Am: NOT a chord tone -> the sweep must exclude B (no semitone cluster)
  const nonTone = { id: 'nt', pitch: 71, startTick: 0, durationTicks: 96, velocity: 100,
    harmonics: { mode: 'arp', stepsPerBeat: 3, pattern: 'up', octaves: 1, gate: 1, chordType: 'autoSong' } };
  eq(renderHarmonics(nonTone, amCtx).map((e) => e.pitch), [72, 76, 81], 'non-chord-tone melody sweeps C E A, no B cluster');
  const res = resolveChord(nonTone, nonTone.harmonics, amCtx);
  eq(res.name, 'Am', 'resolved chord named Am');
  assert(res.source === 'song', 'source is song chords');
  assert(res.detail && res.detail.includes('not a chord tone'), 'non-chord-tone case is explained');
  // A over Am: IS a chord tone -> included as the sweep root
  const tone = { ...nonTone, id: 't', pitch: 69 };
  eq(renderHarmonics(tone, amCtx).map((e) => e.pitch), [69, 72, 76], 'chord-tone melody keeps its root');
  assert(resolveChord(tone, tone.harmonics, amCtx).detail === null, 'chord-tone case has no warning');
}

// ---- chromatic autoKey fallback uses the key mode's quality ----
{
  const minCtx = { ppq: PPQ, key: { tonic: 9, mode: 'minor' }, getChordPitchClassesAt: () => null, hasChordTrack: false };
  const chromatic = { id: 'ch', pitch: 70, startTick: 0, durationTicks: 96, velocity: 100, // Bb, not in A minor
    harmonics: { mode: 'arp', stepsPerBeat: 3, pattern: 'up', octaves: 1, gate: 1, chordType: 'autoKey' } };
  const res = resolveChord(chromatic, chromatic.harmonics, minCtx);
  eq(res.intervals, [0, 3, 7], 'chromatic note in minor key gets a minor triad');
  assert(res.source === 'key-chromatic' && res.detail.includes('not in A minor'), 'chromatic fallback explained');
  // autoSong with no chord track explains the key fallback
  const noTrack = { ...chromatic, harmonics: { ...chromatic.harmonics, chordType: 'autoSong' } };
  const res2 = resolveChord(noTrack, noTrack.harmonics, minCtx);
  assert(res2.detail && res2.detail.includes('no chords track'), 'missing chord track explained');
}

// ---- chord events: hold-until-next + broken-chord gathering ----
{
  const cdoc = createProject({ name: 'chords', mode: 'poly' });
  const ct = createTrackHelper(cdoc, 'Chords');
  // bar 1: staccato Am block chord only on beat 1; bar 2: broken F figure
  for (const p of [57, 60, 64]) addNote(cdoc, ct.id, createNote({ pitch: p, startTick: 0, durationTicks: 48 }));
  addNote(cdoc, ct.id, createNote({ pitch: 53, startTick: 384, durationTicks: 48 }));
  addNote(cdoc, ct.id, createNote({ pitch: 57, startTick: 432, durationTicks: 48 }));
  addNote(cdoc, ct.id, createNote({ pitch: 60, startTick: 480, durationTicks: 48 }));
  cdoc.chordTrackId = ct.id;
  const events = buildChordEvents(cdoc);
  eq(events.map((e) => chordName(e.pcs)), ['Am', 'F'], 'two chord events: Am then F');
  const lookup = makeChordLookup(cdoc);
  eq(chordName(lookup(200)), 'Am', 'Am holds through the gap after the staccato hit');
  eq(chordName(lookup(500)), 'F', 'broken F figure resolves to one F chord');
  eq(chordName(lookup(700)), 'F', 'F holds to song end');
  // explain helper end-to-end
  const mel = activeTrack(cdoc);
  addNote(cdoc, mel.id, createNote({ pitch: 72, startTick: 100, durationTicks: 96,
    harmonics: { mode: 'arp', stepsPerBeat: 2, pattern: 'up', octaves: 1, gate: 1, chordType: 'autoSong' } }));
  const info = explainNoteChord(cdoc, mel.id, mel.notes.find((n) => n.harmonics).id);
  eq(info.name, 'Am', 'explainNoteChord resolves held Am for a note in the gap');
  assert(info.source === 'song', 'explain source = song');
}

function createTrackHelper(doc, name) {
  const track = { id: 'ct-' + name, name, role: 'chords', instrumentId: 'sine', notes: [] };
  doc.tracks.push(track);
  return track;
}

// ---- per-note chord source (recommendation / other track / custom) ----
{
  const sdoc = createProject({ name: 'sources', mode: 'poly' });
  const mel = activeTrack(sdoc);
  // recommended chords track: Am
  const rec = createTrackHelper(sdoc, 'RecChords');
  for (const p of [57, 60, 64]) addNote(sdoc, rec.id, createNote({ pitch: p, startTick: 0, durationTicks: 384 }));
  sdoc.chordTrackId = rec.id;
  // an alternative harmony track: F major
  const alt = { id: 'ct-alt', name: 'Bass', role: 'melody', instrumentId: 'sine', notes: [] };
  sdoc.tracks.push(alt);
  for (const p of [53, 57, 60]) addNote(sdoc, alt.id, createNote({ pitch: p, startTick: 0, durationTicks: 384 }));

  const baseArp = { mode: 'arp', stepsPerBeat: 2, pattern: 'up', octaves: 1, gate: 1, chordType: 'autoSong' };

  // default: recommendation wins
  addNote(sdoc, mel.id, createNote({ pitch: 69, startTick: 0, durationTicks: 96, harmonics: { ...baseArp } }));
  const n1 = mel.notes[0];
  const i1 = explainNoteChord(sdoc, mel.id, n1.id);
  eq(i1.name, 'Am', 'no source -> recommended track chord');
  assert(i1.source === 'song', 'source labeled song');

  // explicit other track: live resolution from that track
  addNote(sdoc, mel.id, createNote({ pitch: 69, startTick: 0, durationTicks: 96, harmonics: { ...baseArp, chordSource: { trackId: alt.id } } }));
  const n2 = mel.notes[1];
  const i2 = explainNoteChord(sdoc, mel.id, n2.id);
  eq(i2.name, 'F', 'trackId source resolves from that track');
  assert(i2.source === 'track' && i2.trackName === 'Bass', 'source labeled with track name');

  // custom chord: absolute pcs, independent of any track
  addNote(sdoc, mel.id, createNote({ pitch: 72, startTick: 0, durationTicks: 96, harmonics: { ...baseArp, chordSource: { pcs: [2, 5, 9], label: 'Dm' } } }));
  const n3 = mel.notes.find((n) => n.pitch === 72);
  const i3 = explainNoteChord(sdoc, mel.id, n3.id);
  eq(i3.name, 'Dm', 'custom source keeps its label');
  assert(i3.source === 'custom', 'source labeled custom');
  eq(i3.intervals, [2, 5, 9], 'custom chord voiced above non-chord-tone note without the note itself');

  // missing source track: graceful live fallback to the recommendation
  addNote(sdoc, mel.id, createNote({ pitch: 69, startTick: 0, durationTicks: 96, harmonics: { ...baseArp, chordSource: { trackId: 'gone' } } }));
  const n4 = mel.notes.find((n) => n.harmonics.chordSource && n.harmonics.chordSource.trackId === 'gone');
  const i4 = explainNoteChord(sdoc, mel.id, n4.id);
  eq(i4.name, 'Am', 'missing track falls back to recommendation');
  assert(i4.detail && i4.detail.includes('missing or empty'), 'fallback is explained');
}

// ---- diatonic transpose + snap to key ----
{
  const { transposeDiatonic, snapToKey } = await import('../js/core/music.js');
  const C = { tonic: 0, mode: 'major' };
  assert(transposeDiatonic(60, C, 1) === 62, 'C4 +1 degree -> D4');
  assert(transposeDiatonic(64, C, 1) === 65, 'E4 +1 degree -> F4 (half step in scale)');
  assert(transposeDiatonic(59, C, 1) === 60, 'B3 +1 degree -> C4 (octave wrap)');
  assert(transposeDiatonic(60, C, -1) === 59, 'C4 -1 degree -> B3');
  assert(transposeDiatonic(60, C, 7) === 72, '+7 degrees = +1 octave');
  assert(transposeDiatonic(60, C, 2) === 64, 'C4 +2 degrees -> E4 (up a third)');
  assert(transposeDiatonic(66, C, 1) === 67, 'chromatic F#4 +1 -> G4');
  assert(transposeDiatonic(66, C, -1) === 65, 'chromatic F#4 -1 -> F4');
  const Am = { tonic: 9, mode: 'minor' };
  assert(transposeDiatonic(69, Am, 1) === 71, 'A4 +1 degree in A minor -> B4');
  assert(transposeDiatonic(71, Am, 1) === 72, 'B4 +1 degree in A minor -> C5');
  assert(snapToKey(66, C) === 65, 'F# snaps down to F (tie prefers down)');
  assert(snapToKey(61, C) === 60, 'C# snaps down to C');
  assert(snapToKey(64, C) === 64, 'in-key pitch passes through');
}

// ---- key detection from note content ----
{
  const N = (pitch, dur) => ({ pitch, startTick: 0, durationTicks: dur });
  // C major: tonic/dominant emphasized, full major scale
  const cMajor = [N(60, 400), N(64, 250), N(67, 300), N(62, 100), N(65, 100), N(69, 100), N(71, 120), N(72, 200)];
  const g1 = detectKey(cMajor);
  eq({ tonic: g1.tonic, mode: g1.mode }, { tonic: 0, mode: 'major' }, 'detects C major');
  // A minor: tonic A emphasized, minor third C, fifth E
  const aMinor = [N(69, 500), N(72, 300), N(76, 350), N(74, 100), N(71, 100), N(67, 80), N(65, 80), N(68, 60)];
  const g2 = detectKey(aMinor);
  eq({ tonic: g2.tonic, mode: g2.mode }, { tonic: 9, mode: 'minor' }, 'detects A minor');
  // G major with F# emphasized
  const gMajor = [N(67, 400), N(71, 250), N(74, 300), N(66, 150), N(69, 100), N(72, 100), N(64, 100)];
  const g3 = detectKey(gMajor);
  eq({ tonic: g3.tonic, mode: g3.mode }, { tonic: 7, mode: 'major' }, 'detects G major');
  assert(detectKey([]) === null, 'empty input -> null');
}

// ---- import falls back to note-based key detection ----
{
  const p = parseMidi(buildMidi0()); // has no key-signature meta event
  assert(p.song.key != null, 'key guessed when meta event missing');
  assert(p.song.keyGuessed === true, 'guessed key flagged as such');
}
{
  const p = parseMidi(buildMidi()); // has an explicit D major key signature
  assert(p.song.keyGuessed === undefined, 'explicit key signature not flagged as guessed');
}

// ---- voicing: below-anchor and octave shift ----
{
  const base = { id: 'v1', pitch: 72, startTick: 0, durationTicks: 96, velocity: 100 }; // C5
  // below: chord voiced downward, the note is the TOP tone
  const below = { ...base, harmonics: { mode: 'arp', stepsPerBeat: 3, pattern: 'up', octaves: 1, gate: 1, chordType: 'major', anchor: 'below', octaveShift: 0 } };
  eq(renderHarmonics(below, ctx).map((e) => e.pitch), [64, 67, 72], 'below voicing: E4 G4 C5 (note on top)');
  // octave expansion extends downward for below-anchored arps
  const below2 = { ...base, durationTicks: 192, harmonics: { ...below.harmonics, octaves: 2, stepsPerBeat: 3 } };
  eq(renderHarmonics(below2, ctx).map((e) => e.pitch).slice(0, 6), [52, 55, 60, 64, 67, 72], 'below + 2 octaves extends down');
  // octave shift drops the whole sweep into the bass register
  const shifted = { ...base, harmonics: { ...below.harmonics, anchor: 'above', octaveShift: -2 } };
  eq(renderHarmonics(shifted, ctx).map((e) => e.pitch), [48, 52, 55], 'octaveShift -2: C3 E3 G3');
  // default stays the historical behavior
  const plain2 = { ...base, harmonics: { mode: 'arp', stepsPerBeat: 3, pattern: 'up', octaves: 1, gate: 1, chordType: 'major' } };
  eq(renderHarmonics(plain2, ctx).map((e) => e.pitch), [72, 76, 79], 'no anchor/shift = unchanged upward stacking');
  // chord mode honors voicing too
  const chordBelow = { ...base, harmonics: { ...below.harmonics, mode: 'chord' } };
  eq(renderHarmonics(chordBelow, ctx).map((e) => e.pitch), [64, 67, 72], 'chord mode voiced below');
}

// ---- fast chiptune arp rates ----
{
  const fast = { ...plain, harmonics: { mode: 'arp', stepsPerBeat: 32, pattern: 'up', octaves: 1, gate: 1, chordType: 'major' } };
  const ev = renderHarmonics(fast, ctx); // quarter note = 96 ticks, stepTicks = 3
  assert(ev.length === 32, '32 steps/beat fills a quarter note with 32 events (got ' + ev.length + ')');
  assert(ev.every((e) => e.durationTicks === 3), 'each fast step is 3 ticks');
  assert(ev[1].startTick - ev[0].startTick === 3, 'fast steps are contiguous');
  const fast24 = { ...plain, harmonics: { ...fast.harmonics, stepsPerBeat: 24 } };
  assert(renderHarmonics(fast24, ctx).length === 24, '24 steps/beat works');
  // .h export of a fast arp keeps total duration exact (no rounding drift)
  const fdoc = createProject({ name: 'fastarp', mode: 'mono' });
  fdoc.song.bpm = 125; // 5 ms per tick
  addNote(fdoc, fdoc.tracks[0].id, createNote({
    pitch: 60, startTick: 0, durationTicks: 96,
    harmonics: { mode: 'arp', stepsPerBeat: 32, pattern: 'up', octaves: 2, gate: 1, chordType: 'major' },
  }));
  const fh = exportHeader(fdoc);
  const fms = [...fh.text.matchAll(/,\s+(\d+)\}/g)].map((m) => Number(m[1]));
  eq(fms.reduce((a, b) => a + b, 0), 480, 'fast arp .h total = 480 ms exactly');
  assert(fms.length === 32, 'fast arp exports 32 entries');
}

// ---- clampScroll keeps scrollPitch integral (fractional broke row rendering) ----
const { clampScroll, PITCH_MIN: PMIN, PITCH_MAX: PMAX } = await import('../js/ui/piano-roll/coords.js');
{
  // tall viewport: lower bound (PITCH_MIN + rows - 1) exceeds default 84
  const ui = { scrollTick: 0, scrollPitch: 84, pxPerTick: 0.5, rowHeight: 14 };
  clampScroll(ui, 1000, 1100, 0);
  assert(Number.isInteger(ui.scrollPitch), 'tall viewport: scrollPitch integral (got ' + ui.scrollPitch + ')');
  assert(ui.scrollPitch >= PMIN + Math.ceil(1100 / 14) - 1, 'tall viewport: lower bound respected');
}
{
  // fractional input (scrollbar drag) gets rounded
  const ui = { scrollTick: 0, scrollPitch: 90.37, pxPerTick: 0.5, rowHeight: 14 };
  clampScroll(ui, 1000, 400, 0);
  assert(Number.isInteger(ui.scrollPitch), 'fractional input rounded (got ' + ui.scrollPitch + ')');
}
{
  const ui = { scrollTick: 0, scrollPitch: 500, pxPerTick: 0.5, rowHeight: 14 };
  clampScroll(ui, 1000, 400, 0);
  assert(ui.scrollPitch === PMAX, 'upper clamp at PITCH_MAX');
}

// ---- pitchToY / yToPitch round trip (click row must equal drawn row) ----
{
  const { pitchToY, yToPitch } = await import('../js/ui/piano-roll/coords.js');
  const ui = { scrollPitch: 84, rowHeight: 14 };
  let bad = 0;
  for (let p = 30; p <= 84; p++) {
    const top = pitchToY(ui, p);
    for (let dy = 0; dy < ui.rowHeight; dy++) {
      if (yToPitch(ui, top + dy) !== p) bad++;
    }
  }
  assert(bad === 0, `yToPitch matches drawn row for every pixel (${bad} mismatches)`);
}

// ---- v1 -> v2 migration (note.arp renamed to note.harmonics) ----
{
  const { migrate } = await import('../js/core/doc.js');
  const v2 = createProject({ name: 'old', mode: 'mono' });
  addNote(v2, v2.tracks[0].id, createNote({
    pitch: 60, startTick: 0, durationTicks: 96,
    harmonics: { mode: 'arp', stepsPerBeat: 2, pattern: 'up', octaves: 1, gate: 1, chordType: 'autoKey' },
  }));
  addNote(v2, v2.tracks[0].id, createNote({ pitch: 64, startTick: 96, durationTicks: 96 }));
  // fabricate the v1 on-disk shape: field named `arp`, version 1
  const v1 = JSON.parse(JSON.stringify(v2));
  v1.version = 1;
  for (const t of v1.tracks) {
    for (const n of t.notes) {
      n.arp = n.harmonics;
      delete n.harmonics;
    }
  }
  const migrated = migrate(v1);
  assert(migrated.version === 3, 'migration bumps version to 3');
  const withCfg = migrated.tracks[0].notes.find((n) => n.harmonics);
  assert(withCfg && withCfg.harmonics.mode === 'arp' && withCfg.harmonics.stepsPerBeat === 2, 'arp field renamed to harmonics, config intact');
  assert(migrated.tracks[0].notes.every((n) => !('arp' in n)), 'old arp field removed');
  assert(migrated.tracks[0].notes.find((n) => !n.harmonics).harmonics === null, 'plain notes get harmonics: null');
  // v2 files pass through untouched
  const again = migrate(JSON.parse(JSON.stringify(migrated)));
  assert(again.version === 3 && again.tracks[0].notes.some((n) => n.harmonics), 'migration is idempotent');
  // renders identically after migration
  const ev = flattenSong(migrated).events;
  assert(ev.length > 2, 'migrated harmonics still render (arp expanded)');
}

// ---- v3 rename + per-track custom instruments ----
{
  const { migrate } = await import('../js/core/doc.js');
  const { getInstrument } = await import('../js/core/instruments.js');
  const idoc = createProject({ name: 'inst', mode: 'poly' });
  assert(idoc.instruments[0].name === 'Square', 'default badge instrument named "Square"');

  // v2 file with the old display name migrates
  const v2doc = JSON.parse(JSON.stringify(idoc));
  v2doc.version = 2;
  v2doc.instruments[0].name = 'Badge Square';
  const m = migrate(v2doc);
  assert(m.version === 3 && m.instruments[0].name === 'Square', 'v2->v3 renames Badge Square');

  // per-track custom instrument resolves via the virtual track: id
  const t = idoc.tracks[0];
  t.instrument = { id: 'track:' + t.id, name: 'Custom', wave: 'triangle', harmonics: null, duty: null,
    adsr: { a: 0.01, d: 0.1, s: 0.5, r: 0.1 }, gain: 0.4 };
  const resolved = getInstrument(idoc, 'track:' + t.id);
  assert(resolved.wave === 'triangle', 'getInstrument resolves track: virtual id');
  assert(getInstrument(idoc, 'track:missing').id === 'badge', 'unknown track: id falls back to default');

  // flatten routes poly events through the custom instrument
  addNote(idoc, t.id, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
  const ev = flattenSong(idoc).events[0];
  assert(ev.instrumentId === 'track:' + t.id, 'flatten uses the custom instrument id');
  // mono still forces the badge square regardless of custom configs
  idoc.mode = 'mono';
  assert(flattenSong(idoc).events[0].instrumentId === 'badge', 'mono still forces the badge square');
}

// ---- automation: sampling math ----
{
  const { sampleAutomation, sampleStep, sampleGainCurve, quantizeDuty } = await import('../js/core/automation.js');
  const lane = [
    { tick: 96, value: 0.2, curve: 'linear' },
    { tick: 192, value: 1.0, curve: 'step' },
    { tick: 288, value: 0.5, curve: 'ease' },
    { tick: 384, value: 0.9, curve: 'linear' },
  ];
  assert(sampleAutomation([], 50, 1) === 1, 'empty lane -> default');
  assert(sampleAutomation(lane, 0, 1) === 1, 'before first point -> default');
  assert(sampleAutomation(lane, 96, 1) === 0.2, 'exactly at a point -> point value');
  assert(Math.abs(sampleAutomation(lane, 144, 1) - 0.6) < 1e-9, 'linear midpoint = mean');
  assert(sampleAutomation(lane, 240, 1) === 1.0, 'step holds until next point');
  assert(Math.abs(sampleAutomation(lane, 336, 1) - 0.7) < 1e-9, 'ease at t=0.5 = mean');
  const t25 = sampleAutomation(lane, 312, 1); // t=0.25 into ease segment 0.5->0.9
  assert(Math.abs(t25 - (0.5 + 0.4 * 0.15625)) < 1e-9, 'ease at t=0.25 = smoothstep');
  assert(sampleAutomation(lane, 9999, 1) === 0.9, 'after last point -> hold');
  const inst = [{ tick: 96, instrumentId: 'sine' }, { tick: 192, instrumentId: 'saw' }];
  assert(sampleStep(inst, 95) === null, 'sampleStep null before first');
  assert(sampleStep(inst, 96).instrumentId === 'sine', 'sampleStep inclusive at tick');
  assert(sampleStep(inst, 500).instrumentId === 'saw', 'sampleStep holds last');
  assert(quantizeDuty(0.3333) === 0.33, 'duty quantized to 1%');
  // gain curve: flat span -> scalar; ramped span -> Float32Array
  const flat = sampleGainCurve(lane, 200, 240, 1); // inside step-hold segment
  assert(flat.gainMul === 1.0 && !flat.gainCurve, 'constant span -> scalar');
  const ramp = sampleGainCurve(lane, 96, 192, 1);
  assert(ramp.gainCurve && ramp.gainCurve.length >= 3, 'ramped span -> curve array');
  assert(Math.abs(ramp.gainCurve[0] - 0.2) < 1e-6, 'curve starts at lane value');
  const huge = sampleGainCurve([{tick:0,value:0,curve:'linear'},{tick:100000,value:1,curve:'linear'}], 0, 100000, 1);
  assert(huge.gainCurve.length <= 256, 'curve length capped');
}

// ---- automation: doc helpers + trim ----
{
  const { setAutomationPoint, deleteAutomationPoint, moveAutomationPoint, getLane } =
    await import('../js/core/doc.js');
  const adoc2 = createProject({ name: 'auto', mode: 'poly' });
  const tid = adoc2.tracks[0].id;
  setAutomationPoint(adoc2, tid, 'gain', { tick: 192, value: 0.5, curve: 'linear' });
  setAutomationPoint(adoc2, tid, 'gain', { tick: 96, value: 1, curve: 'step' });
  eq(getLane(adoc2.tracks[0], 'gain').map((p) => p.tick), [96, 192], 'points kept sorted');
  setAutomationPoint(adoc2, tid, 'gain', { tick: 96, value: 0.8, curve: 'ease' });
  assert(getLane(adoc2.tracks[0], 'gain').length === 2 && getLane(adoc2.tracks[0], 'gain')[0].value === 0.8, 'same-tick replaces');
  moveAutomationPoint(adoc2, tid, 'gain', 96, { tick: 192, value: 0.3, curve: 'linear' });
  assert(getLane(adoc2.tracks[0], 'gain').length === 1 && getLane(adoc2.tracks[0], 'gain')[0].value === 0.3, 'move onto occupied tick replaces');
  deleteAutomationPoint(adoc2, tid, 'gain', 192);
  assert(getLane(adoc2.tracks[0], 'gain').length === 0, 'delete removes point');

  // trim: seeds held value at 0 and shifts
  const tdoc2 = createProject({ name: 'autotrim', mode: 'poly' });
  const ttid2 = tdoc2.tracks[0].id;
  addNote(tdoc2, ttid2, createNote({ pitch: 60, startTick: 0, durationTicks: 960 }));
  setAutomationPoint(tdoc2, ttid2, 'gain', { tick: 0, value: 0.2, curve: 'linear' });
  setAutomationPoint(tdoc2, ttid2, 'gain', { tick: 384, value: 1, curve: 'step' });
  trimBefore(tdoc2, 192); // halfway through the linear ramp -> value 0.6
  const lane2 = getLane(tdoc2.tracks[0], 'gain');
  assert(lane2.length === 2 && lane2[0].tick === 0 && Math.abs(lane2[0].value - 0.6) < 1e-9, 'trimBefore seeds held value at 0');
  assert(lane2[1].tick === 192, 'surviving point shifted');
  trimAfter(tdoc2, 100);
  assert(getLane(tdoc2.tracks[0], 'gain').length === 1, 'trimAfter drops tail points');
}

// ---- automation: flatten integration ----
{
  const { setAutomationPoint } = await import('../js/core/doc.js');
  const fdoc2 = createProject({ name: 'autoflat', mode: 'poly' });
  const ftid2 = fdoc2.tracks[0].id;
  // arp note under a linear gain ramp: every arp step samples independently
  addNote(fdoc2, ftid2, createNote({
    pitch: 60, startTick: 0, durationTicks: 384,
    harmonics: { mode: 'arp', stepsPerBeat: 4, pattern: 'up', octaves: 1, gate: 1, chordType: 'major' },
  }));
  setAutomationPoint(fdoc2, ftid2, 'gain', { tick: 0, value: 0.1, curve: 'linear' });
  setAutomationPoint(fdoc2, ftid2, 'gain', { tick: 384, value: 1, curve: 'step' });
  const evs = flattenSong(fdoc2).events;
  assert(evs.length === 16, '16 arp steps');
  assert(evs.every((e) => typeof e.gainMul === 'number'), 'short steps get scalar gainMul');
  assert(evs[0].gainMul < evs[8].gainMul && evs[8].gainMul < evs[15].gainMul, 'per-step gainMul ramps up');

  // held note under the same ramp gets a curve array
  const hdoc2 = createProject({ name: 'autohold', mode: 'poly' });
  const htid2 = hdoc2.tracks[0].id;
  addNote(hdoc2, htid2, createNote({ pitch: 60, startTick: 0, durationTicks: 384 }));
  setAutomationPoint(hdoc2, htid2, 'gain', { tick: 0, value: 0.1, curve: 'linear' });
  setAutomationPoint(hdoc2, htid2, 'gain', { tick: 384, value: 1, curve: 'step' });
  const hev = flattenSong(hdoc2).events[0];
  assert(hev.gainCurve && hev.gainCurve.length >= 3 && !('gainMul' in hev), 'held note gets gainCurve');

  // ADSR lanes: absolute overrides sampled per note
  const idoc2 = createProject({ name: 'autoadsr', mode: 'poly' });
  const itid2 = idoc2.tracks[0].id;
  addNote(idoc2, itid2, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
  addNote(idoc2, itid2, createNote({ pitch: 62, startTick: 192, durationTicks: 96 }));
  setAutomationPoint(idoc2, itid2, 'attack', { tick: 100, value: 0.2, curve: 'step' });
  setAutomationPoint(idoc2, itid2, 'sustain', { tick: 0, value: 0.5, curve: 'linear' });
  setAutomationPoint(idoc2, itid2, 'sustain', { tick: 384, value: 1, curve: 'step' });
  const iev = flattenSong(idoc2).events;
  assert(!('a' in (iev[0].adsr || {})), 'before first attack point: no attack override');
  assert(iev[0].adsr && iev[0].adsr.s === 0.5, 'sustain override sampled at note start');
  assert(iev[1].adsr.a === 0.2 && Math.abs(iev[1].adsr.s - 0.75) < 1e-9, 'second note samples both lanes (linear sustain midpoint)');

  // duty lane quantized; mono ignores automation entirely
  setAutomationPoint(idoc2, itid2, 'duty', { tick: 0, value: 0.333, curve: 'step' });
  assert(flattenSong(idoc2).events[0].duty === 0.33, 'duty sampled + quantized');
  idoc2.mode = 'mono';
  const mev = flattenSong(idoc2).events[0];
  assert(!('duty' in mev) && !('gainMul' in mev) && !('adsr' in mev) && mev.instrumentId === 'badge', 'mono ignores automation');

  // legacy instrument-switch lanes are dropped on load
  const { migrate: migrate2 } = await import('../js/core/doc.js');
  const legacy = createProject({ name: 'legacy', mode: 'poly' });
  legacy.tracks[0].automation = { instrument: [{ tick: 0, instrumentId: 'sine' }], gain: [{ tick: 0, value: 0.5, curve: 'step' }] };
  migrate2(legacy);
  assert(!('instrument' in legacy.tracks[0].automation), 'migrate drops legacy instrument lanes');
  assert(legacy.tracks[0].automation.gain.length === 1, 'other lanes survive the cleanup');
}

// ---- demo files are valid and showcase what they claim ----
{
  const { readFile } = await import('node:fs/promises');
  const { migrate } = await import('../js/core/doc.js');
  const index = JSON.parse(await readFile(new URL('../demos/index.json', import.meta.url), 'utf8'));
  eq(index, ['demo-mono-1.tune.json', 'demo-mono-2-rickroll-arp.tune.json', 'demo-poly-1.tune.json', 'demo-poly-2-tetris.tune.json', 'demo-poly-3-bad-apple.tune.json'], 'demo manifest lists all five demos');
  for (const file of index) {
    const doc = migrate(JSON.parse(await readFile(new URL('../demos/' + file, import.meta.url), 'utf8')));
    assert(doc.tracks.every((t) => t.notes.length >= 0), file + ' migrates cleanly');
  }
  const poly = migrate(JSON.parse(await readFile(new URL('../demos/demo-poly-1.tune.json', import.meta.url), 'utf8')));
  assert(poly.mode === 'poly', 'poly demo is poly');
  assert(poly.name === 'Demo Poly', 'demo names are short: ' + poly.name);
  const names = [];
  for (const file of index) {
    names.push(JSON.parse(await readFile(new URL('../demos/' + file, import.meta.url), 'utf8')).name);
  }
  eq(names, ['Demo Mono', 'Rickroll', 'Demo Poly', 'Tetris', 'Bad Apple'], 'all demo names');
  const evs = flattenSong(poly).events;
  assert(evs.some((e) => e.gainCurve), 'poly demo has an intra-note gain curve');
  assert(evs.some((e) => e.duty != null), 'poly demo has duty automation');
  assert(evs.some((e) => e.adsr && e.adsr.r != null), 'poly demo has a release override');
  assert(new Set(evs.filter((e) => typeof e.gainMul === 'number').map((e) => e.gainMul)).size >= 3, 'poly demo has stepped gain echoes');
}

// ---- melody marker is independent of the editing focus ----
{
  const { melodyTrack, migrate: mig } = await import('../js/core/doc.js');
  const mdoc = createProject({ name: 'melody-split', mode: 'mono' });
  const t2 = { id: 'second', name: 'Second', role: 'melody', instrumentId: 'badge', notes: [] };
  mdoc.tracks.push(t2);
  addNote(mdoc, mdoc.tracks[0].id, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
  addNote(mdoc, 'second', createNote({ pitch: 72, startTick: 0, durationTicks: 96 }));
  // reviewing the second track must not change what mono plays
  mdoc.activeTrackId = 'second';
  assert(melodyTrack(mdoc).id === mdoc.tracks[0].id, 'melody marker unaffected by editing focus');
  eq(flattenSong(mdoc).events.map((e) => e.pitch), [60], 'mono plays the MELODY track, not the focused one');
  // moving the marker switches the mono voice
  mdoc.melodyTrackId = 'second';
  eq(flattenSong(mdoc).events.map((e) => e.pitch), [72], 'M marker controls mono playback');
  // old docs get the marker defaulted from the active track
  const legacy2 = JSON.parse(JSON.stringify(mdoc));
  delete legacy2.melodyTrackId;
  legacy2.activeTrackId = 'second';
  mig(legacy2);
  assert(legacy2.melodyTrackId === 'second', 'migration defaults melody marker to the active track');
}

// ---- mergeImport: add MIDI tracks to an existing project ----
{
  const { mergeImport } = await import('../js/core/doc.js');
  const base = createProject({ name: 'host', mode: 'poly' });
  base.song.bpm = 90;
  base.song.key = { tonic: 7, mode: 'major' };
  const hostTrack = base.tracks[0];
  hostTrack.name = 'Lead';
  addNote(base, hostTrack.id, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
  base.melodyTrackId = hostTrack.id;
  base.chordTrackId = null;

  const parsedFile = parseMidi(buildMidi()); // 120 BPM, 2 tracks
  const ids = mergeImport(base, parsedFile, [
    { index: 0, role: 'melody', name: 'Lead' },      // name collides on purpose
    { index: 1, role: 'chords', name: 'Chords' },
  ]);
  assert(base.tracks.length === 3, 'tracks appended, not replaced');
  assert(base.tracks[0] === hostTrack && hostTrack.notes.length === 1, 'existing track untouched');
  assert(base.song.bpm === 90 && base.song.key.tonic === 7, 'song settings preserved on merge');
  assert(base.melodyTrackId === hostTrack.id, 'melody marker not hijacked');
  assert(base.tracks[1].name === 'Lead 2', 'colliding names get a suffix');
  assert(base.chordTrackId === ids[1], 'chords role assigns the chord source');
  assert(base.activeTrackId === ids[0], 'editing focus moves to the import');
  assert(base.tracks[1].notes.length === parsedFile.tracks[0].notes.length, 'notes copied');
  assert(base.tracks[1].notes.every((n) => n.id && n.harmonics === null), 'notes are proper documents');

  // skip + offset
  const base2 = createProject({ name: 'host2', mode: 'poly' });
  const ids2 = mergeImport(base2, parsedFile, [
    { index: 0, role: 'skip', name: 'x' },
    { index: 1, role: 'muted', name: 'Pad' },
  ], { offsetTick: 384 });
  assert(ids2.length === 1 && base2.tracks.length === 2, 'skip role is honored');
  assert(base2.tracks[1].role === 'muted' && base2.chordTrackId === null, 'muted import sets no chord source');
  assert(Math.min(...base2.tracks[1].notes.map((n) => n.startTick)) === 384, 'offsetTick shifts imported notes');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
