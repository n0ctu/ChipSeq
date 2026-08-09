// Unit tests for the ChipSeq core (no DOM/audio needed).
// Run: node tests/unit.mjs
import { renderHarmonics, chordIntervals, resolveChord } from '../js/core/harmonics.js';
import { flattenSong, flattenNote, buildChordEvents, makeChordLookup, explainNoteChord } from '../js/core/flatten.js';
import { chordName } from '../js/core/music.js';
import { exportHeader, pitchSymbol, sanitizeSymbolName } from '../js/core/export-h.js';
import { parseMidi, suggestRoles } from '../js/core/midi-import.js';
import {
  createProject, createNote, addNote, trimBefore, trimAfter, findOverlaps,
  autoFixOverlaps, activeTrack, applyImport, setTempo, setTimeSig, bpmAt, timeSigAt,
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
setTempo(doc, 125); // 1 tick = 5 ms exactly at PPQ 96? 60000/(125*96) = 5 ms. yes.
const trackId = doc.tracks[0].id;
addNote(doc, trackId, createNote({ pitch: 64, startTick: 0, durationTicks: 96 })); // overlaps next
addNote(doc, trackId, createNote({ pitch: 72, startTick: 48, durationTicks: 48 }));
const flat = flattenSong(doc);
assert(flat.warnings.some((w) => w.type === 'overlap'), 'overlap warning emitted');
eq(flat.events.map((e) => [e.pitch, e.startTick, e.durationTicks]), [[64, 0, 48], [72, 48, 48]], 'mono truncation');

// ---- export-h ----
const hdoc = createProject({ name: 'start sound!', mode: 'mono' });
setTempo(hdoc, 125); // 5 ms per tick
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
setTempo(adoc, 125);
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
  setTempo(rdoc, 125); // 5 ms per tick
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
  setTempo(fdoc, 140);
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
  setTempo(ddoc, 120);
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
  setTempo(adoc2, 120);
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
  assert(JSON.parse(JSON.stringify(lstore.getDoc())).loop.endTick === 480, 'loop survives serialization (.chipseq.json)');
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
  assert(JSON.parse(JSON.stringify(gstore.getDoc())).grid.snapTicks === 24, 'grid survives serialization (.chipseq.json)');
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
assert(parsed.song.tempo[0].bpm === 120, 'tempo parsed: ' + JSON.stringify(parsed.song.tempo));
eq(parsed.song.meter, [{ tick: 0, num: 3, den: 4 }], 'meter map parsed');
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
assert(bpmAt(idoc, 0) === 120 && timeSigAt(idoc, 0).num === 3, 'song meta applied');

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
  setTempo(fdoc, 125); // 5 ms per tick
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
  assert(migrated.version === 4, 'migration bumps version to 4');
  const withCfg = migrated.tracks[0].notes.find((n) => n.harmonics);
  assert(withCfg && withCfg.harmonics.mode === 'arp' && withCfg.harmonics.stepsPerBeat === 2, 'arp field renamed to harmonics, config intact');
  assert(migrated.tracks[0].notes.every((n) => !('arp' in n)), 'old arp field removed');
  assert(migrated.tracks[0].notes.find((n) => !n.harmonics).harmonics === null, 'plain notes get harmonics: null');
  // v2 files pass through untouched
  const again = migrate(JSON.parse(JSON.stringify(migrated)));
  assert(again.version === 4 && again.tracks[0].notes.some((n) => n.harmonics), 'migration is idempotent');
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
  assert(m.version === 4 && m.instruments[0].name === 'Square', 'v2->v3 renames Badge Square');

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
  eq(index, ['mono.chipseq.json', 'poly.chipseq.json', 'rickroll.chipseq.json', 'tetris.chipseq.json', 'bad-apple.chipseq.json'], 'demo manifest lists all five demos in display order');
  for (const file of index) {
    const doc = migrate(JSON.parse(await readFile(new URL('../demos/' + file, import.meta.url), 'utf8')));
    assert(doc.tracks.every((t) => t.notes.length >= 0), file + ' migrates cleanly');
  }
  const poly = migrate(JSON.parse(await readFile(new URL('../demos/poly.chipseq.json', import.meta.url), 'utf8')));
  assert(poly.mode === 'poly', 'poly demo is poly');
  assert(poly.name === 'Demo Poly', 'demo names are short: ' + poly.name);
  const names = [];
  for (const file of index) {
    names.push(JSON.parse(await readFile(new URL('../demos/' + file, import.meta.url), 'utf8')).name);
  }
  eq(names, ['Demo Mono', 'Demo Poly', 'Rickroll', 'Tetris', 'Bad Apple'], 'demo names in manifest (= display) order');
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
  setTempo(base, 90);
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
  assert(bpmAt(base, 0) === 90 && base.song.key.tonic === 7, 'song settings preserved on merge');
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

// ---- trackPitchCenter: where the bulk of a track sits ----
{
  const { trackPitchCenter } = await import('../js/core/doc.js');
  const T = (pitches) => ({ notes: pitches.map((p, i) => ({ pitch: p, startTick: i * 96, durationTicks: 96 })) });
  assert(trackPitchCenter(null) === null, 'no track -> null');
  assert(trackPitchCenter({ notes: [] }) === null, 'empty track -> null');
  assert(trackPitchCenter(T([84])) === 84, 'single note');
  assert(trackPitchCenter(T([84, 86, 88])) === 86, 'median of three');
  // a high mono badge tune with one stray bass note stays high
  assert(trackPitchCenter(T([36, 84, 86, 88, 90])) === 86, 'outlier does not drag the centre');
  // weighting: one long low note outweighs several short high ones
  const weighted = { notes: [
    { pitch: 48, startTick: 0, durationTicks: 960 },
    { pitch: 84, startTick: 960, durationTicks: 24 },
    { pitch: 86, startTick: 984, durationTicks: 24 },
  ] };
  assert(trackPitchCenter(weighted) === 48, 'duration-weighted median');
}

// ---- output stage / limiter ----
{
  const { softClip, softClipCurve, applyLimiter, limiterConfig, dbToLin, DEFAULT_LIMITER }
    = await import('../js/core/graph.js');
  const cfg = DEFAULT_LIMITER;
  const T = dbToLin(cfg.kneeDb);
  const C = dbToLin(cfg.ceilingDb);

  // Below the knee the limiter must be exactly transparent - a soft clipper
  // that colours quiet material would change every existing project.
  assert(softClip(0, cfg) === 0, 'silence stays silent');
  assert(softClip(0.5, cfg) === 0.5, 'below the knee is unity');
  assert(softClip(-0.5, cfg) === -0.5, 'below the knee is unity (negative)');
  assert(softClip(T, cfg) === T, 'exactly at the knee is still unity');

  // The whole point: nothing can leave the master above the ceiling. tanh
  // saturates to exactly 1 in floating point, so the ceiling is reached rather
  // than merely approached - "never exceeds" is the property that matters.
  assert(softClip(1, cfg) < C, '0 dBFS input stays under the ceiling');
  assert(softClip(50, cfg) <= C, 'an absurdly hot input never exceeds the ceiling');
  assert(softClip(-50, cfg) >= -C, 'the same holds for negative peaks');
  assert(Math.abs(softClip(1e6, cfg)) <= C, 'the ceiling holds for any input');

  assert(softClip(-0.9, cfg) === -softClip(0.9, cfg), 'the curve is odd-symmetric');

  // A corner at the knee would be audible as distortion, so the slope has to
  // arrive at 1 from both sides.
  const e = 1e-6;
  const slopeIn = (softClip(T, cfg) - softClip(T - e, cfg)) / e;
  const slopeOut = (softClip(T + e, cfg) - softClip(T, cfg)) / e;
  assert(Math.abs(slopeIn - 1) < 1e-3 && Math.abs(slopeOut - 1) < 1e-3, 'slope is continuous at the knee');

  let mono = true, prev = -Infinity;
  for (let x = -3; x <= 3; x += 0.01) {
    const y = softClip(x, cfg);
    if (y < prev) mono = false;
    prev = y;
  }
  assert(mono, 'the curve is monotonic (no fold-back distortion)');

  const curve = softClipCurve(cfg, 4097);
  assert(curve.length === 4097, 'curve table length');
  assert(Math.abs(curve[2048]) < 1e-6, 'curve is centred on zero');
  // Float32 rounding can nudge the stored value a hair past the double, hence
  // the epsilon - the audible guarantee is the ceiling, not the last ULP.
  const f32eps = 1e-7;
  assert(curve[4096] <= C + f32eps && curve[4096] > 0.9, 'curve tops out at the ceiling');
  assert(curve[0] >= -C - f32eps && curve[0] < -0.9, 'curve bottoms out at -ceiling');

  // applyLimiter reports the peak BEFORE shaping - that number is what makes
  // the export warning actionable ("you are 3 dB over"), which a post-limiter
  // reading could never say.
  const fakeBuffer = (samples) => ({
    numberOfChannels: 1,
    _d: Float32Array.from(samples),
    getChannelData() { return this._d; },
  });
  const hot = fakeBuffer([0, 0.5, 2, -2, 0.1]);
  const level = applyLimiter(hot, {});
  assert(Math.abs(level.peak - 2) < 1e-6, 'reports the pre-limiter peak');
  assert(level.over === true, 'flags a mix over 0 dBFS');
  assert(Math.abs(level.peakDb - 6.0206) < 0.01, 'peak in dB');
  assert(Math.abs(level.shapedRatio - 0.4) < 1e-6, 'reports how much of the buffer was shaped');
  assert(hot._d.every((v) => Math.abs(v) <= C), 'no sample survives above the ceiling');
  assert(hot._d[1] === 0.5, 'quiet samples pass through untouched');

  const quiet = fakeBuffer([0.1, -0.2, 0.3]);
  const qlevel = applyLimiter(quiet, {});
  assert(qlevel.over === false, 'a quiet mix is not flagged');
  assert(qlevel.shapedRatio === 0, 'a quiet mix is not shaped at all');

  // The limiter block lives in the document so it can evolve without a schema
  // bump; an absent block must still yield working defaults.
  assert(limiterConfig(undefined).enabled === true, 'missing block falls back to the default');
  assert(limiterConfig({ master: { limiter: { ceilingDb: -6 } } }).ceilingDb === -6, 'document overrides merge');
  assert(limiterConfig({ master: { limiter: { ceilingDb: -6 } } }).kneeDb === cfg.kneeDb, 'partial overrides keep defaults');
}

// ---- mute vs solo ----
{
  const {
    unmutedTracks, playableTracks, soloActive, createTrack: mkTrack, pickTrackColor,
  } = await import('../js/core/doc.js');
  const { flattenSong } = await import('../js/core/flatten.js');

  const build = () => {
    const d = createProject({ name: 'ms', mode: 'poly' });
    d.tracks[0].name = 'A';
    for (const n of ['B', 'C']) {
      d.tracks.push(mkTrack({ name: n, role: 'melody', instrumentId: 'sine', color: pickTrackColor(d) }));
    }
    for (const t of d.tracks) {
      for (const p of [60, 64, 67, 71]) {
        addNote(d, t.id, createNote({ pitch: p, startTick: 0, durationTicks: 384 }));
      }
    }
    return d;
  };
  const heard = (d) => [...new Set(flattenSong(d).events.map((e) => e.trackId))]
    .map((id) => d.tracks.find((t) => t.id === id).name).sort();
  const level = (d) => {
    const ev = flattenSong(d).events[0];
    return ev ? (ev.gainCurve ? Math.min(...ev.gainCurve) : ev.gainMul ?? 1) : 0;
  };

  {
    const d = build();
    eq(heard(d), ['A', 'B', 'C'], 'everything plays by default');
    assert(soloActive(d) === false, 'and nothing is soloed');
  }

  // Solo: only the soloed tracks sound, several at once if several are set.
  {
    const d = build();
    d.tracks[1].solo = true;
    assert(soloActive(d) === true, 'solo is active');
    eq(heard(d), ['B'], 'a soloed track plays alone');
    d.tracks[2].solo = true;
    eq(heard(d), ['B', 'C'], 'several soloed tracks play together');
  }

  // The headline distinction: solo must NOT change levels. A soloed track has
  // to preview at the level it has IN the mix - that is the only level worth
  // judging it at - so Levels keeps counting the tracks solo has silenced.
  {
    const full = build();
    const soloed = build();
    soloed.tracks[1].solo = true;
    assert(Math.abs(level(full) - level(soloed)) < 1e-9,
      `solo leaves levels alone (${level(full).toFixed(4)} vs ${level(soloed).toFixed(4)})`);
  }

  // Mute is the opposite: a muted track is not part of the piece, so the
  // others get its headroom back.
  {
    const full = build();
    const muted = build();
    muted.tracks[1].role = 'muted';
    eq(heard(muted), ['A', 'C'], 'a muted track does not play');
    assert(level(muted) > level(full) * 1.05,
      `mute frees headroom for the rest (${level(full).toFixed(4)} -> ${level(muted).toFixed(4)})`);
    eq(unmutedTracks(muted).map((t) => t.name), ['A', 'C'], 'and leaves the unmuted set');
  }

  // Mute beats solo: soloing something you have muted does not unmute it, and
  // if the ONLY soloed track is muted then nothing is really soloed.
  {
    const d = build();
    d.tracks[1].solo = true;
    d.tracks[1].role = 'muted';
    assert(soloActive(d) === false, 'a muted solo is not a solo');
    eq(heard(d), ['A', 'C'], 'so the rest keep playing');
    d.tracks[2].solo = true;
    eq(heard(d), ['C'], 'while an audible solo still takes over');
  }

  // Mono has one voice; neither flag applies.
  {
    const d = createProject({ name: 'mono', mode: 'mono' });
    addNote(d, d.tracks[0].id, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
    d.tracks[0].solo = true;
    assert(soloActive(d) === false, 'solo is a poly idea');
    eq(playableTracks(d).map((t) => t.name), ['Lead'], 'mono plays its melody track regardless');
  }
}

// ---- badge score: what a badge plays IS what the .h file says ----
{
  const { badgeScore, sliceScore, toSchedNotes, schedT0, scoreLengthMs, REST } =
    await import('../js/core/badge-score.js');
  const { exportHeader, pitchSymbol } = await import('../js/core/export-h.js');
  const { migrate } = await import('../js/core/doc.js');
  const { readFile } = await import('node:fs/promises');

  // The invariant worth defending: preview === export === badge. A badge
  // playing a mono project must produce exactly the sequence the .h file
  // written for that same project contains - same notes, same milliseconds -
  // or one of the two is lying and there is no way to tell which.
  for (const file of ['mono.chipseq.json', 'rickroll.chipseq.json']) {
    const doc = migrate(JSON.parse(await readFile(new URL(`../demos/${file}`, import.meta.url), 'utf8')));
    const header = exportHeader(doc);
    // The exporter's own entry list, as {symbol, ms}.
    const fromHeader = [];
    for (const line of header.text.split('\n')) {
      for (const m of line.matchAll(/\{(NOTE_[A-Z0-9]+|NOTE_REST)\s*,\s*(-?\d+)\}/g)) {
        fromHeader.push({ symbol: m[1], ms: Number(m[2]) });
      }
    }
    // trimLead, because the exporter skips leading silence for a standalone
    // file while streaming must keep it - see badge-score.js. Comparing
    // without it would be comparing two different origins.
    const score = badgeScore(doc, doc.melodyTrackId, { trimLead: true });
    const fromScore = score.map((n) => ({
      symbol: n.pitch === REST ? 'NOTE_REST' : pitchSymbol(n.pitch),
      ms: n.durMs,
    }));
    eq(fromScore, fromHeader, `${file}: the badge plays exactly what the .h file says`);
    assert(fromScore.length > 20, `${file}: and it is a real tune, not an empty list`);

    // ...and WITHOUT trimming, a song that starts late keeps its silence, so
    // a streamed badge comes in on the beat rather than early.
    const streamed = badgeScore(doc, doc.melodyTrackId);
    const firstOnset = streamed.find((n) => n.pitch !== REST);
    const lead = streamed[0].pitch === REST ? streamed[0].durMs : 0;
    assert(firstOnset.startMs === lead, `${file}: streaming keeps the leading rest`);
  }

  // Monophony: a chord on a poly track becomes one voice, because the badge
  // has one. Highest note wins, matching the exporter.
  {
    const doc = createProject({ name: 'chordy', mode: 'poly' });
    const t = doc.tracks[0];
    for (const p of [60, 64, 67]) {
      addNote(doc, t.id, createNote({ pitch: p, startTick: 0, durationTicks: 96 }));
    }
    addNote(doc, t.id, createNote({ pitch: 72, startTick: 96, durationTicks: 96 }));
    const score = badgeScore(doc, t.id);
    eq(score.map((n) => n.pitch), [67, 72], 'a chord collapses to its top note');
  }

  // An overlap is truncated at the next onset - what the firmware does anyway.
  {
    const doc = createProject({ name: 'overlap', mode: 'poly' });
    const t = doc.tracks[0];
    addNote(doc, t.id, createNote({ pitch: 60, startTick: 0, durationTicks: 384 }));
    addNote(doc, t.id, createNote({ pitch: 62, startTick: 96, durationTicks: 96 }));
    const score = badgeScore(doc, t.id);
    eq(score.map((n) => [n.pitch, n.startMs, n.durMs]), [[60, 0, 500], [62, 500, 500]],
      'the earlier note is cut where the later one starts');
  }

  // Rests are explicit: a badge plays a list and has no notion of "wait".
  {
    const doc = createProject({ name: 'gap', mode: 'poly' });
    const t = doc.tracks[0];
    addNote(doc, t.id, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
    addNote(doc, t.id, createNote({ pitch: 62, startTick: 288, durationTicks: 96 }));
    const score = badgeScore(doc, t.id);
    eq(score.map((n) => n.pitch), [60, REST, 62], 'the gap becomes a rest');
    eq(score[1].durMs, 1000, 'of the right length');
    assert(badgeScore(doc, t.id, { includeRests: false }).every((n) => n.pitch !== REST),
      'and can be turned off for a caller that schedules by time');
  }

  // Rounding must not accumulate: boundaries are absolute, not summed.
  {
    const doc = createProject({ name: 'drift', mode: 'poly' });
    doc.song.tempo = [{ tick: 0, bpm: 133 }]; // a tempo whose ticks are not whole ms
    const t = doc.tracks[0];
    for (let i = 0; i < 200; i++) {
      addNote(doc, t.id, createNote({ pitch: 60, startTick: i * 32, durationTicks: 32 }));
    }
    const score = badgeScore(doc, t.id);
    const summed = score.reduce((a, n) => a + n.durMs, 0);
    const exact = scoreLengthMs(score);
    assert(Math.abs(summed - exact) <= 1, `200 notes do not drift (summed ${summed} vs ${exact})`);
  }

  // Chunking for scheduled mode selects by START, so a note already sounding
  // is not re-sent and retriggered.
  {
    const score = [
      { pitch: 60, startMs: 0, durMs: 2000 },
      { pitch: 62, startMs: 2000, durMs: 500 },
      { pitch: 64, startMs: 2500, durMs: 500 },
    ];
    eq(sliceScore(score, 0, 2000).map((n) => n.pitch), [60], 'the first window takes only what starts in it');
    eq(sliceScore(score, 2000, 4000).map((n) => n.pitch), [62, 64], 'the next takes the rest');
    eq(toSchedNotes(sliceScore(score, 2000, 4000), 0, 2000), [[0, 62, 500], [500, 64, 500]],
      'offsets are relative to the chunk origin');

    // The wire carries INTEGER milliseconds. Song positions come from
    // tickToSeconds() * 1000 and the clock offset is a median, so both origins
    // are routinely fractional - and real chunks went out with offsets like
    // 108.78260869566293 until this was enforced here.
    {
      const origin = 1765432109876.4321; // fractional clock offset
      const from = 108.78260869566293; // fractional song position
      const t0 = schedT0(origin, from);
      const notes = toSchedNotes(score, origin, t0);
      assert(Number.isInteger(t0), 't0 is an integer millisecond');
      assert(notes.every((n) => n.every(Number.isInteger)),
        `every sched value is an integer (got ${JSON.stringify(notes)})`);
      // ...and rounding must not make t0 and the offsets disagree: their sum
      // has to be the instant the note was actually meant to sound.
      const drift = notes.map((n, i) => (t0 + n[0]) - Math.round(origin + score[i].startMs));
      eq(drift, [0, 0, 0], 't0 + offset is exactly the intended absolute time');
    }
    eq(scoreLengthMs(score), 3000, 'and the score knows its own length');
  }
}

// ---- badge streaming: chunking and fan-out ----
{
  const { createBadgeStream, CHUNK_MS } = await import('../js/net/badge-stream.js');

  // A fake client that records what would have gone over the wire.
  const makeClient = (badges, serverNow) => ({
    state: { badges },
    serverNow: () => serverNow(),
    sent: [],
    sched(id, t0, n) { this.sent.push({ t: 'sched', id, t0, n }); },
    note(id, p, ms) { this.sent.push({ t: 'note', id, p, ms }); },
    stop(id) { this.sent.push({ t: 'stop', id }); },
  });

  const doc = createProject({ name: 'stream', mode: 'poly' });
  const track = doc.tracks[0];
  for (let i = 0; i < 16; i++) {
    addNote(doc, track.id, createNote({ pitch: 60 + (i % 4), startTick: i * 96, durationTicks: 96 }));
  }
  const store = { getDoc: () => doc };

  // Two badges on ONE track: the stated goal, and the case most likely to be
  // handled as an afterthought.
  {
    let clock = 1_000_000;
    const client = makeClient(
      [{ id: 'b1', trackId: track.id, online: true }, { id: 'b2', trackId: track.id, online: true }],
      () => clock
    );
    const stream = createBadgeStream({ client, store });
    stream.start(0);
    const scheds = client.sent.filter((m) => m.t === 'sched');
    eq(scheds.length, 2, 'both badges on one track are scheduled');
    eq(scheds[0].n, scheds[1].n, 'and receive the IDENTICAL notes');
    eq(scheds[0].t0, scheds[1].t0, 'against the same origin');
    assert(scheds[0].n.length > 0, 'with something in them');
    assert(scheds[0].n[0][0] === 0, 'the first note sits at offset 0 of the chunk');
  }

  // An offline badge, or one mapped to nothing, is not addressed.
  {
    let clock = 1_000_000;
    const client = makeClient(
      [{ id: 'off', trackId: track.id, online: false }, { id: 'none', trackId: null, online: true }],
      () => clock
    );
    const stream = createBadgeStream({ client, store });
    stream.start(0);
    eq(client.sent.filter((m) => m.t === 'sched'), [], 'nothing is sent to an offline or unmapped badge');
  }

  // Chunks advance with the clock and do not re-send what was already sent -
  // a re-sent note would retrigger, which on a badge is an audible stutter.
  {
    let clock = 1_000_000;
    const client = makeClient([{ id: 'b1', trackId: track.id, online: true }], () => clock);
    const stream = createBadgeStream({ client, store });
    stream.start(0);
    const first = client.sent.filter((m) => m.t === 'sched');
    eq(first.length, 1, 'one chunk at the start');
    const firstOffsets = first[0].n.map((x) => x[0]);
    assert(Math.max(...firstOffsets) < CHUNK_MS, 'the chunk covers only its window');

    // Nothing new until the clock actually moves.
    stream._state();
    const before = client.sent.length;
    clock += 100;
    // pump runs on a timer; drive it the way the timer would
    stream.start(stream._state().sentUpTo); // re-entry must not duplicate
    assert(client.sent.length >= before, 'restarting does not lose the position');
  }

  // stop() silences every mapped badge - otherwise the last note hangs.
  {
    const client = makeClient(
      [{ id: 'b1', trackId: track.id, online: true }, { id: 'b2', trackId: track.id, online: true }],
      () => 1_000_000
    );
    const stream = createBadgeStream({ client, store });
    stream.start(0);
    client.sent.length = 0;
    stream.stop();
    eq(client.sent.map((m) => m.t), ['stop', 'stop'], 'both badges are told to stop');
  }

  // Live mode sends notes as the engine reaches them, and only for mapped tracks.
  {
    const client = makeClient([{ id: 'b1', trackId: track.id, online: true }], () => 1_000_000);
    const stream = createBadgeStream({ client, store });
    stream.setMode('live');
    eq(stream.getMode(), 'live', 'the mode switches');
    stream.start(0);
    stream.onEngineEvents([
      { trackId: track.id, pitch: 60, durationMs: 250 },
      { trackId: 'other-track', pitch: 62, durationMs: 250 },
      { trackId: track.id, pitch: 64, durationMs: 0 },
    ]);
    const notes = client.sent.filter((m) => m.t === 'note');
    eq(notes.map((n) => n.p), [60], 'only mapped tracks, and only real durations');
    eq(client.sent.filter((m) => m.t === 'sched'), [], 'live mode schedules nothing');
  }

  // ---- auditioning a note onto the badges ----
  {
    const { PREVIEW_MIN_GAP_MS, PREVIEW_LEAD_MS } = await import('../js/net/badge-stream.js');
    const roster = [
      { id: 'mapped', trackId: track.id, online: true, caps: ['note', 'sched'] },
      { id: 'unmapped', trackId: null, online: true, caps: ['note', 'sched'] },
      { id: 'offline', trackId: track.id, online: false, caps: ['note', 'sched'] },
    ];

    // EVERY connected badge, mapped or not - clicking a note is "let me hear
    // this", and it doubles as a check that the whole rig is alive.
    {
      const client = makeClient(roster, () => 1_000_000);
      const stream = createBadgeStream({ client, store });
      assert(stream.preview([{ pitch: 69, offsetMs: 0, durMs: 180 }], 0) === true, 'a preview is sent');
      eq(client.sent.map((m) => `${m.t}:${m.id}`), ['note:mapped', 'note:unmapped'],
        'every ONLINE badge hears it, mapped or not; an offline one is skipped');
      eq(client.sent[0].ms, 180, 'for as long as the speakers hold it');
    }

    // Not over a running transport: the badges are mid-song with a queue
    // already filled, and a stray note reads as the ensemble glitching.
    {
      const client = makeClient(roster, () => 1_000_000);
      const stream = createBadgeStream({ client, store });
      stream.start(0);
      client.sent.length = 0;
      assert(stream.preview([{ pitch: 69, offsetMs: 0, durMs: 180 }], 0) === false,
        'previews are suppressed while the transport runs');
      eq(client.sent, [], 'and nothing goes out');
      stream.stop();
      client.sent.length = 0;
      assert(stream.preview([{ pitch: 69, offsetMs: 0, durMs: 180 }], 0) === true,
        'and resume once it stops');
    }

    // A held arrow key repeats ~30x a second. Extra previews are DROPPED, not
    // queued - a backlog of auditions is worse than none.
    {
      const client = makeClient(roster, () => 1_000_000);
      const stream = createBadgeStream({ client, store });
      const one = [{ pitch: 69, offsetMs: 0, durMs: 180 }];
      assert(stream.preview(one, 0) === true, 'the first preview goes');
      assert(stream.preview(one, PREVIEW_MIN_GAP_MS - 1) === false, 'a rapid repeat is dropped');
      assert(stream.preview(one, PREVIEW_MIN_GAP_MS + 1) === true, 'and the next one lands');
      eq(client.sent.filter((m) => m.t === 'note').length, 4,
        'two previews x two online badges, not three previews');
    }

    // A decorated note is a whole gesture: it goes as a scheduled chunk so the
    // arpeggio keeps its shape across the relay.
    {
      const client = makeClient(roster, () => 1_000_000);
      const stream = createBadgeStream({ client, store });
      const arp = [
        { pitch: 60, offsetMs: 0, durMs: 100 },
        { pitch: 64, offsetMs: 100, durMs: 100 },
        { pitch: 67, offsetMs: 200, durMs: 100 },
      ];
      stream.preview(arp, 0);
      const sched = client.sent.filter((m) => m.t === 'sched');
      eq(sched.length, 2, 'both online badges get the whole decoration');
      eq(sched[0].n, [[0, 60, 100], [100, 64, 100], [200, 67, 100]], 'with its timing intact');
      eq(sched[0].t0, 1_000_000 + PREVIEW_LEAD_MS, 'anchored far enough ahead to clear the relay');
    }

    // A badge that never implemented `sched` has no clock, so a burst would
    // arrive as one blur. It gets the note actually under the cursor.
    {
      const client = makeClient([{ id: 'simple', trackId: null, online: true, caps: ['note'] }], () => 1_000_000);
      const stream = createBadgeStream({ client, store });
      stream.preview([
        { pitch: 60, offsetMs: 0, durMs: 100 },
        { pitch: 64, offsetMs: 100, durMs: 100 },
      ], 0);
      eq(client.sent.map((m) => [m.t, m.p]), [['note', 60]],
        'a note-only badge plays the root rather than a jumble');
    }

    // Nothing connected is not an error, and must not start the throttle -
    // otherwise the first real preview after connecting would be swallowed.
    {
      const client = makeClient([], () => 1_000_000);
      const stream = createBadgeStream({ client, store });
      assert(stream.preview([{ pitch: 69, offsetMs: 0, durMs: 180 }], 0) === false, 'no badges, no send');
      // A badge appears at the very same instant: the failed attempt must not
      // have armed the throttle, or the first real preview would be swallowed.
      client.state.badges.push({ id: 'late', trackId: null, online: true, caps: ['note'] });
      assert(stream.preview([{ pitch: 69, offsetMs: 0, durMs: 180 }], 0) === true,
        'and a preview the instant one connects still goes');
    }
  }
}

// ---- badge protocol: clock sync and late-drop ----
{
  const { offsetFrom, medianOffset, isPlayable, LATE_DROP_MS } =
    await import('../tools/fake-badge.mjs');

  // A symmetric exchange recovers the offset exactly.
  assert(offsetFrom(1000, 1100, 6050) === 5000, 'equal legs give the true offset');

  // An asymmetric one does not - which is the whole reason a single sample is
  // never trusted. 100 ms of extra return path reads as 50 ms of clock error.
  assert(offsetFrom(1000, 1200, 6050) === 4950, 'a slow return leg biases the estimate');

  // The median of five rejects the outliers a relayed path produces.
  const TRUE = 5000;
  const samples = [];
  let worstSingle = 0;
  for (let i = 0; i < 20; i++) {
    const c1 = 1000 + i * 2000;
    const out = 20;
    const back = i % 5 === 0 ? 120 : 25; // every fifth exchange is badly delayed
    const s = c1 + TRUE + out;
    const o = offsetFrom(c1, c1 + out + back, s);
    samples.push(o);
    worstSingle = Math.max(worstSingle, Math.abs(o - TRUE));
  }
  assert(worstSingle > 40, `a single sample can be badly wrong (was ${worstSingle})`);
  const est = medianOffset(samples);
  assert(Math.abs(est - TRUE) < 15, `the median converges anyway (off by ${Math.abs(est - TRUE)})`);

  eq(medianOffset([]), 0, 'no samples means no correction, not NaN');
  eq(medianOffset([7]), 7, 'one sample is itself');
  eq(medianOffset([1, 2, 3, 4]), 2.5, 'an even count averages the middle two');
  // Only the window counts, so an offset that has genuinely moved is followed.
  eq(medianOffset([500, 500, 500, 1, 2, 3, 4, 5], 5), 3, 'old samples fall out of the window');

  // Late is worse than absent in an ensemble: past the threshold, drop it.
  assert(isPlayable(1000, 1000 + LATE_DROP_MS - 1), 'a slightly late note still plays');
  assert(!isPlayable(1000, 1000 + LATE_DROP_MS + 1), 'a very late note is dropped');
  assert(isPlayable(2000, 1000), 'a future note is fine');
}

// ---- the command and exporter tables ----
{
  const { COMMANDS, commandForChord, commandById, chordOf, duplicateChords, available, runCommand } =
    await import('../js/ui/commands.js');
  const { EXPORTERS, exporterById, exportersFor } = await import('../js/core/exporters.js');

  // The reason the table exists: two handlers could quietly claim one chord
  // and whichever bound last would win, invisibly.
  eq(duplicateChords(), [], 'no two commands claim the same chord');

  const ids = COMMANDS.map((c) => c.id);
  assert(new Set(ids).size === ids.length, 'command ids are unique');
  for (const cmd of COMMANDS) {
    assert(cmd.label && typeof cmd.run === 'function', `${cmd.id} has a label and something to run`);
    assert(cmd.keys || cmd.button, `${cmd.id} is reachable by key or by button`);
    for (const chord of cmd.keys || []) {
      assert(commandForChord(chord) === cmd, `${chord} resolves back to ${cmd.id}`);
    }
  }

  // Chords are built from the event the same way they are written down.
  eq(chordOf({ ctrlKey: true, code: 'KeyZ' }), 'Ctrl+KeyZ', 'a ctrl chord');
  eq(chordOf({ ctrlKey: true, shiftKey: true, code: 'KeyZ' }), 'Ctrl+Shift+KeyZ', 'modifier order is fixed');
  eq(chordOf({ metaKey: true, code: 'KeyS' }), 'Ctrl+KeyS', 'meta counts as ctrl, for macOS');
  eq(chordOf({ code: 'Space' }), 'Space', 'and a bare key is just itself');
  assert(commandForChord('Ctrl+KeyZ').id === 'undo', 'Ctrl+Z is undo');
  assert(commandForChord('Ctrl+Shift+KeyZ').id === 'redo' && commandForChord('Ctrl+KeyY').id === 'redo',
    'redo answers to both of its chords');
  assert(commandForChord('Ctrl+KeyJ') === null, 'an unbound chord is null');

  // A guard that fails must BLOCK the run, not just grey a menu entry.
  let ran = 0;
  const guarded = { id: 'x', label: 'x', when: () => false, run: () => { ran++; } };
  assert(runCommand(guarded, {}) === false && ran === 0, 'a failing guard stops the command');
  assert(runCommand({ ...guarded, when: () => true }, {}) === true && ran === 1, 'and passing runs it');
  assert(runCommand(null, {}) === false, 'a missing command is not an error');

  {
    const ctx = { store: { canUndo: () => false, canRedo: () => true } };
    const list = available(ctx).map((c) => c.id);
    assert(!list.includes('undo') && list.includes('redo'), 'the palette offers only what can run');
  }

  // ---- exporters ----
  const eids = EXPORTERS.map((e) => e.id);
  assert(new Set(eids).size === eids.length, 'exporter ids are unique');
  for (const fmt of EXPORTERS) {
    assert(fmt.label && fmt.ext && fmt.mime, `${fmt.id} is fully described`);
    assert(typeof fmt.render === 'function', `${fmt.id} can render`);
    assert(fmt.modes.length && fmt.modes.every((m) => m === 'mono' || m === 'poly'), `${fmt.id} names real modes`);
    assert(exporterById(fmt.id) === fmt, `${fmt.id} is found by id`);
  }
  assert(exporterById('mid') === null, 'a format we do not have is null, not a guess');
  eq(exportersFor('mono').map((e) => e.id), ['h', 'fmf', 'cbt', 'wav', 'json'], 'mono can export everything');
  // .h and .fmf are single-voice FILES, so they have nothing to say about a
  // poly song. .cbt is not in that group: it holds every track and the badge
  // picks one, which is exactly what poly means on this hardware.
  eq(exportersFor('poly').map((e) => e.id), ['cbt', 'wav', 'json'],
    'poly cannot export the single-voice files, but can export a badge tune');
  assert(EXPORTERS.filter((e) => e.blockedByConflicts).every((e) => e.modes.join() === 'mono'),
    'only mono formats are blocked by overlaps - poly has voices to spare');
}

// ---- commitDerived: measured values must not enter undo history ----
{
  const { createStore } = await import('../js/core/store.js');
  const store = createStore(createProject({ name: 'derived', mode: 'poly' }));

  store.commit('a real edit', ['song'], (d) => { d.name = 'edited'; });
  const depthAfterEdit = store.canUndo();
  assert(depthAfterEdit === true, 'an edit is undoable');

  store.commitDerived('measured', ['song'], (d) => {
    d.master = { makeup: { kind: 'makeup', v: 1, db: 5.8, auto: true } };
  });
  assert(store.getDoc().master.makeup.db === 5.8, 'a derived commit does change the document');

  // The property: undoing must reach the EDIT, not the measurement. An
  // automatic re-measure every five minutes would otherwise bury real work.
  store.undo();
  assert(store.getDoc().name !== 'edited', 'undo reaches past the measurement to the edit');
  assert(store.canUndo() === false, 'and the measurement pushed no snapshot of its own');
}

// ---- make-up gain ----
{
  const {
    makeupConfig, makeupGain, DEFAULT_MAKEUP, MAKEUP_TARGET_DB, MAKEUP_MIN_DB, MAKEUP_MAX_DB, dbToLin,
  } = await import('../js/core/graph.js');

  eq(makeupConfig({}), DEFAULT_MAKEUP, 'no block means no make-up');
  assert(makeupGain({}) === 1, 'which is unity, not silence');
  assert(Math.abs(makeupGain({ master: { makeup: { db: 6 } } }) - dbToLin(6)) < 1e-12, '+6 dB is a doubling');
  assert(makeupConfig({ master: { makeup: { db: 999 } } }).db === MAKEUP_MAX_DB, 'it clamps up');
  assert(makeupConfig({ master: { makeup: { db: -999 } } }).db === MAKEUP_MIN_DB, 'and down');
  assert(makeupConfig({ master: { makeup: { db: 'loud' } } }).db === 0, 'junk is no make-up, not NaN');
  assert(MAKEUP_TARGET_DB === -1, 'Analyse aims at -1 dBFS, leaving room for lossy encoding');

  // The correction Analyse applies, as arithmetic: measure the pre-limiter
  // peak, and move the make-up by the difference from the target. It has to
  // work from whatever the current setting is, not only from zero.
  const correct = (before, measuredDb) => before + (MAKEUP_TARGET_DB - measuredDb);
  assert(Math.abs(correct(0, -6.81) - 5.81) < 1e-9, 'a quiet mix gets turned up');
  assert(Math.abs(correct(5.81, -1) - 5.81) < 1e-9, 'a mix already on target is left alone');
  assert(Math.abs(correct(3, 2) - 0) < 1e-9, 'and one that is too loud gets turned down');
}

// ---- effects: buses, sends, chains ----
{
  const {
    EFFECTS, EFFECT_KINDS, DEFAULT_EFFECTS, impulseResponse, buildChain,
  } = await import('../js/core/effects.js');
  const {
    createBus, buses, busById, trackSends, setSend, hasEffects, createProject: mkProj,
  } = await import('../js/core/doc.js');

  // Every kind must be registered, defaulted and buildable - a kind that
  // exists in one table but not the other is a card that renders nothing.
  for (const kind of EFFECT_KINDS) {
    assert(typeof EFFECTS[kind].build === 'function', `${kind} has a builder`);
    assert(EFFECTS[kind].name, `${kind} has a display name`);
    assert(DEFAULT_EFFECTS[kind] && DEFAULT_EFFECTS[kind].kind === kind, `${kind} has defaults naming itself`);
    assert(DEFAULT_EFFECTS[kind].v === 1, `${kind} defaults carry a version`);
  }

  // The impulse is generated, never fetched, and must be identical every time
  // or live and offline renders would reverberate differently.
  const a = impulseResponse(44100, 0.1, 2);
  const b = impulseResponse(44100, 0.1, 2);
  assert(a.length === b.length && a.left.every((v, i) => v === b.left[i]), 'the reverb impulse is deterministic');
  assert(a.left.some((v) => v !== 0), 'and is not silence');
  assert(Math.abs(a.left[a.length - 1]) < Math.abs(a.left[0]), 'it decays');
  assert(a.left.some((v, i) => v !== a.right[i]), 'the two channels differ, so it is not mono');

  // A fake context: enough surface for the builders, so chain assembly can be
  // asserted in node without Web Audio.
  const fakeCtx = () => {
    const made = [];
    // nodeType, not type: BiquadFilterNode HAS a `type` property and the
    // builder sets it, so a marker called `type` would be overwritten.
    const node = (nodeType) => {
      const n = { nodeType, connections: [], connect(x) { this.connections.push(x); }, disconnect() {} };
      made.push(n);
      return n;
    };
    return {
      made,
      sampleRate: 44100,
      createGain: () => ({ ...node('gain'), gain: { value: 1 } }),
      createDelay: () => ({ ...node('delay'), delayTime: { value: 0 } }),
      createBiquadFilter: () => ({ ...node('filter'), frequency: { value: 0 }, Q: { value: 0 }, type: '' }),
      createConvolver: () => ({ ...node('convolver'), buffer: null, normalize: true }),
      createBuffer: (ch, len) => ({ ch, len, copyToChannel() {} }),
    };
  };

  {
    const ctx = fakeCtx();
    const built = buildChain(ctx, [DEFAULT_EFFECTS.filter, DEFAULT_EFFECTS.delay]);
    assert(built.input && built.output, 'a chain has both ends');
    assert(built.input !== built.output, 'and they differ once something is in it');
    eq(built.skipped, [], 'nothing was skipped');
  }
  {
    // The forward-compat rule, at the audio layer: an effect from a newer
    // build costs you that effect, not the whole bus.
    const ctx = fakeCtx();
    const built = buildChain(ctx, [{ kind: 'granulator', v: 1 }, DEFAULT_EFFECTS.filter]);
    eq(built.skipped, ['granulator'], 'an unknown kind is reported');
    assert(built.output.nodeType === 'filter', 'and the rest of the chain is still built');
  }
  {
    const ctx = fakeCtx();
    const built = buildChain(ctx, []);
    assert(built.input === built.output, 'an empty chain is a pass-through');
  }

  // ---- document helpers ----
  const doc = mkProj({ name: 'fx', mode: 'poly' });
  assert(hasEffects(doc) === false, 'a new project uses no effects');
  const bus = createBus({ name: 'Space', chain: [DEFAULT_EFFECTS.reverb] });
  doc.buses = [bus];
  assert(buses(doc).length === 1 && busById(doc, bus.id) === bus, 'buses are found by id');
  assert(busById(doc, 'nope') === null, 'and a missing one is null, not a guess');
  assert(hasEffects(doc) === true, 'a bus with a chain counts as using effects');

  const track = doc.tracks[0];
  setSend(track, bus.id, 0.4);
  eq(trackSends(doc, track), [{ busId: bus.id, level: 0.4 }], 'a send is stored and read back');
  setSend(track, 'ghost-bus', 0.5);
  assert(track.sends.length === 2, 'a send to an unknown bus is kept in the document');
  eq(trackSends(doc, track), [{ busId: bus.id, level: 0.4 }], 'but is not routed, having nowhere to go');
  setSend(track, bus.id, 0);
  assert(!trackSends(doc, track).length, 'level 0 removes the send');
  assert(track.sends.length === 1, 'without touching the others');
  setSend(track, 'ghost-bus', 0);
  assert(track.sends === undefined, 'and the field disappears once empty');

  // A send with no bus is refused outright. The Effects card could write one
  // between deleting a bus and the next render, and it then sat in the saved
  // file forever - inert, invisible, and impossible to explain.
  setSend(track, null, 0.5);
  setSend(track, undefined, 0.5);
  setSend(track, '', 0.5);
  assert(track.sends === undefined, 'a send needs a bus to point at');
}

// ---- spectrum: base wave x tilt x partial multipliers ----
{
  const {
    baseSeries, applySpectrum, spectrumOf, hasSpectrum, sanitizePartials,
    DEFAULT_SPECTRUM, MAX_PARTIALS, SERIES_LENGTH, TILT_MIN, TILT_MAX,
  } = await import('../js/core/instruments.js');

  // The series each base wave IS. Measured against the rendered audio of the
  // browser's own oscillators, so these are not just textbook numbers.
  const at = (a, k) => Number(a[k].toFixed(4));
  const saw = baseSeries('sawtooth');
  assert(at(saw, 1) === 1 && at(saw, 2) === 0.5 && at(saw, 3) === 0.3333, 'a saw is every harmonic at 1/n');
  const sq = baseSeries('square');
  assert(at(sq, 2) === 0 && at(sq, 3) === 0.3333 && at(sq, 5) === 0.2, 'a square is the odd ones at 1/n');
  const tri = baseSeries('triangle');
  assert(at(tri, 3) === -0.1111 && at(tri, 5) === 0.04, 'a triangle is odd at 1/n^2 with alternating sign');
  assert(at(baseSeries('sine'), 1) === 1 && at(baseSeries('sine'), 2) === 0, 'a sine is the fundamental alone');
  assert(saw[0] === 0 && sq[0] === 0, 'DC is always zero');
  assert(saw.length === SERIES_LENGTH + 1, 'the series runs to SERIES_LENGTH');

  // Tilt is dB per octave, so it should exactly cancel a saw's own 1/n slope
  // at +6 and square it at -6.
  const flat = applySpectrum(saw, { tilt: 6, partials: null });
  assert(Math.abs(flat[2] - 1) < 0.01 && Math.abs(flat[8] - 1) < 0.02, '+6 dB/oct flattens a saw');
  const steep = applySpectrum(saw, { tilt: -6, partials: null });
  assert(Math.abs(steep[2] - 0.25) < 0.01, '-6 dB/oct squares the slope (1/n -> 1/n^2)');

  // The property the whole design rests on: neutral changes nothing.
  const neutral = applySpectrum(saw, spectrumOf({}));
  assert([...saw].every((v, i) => Math.abs(v - neutral[i]) < 1e-12), 'a neutral spectrum is the raw wave');
  assert(hasSpectrum({}) === false, 'and does not count as shaping');
  assert(hasSpectrum({ spectrum: { tilt: -3 } }) === true, 'a tilt counts');
  assert(hasSpectrum({ spectrum: { partials: [1, 0.5] } }) === true, 'so does a partial multiplier');
  assert(hasSpectrum({ spectrum: { tilt: 0, partials: [1, 1, 1] } }) === false, 'all-neutral multipliers do not');

  // Multipliers scale what is there and cannot invent what is not.
  const shaped = applySpectrum(baseSeries('sine'), { tilt: 0, partials: [1, 2, 2, 2] });
  assert(shaped[2] === 0 && shaped[3] === 0, 'a sine has nothing above the fundamental to boost');
  const boosted = applySpectrum(saw, { tilt: 0, partials: [1, 2] });
  assert(Math.abs(boosted[2] - 1) < 1e-6, 'but a saw partial can be pushed above its natural level');

  eq(sanitizePartials([1, 0.5]), [1, 0.5], 'a plain list passes through');
  eq(sanitizePartials([5, -1]), [2, 0], 'multipliers clamp to 0..2');
  eq(sanitizePartials([1, 1, 1]), null, 'an all-neutral list is not a spectrum');
  eq(sanitizePartials(['x', 2]), [1, 2], 'junk becomes neutral, not NaN');
  assert(sanitizePartials(new Array(40).fill(0.5)).length === MAX_PARTIALS, 'the editable list is capped');
  eq(sanitizePartials('nope'), null, 'and a non-array is nothing');

  const clamped = spectrumOf({ spectrum: { tilt: 99 } });
  assert(clamped.tilt === TILT_MAX, 'tilt clamps up');
  assert(spectrumOf({ spectrum: { tilt: -99 } }).tilt === TILT_MIN, 'and down');
  assert(spectrumOf({}) === DEFAULT_SPECTRUM, 'no block means the shared default');
}

// ---- the calibrated gain a wave resets to ----
{
  const { defaultGainForWave, DEFAULT_INSTRUMENTS } = await import('../js/core/doc.js');
  const byId = (id) => DEFAULT_INSTRUMENTS.find((i) => i.id === id).gain;
  assert(defaultGainForWave('square') === byId('badge'), 'square resets to the badge level');
  assert(defaultGainForWave('sine') === byId('sine'), 'sine resets to the sine level');
  assert(defaultGainForWave('sawtooth') === byId('saw'), 'sawtooth resets to the saw level');
  // A wave with no built-in of its own still answers, rather than undefined -
  // PWM and triangle instruments have a reset button too.
  assert(defaultGainForWave('triangle') === byId('badge'), 'triangle falls back to the square level');
  assert(defaultGainForWave('custom') === byId('badge'), 'a PWM/custom wave does too');
  assert(defaultGainForWave(undefined) === byId('badge'), 'and so does a missing wave');
  // Read from the built-ins, NOT the document: the whole point is that a
  // project whose stored gains drifted still resets to the right number.
  assert(defaultGainForWave('sine') === 0.5 && defaultGainForWave('square') === 0.35,
    'the calibrated levels are the built-in ones');
}

// ---- track colour and order ----
{
  const {
    trackColorIndex, pickTrackColor, moveTrack, TRACK_COLORS, createTrack: mkTrack,
  } = await import('../js/core/doc.js');

  const doc = createProject({ name: 'order', mode: 'poly' });
  doc.tracks[0].name = 'A';
  for (const n of ['B', 'C', 'D']) {
    doc.tracks.push(mkTrack({ name: n, role: 'melody', instrumentId: 'sine', color: pickTrackColor(doc) }));
  }
  const names = () => doc.tracks.map((t) => t.name).join('');

  // Every track carries its colour explicitly, and a new one takes the
  // least-used entry so tracks stay visually distinct as long as the palette
  // allows.
  eq(doc.tracks.map((t) => t.color), [0, 1, 2, 3], 'new tracks take the least-used colours');
  assert(trackColorIndex(doc, doc.tracks[2]) === 2, 'the colour is read straight off the track');
  doc.tracks[2].color = 6;
  assert(trackColorIndex(doc, doc.tracks[2]) === 6, 'and follows the track when changed');
  assert(trackColorIndex(doc, { ...doc.tracks[0], color: TRACK_COLORS + 3 }) === 3, 'out-of-range colours wrap');
  assert(trackColorIndex(doc, { ...doc.tracks[0], color: -1 }) === TRACK_COLORS - 1, 'and wrap the other way');

  // A literal hex is the second form of the SAME field, for colours the
  // palette does not cover and for hand-editing a project file.
  {
    const { trackColorHex, hasTrackColor, enforceInvariants, migrate } = await import('../js/core/doc.js');
    eq(trackColorHex({ color: '#ff8800' }), '#ff8800', 'a six-digit hex is taken verbatim');
    eq(trackColorHex({ color: '#F80' }), '#f80', 'shorthand works and is normalised to lower case');
    eq(trackColorHex({ color: '  #ff8800  ' }), '#ff8800', 'surrounding whitespace is tolerated');
    eq(trackColorHex({ color: 'red' }), null, 'a CSS keyword is not a hex');
    eq(trackColorHex({ color: '#ff88' }), null, 'a wrong-length hex is rejected');
    eq(trackColorHex({ color: '#gggggg' }), null, 'a non-hex digit is rejected');
    eq(trackColorHex({ color: 3 }), null, 'a palette index is not a hex');
    assert(hasTrackColor({ color: '#ff8800' }) && hasTrackColor({ color: 0 }), 'either form counts as owning a colour');
    assert(!hasTrackColor({ color: 'nope' }) && !hasTrackColor({}), 'a broken or missing colour does not');

    // The point of the whole exercise: nothing downstream overwrites it.
    const d = createProject({ name: 'hex', mode: 'poly' });
    d.tracks[0].color = '#ff8800';
    const warnings = enforceInvariants(d);
    eq(d.tracks[0].color, '#ff8800', 'the baking pass leaves a hand-written hex alone');
    eq(warnings, [], 'and does not report it as damage');
    eq(mkTrack({ name: 'x', color: '#123456' }).color, '#123456', 'createTrack accepts one too');
    eq(migrate(JSON.parse(JSON.stringify(d))).tracks[0].color, '#ff8800', 'and it survives a save/load round trip');
  }

  // pickTrackColor spreads before it repeats, and repeats evenly after that.
  {
    const d = createProject({ name: 'pick', mode: 'poly' }); // one track, colour 0
    for (let i = 1; i < TRACK_COLORS; i++) {
      d.tracks.push(mkTrack({ name: 'T' + i, color: pickTrackColor(d) }));
    }
    eq(d.tracks.map((t) => t.color), [0, 1, 2, 3, 4, 5, 6, 7], 'the palette fills before repeating');
    assert(pickTrackColor(d) === 0, 'and then wraps to the least-used again');
    d.tracks.push(mkTrack({ name: 'ninth', color: pickTrackColor(d) }));
    assert(pickTrackColor(d) === 1, 'spreading evenly rather than piling up');
  }

  // Reordering
  assert(moveTrack(doc, doc.tracks[0].id, 2) === true, 'a track moves');
  assert(names() === 'BCAD', 'to the requested position: ' + names());
  moveTrack(doc, doc.tracks.find((t) => t.name === 'D').id, 0);
  assert(names() === 'DBCA', 'including to the front: ' + names());
  assert(doc.tracks.length === 4, 'no track is lost or duplicated');

  const before = names();
  assert(moveTrack(doc, doc.tracks[1].id, 1) === false, 'moving a track onto itself is a no-op');
  assert(names() === before, 'and changes nothing');
  assert(moveTrack(doc, 'nope', 0) === false, 'an unknown id is a no-op');
  moveTrack(doc, doc.tracks[0].id, 99);
  assert(doc.tracks.length === 4 && doc.tracks[3].name === 'D', 'an out-of-range target clamps to the end');

  // The reason colours are baked in: reordering must not repaint anything.
  {
    const d = createProject({ name: 'colours', mode: 'poly' });
    d.tracks.push(mkTrack({ name: 'second', color: pickTrackColor(d) }));
    const colors = () => d.tracks.map((t) => t.name + ':' + trackColorIndex(d, t)).sort().join();
    const before2 = colors();
    moveTrack(d, d.tracks[0].id, 1);
    assert(colors() === before2, 'every colour survives a reorder: ' + colors());
  }

  // Old documents had no colour field at all; migrate bakes in what they
  // looked like, so nothing changes visually on load.
  {
    const { migrate } = await import('../js/core/doc.js');
    const legacy = JSON.parse(JSON.stringify(createProject({ name: 'legacy', mode: 'poly' })));
    legacy.tracks.push(mkTrack({ name: 'two' }), mkTrack({ name: 'three' }));
    for (const t of legacy.tracks) delete t.color;
    const up = migrate(legacy);
    eq(up.tracks.map((t) => t.color), [0, 1, 2], 'migrate bakes in the position-derived colours');
  }
}

// ---- saved view ----
{
  const { setView, viewOf } = await import('../js/core/doc.js');
  const { createStore } = await import('../js/core/store.js');

  const doc = createProject({ name: 'view', mode: 'poly' });
  assert(viewOf(doc) === null, 'a fresh project has no saved view');

  setView(doc, { scrollTick: 384, scrollPitch: 72, pxPerTick: 1.5, cursorTick: 192, cursorPitch: 60 });
  const v = viewOf(doc);
  assert(v.kind === 'view' && v.v === 1, 'the view is a self-versioned block');
  eq([v.scrollTick, v.scrollPitch, v.pxPerTick, v.cursorTick, v.cursorPitch], [384, 72, 1.5, 192, 60],
    'every field round-trips');

  // Values are clamped to what the editor can actually show, so a corrupt or
  // hand-edited file cannot strand the viewport somewhere unreachable.
  setView(doc, { scrollTick: -500, scrollPitch: 60, pxPerTick: 999, cursorTick: -10, cursorPitch: 60 });
  const c = viewOf(doc);
  assert(c.scrollTick === 0 && c.cursorTick === 0, 'negative positions clamp to the start');
  assert(c.pxPerTick <= 8, 'zoom clamps to the editor range');

  // It travels with the project - that is the point of it being document
  // data rather than a local preference.
  const back = JSON.parse(JSON.stringify(doc));
  eq(viewOf(back), viewOf(doc), 'the view survives a save/load round-trip');

  // Scrolling is not an edit: no undo entry, no history.
  {
    const store = createStore(createProject({ name: 'v2', mode: 'poly' }));
    store.setView({ scrollTick: 100, scrollPitch: 70, pxPerTick: 1, cursorTick: 0, cursorPitch: 60 });
    assert(store.canUndo() === false, 'setting the view pushes no undo snapshot');
    assert(store.getView().scrollTick === 100, 'and is readable back');
  }
}

// ---- polyphony normalization ----
{
  const {
    DEFAULT_NORMALIZE, normalizeConfig, trackExponent, trackExempt, polyphonyTimeline,
    countAt, smooth, predictPeak,
  } = await import('../js/core/normalize.js');
  const { flattenSong } = await import('../js/core/flatten.js');
  const { getInstrument } = await import('../js/core/instruments.js');
  const { createTrack: mkTrack } = await import('../js/core/doc.js');

  // ---- the timeline ----
  {
    const evs = [
      { startTick: 0, durationTicks: 100, trackId: 'a' },
      { startTick: 50, durationTicks: 100, trackId: 'a' },
      { startTick: 50, durationTicks: 20, trackId: 'b' },
    ];
    const line = polyphonyTimeline(evs);
    assert(countAt(line, 0) === 1, 'one voice at the start');
    assert(countAt(line, 50) === 3, 'three where they overlap');
    assert(countAt(line, 70) === 2, 'back to two when the short one ends');
    assert(countAt(line, 100) === 1, 'and one when the first ends');
    assert(countAt(line, 150) === 0, 'silence after the last');
    assert(countAt(line, -5) === 0, 'before the first onset is silence');
    assert(polyphonyTimeline([]).length === 0, 'no events, no timeline');
    assert(countAt([], 10) === 0, 'an empty timeline counts nothing');
    // zero-length events cannot sound, so they must not raise the count
    assert(countAt(polyphonyTimeline([{ startTick: 0, durationTicks: 0, trackId: 'a' }]), 0) === 0,
      'a zero-length event is not a voice');
  }

  // ---- smoothing is zero-phase ----
  {
    const step = [1, 1, 1, 1, 0, 0, 0, 0];
    const out = smooth(step, 5, 20);
    assert(out[3] < 1, 'the fall begins BEFORE the step - smoothing reads ahead');
    assert(out[4] > 0, 'and continues after it');
    assert(out[0] > out[7], 'the overall direction is preserved');
    assert(smooth(step, 5, 0) === step, 'zero smoothing is a pass-through');
  }

  // ---- config ----
  {
    assert(normalizeConfig({}).enabled === true, 'normalization is on by default');
    assert(normalizeConfig({ master: { normalize: { song: 0.8 } } }).song === 0.8, 'overrides merge');
    assert(normalizeConfig({ master: { normalize: { song: 0.8 } } }).track === DEFAULT_NORMALIZE.track,
      'and leave the rest at defaults');
    const cfg = normalizeConfig({});
    assert(trackExponent(cfg, {}) === cfg.track, 'a track follows the song setting');
    assert(trackExponent(cfg, { normalize: false }) === 0, 'a track can opt out');
    assert(trackExponent(cfg, { normalize: 0.9 }) === 0.9, 'or set its own exponent');
    assert(trackExponent(cfg, { normalize: 5 }) === 1, 'which is clamped');
    assert(trackExempt({ normalize: false }) === true, 'false means exempt');
    assert(trackExempt({ normalize: 0 }) === false, 'an exponent of 0 is not the same thing');
    assert(trackExempt({}) === false && trackExempt(null) === false, 'and absent is not exempt');
  }

  // ---- the headline behaviour ----
  const build = (cfg, notes) => {
    const d = createProject({ name: 'norm', mode: 'poly' });
    d.master = { normalize: { ...DEFAULT_NORMALIZE, ...cfg } };
    const tid = d.tracks[0].id;
    for (const [pitch, start, dur] of notes) {
      addNote(d, tid, createNote({ pitch, startTick: start, durationTicks: dur }));
    }
    return d;
  };
  const levelOf = (ev) => (ev.gainCurve ? ev.gainCurve[0] : ev.gainMul ?? 1);

  // Exempt means EXEMPT - from the song stage too, not just the track stage.
  // Cancelling only the track stage was indistinguishable from doing nothing
  // for a monophonic lead, which is exactly the track you want to exclude.
  {
    const doc = createProject({ name: 'exempt', mode: 'poly' });
    doc.master = { normalize: { ...DEFAULT_NORMALIZE, track: 0.5, song: 0.5, smoothMs: 0 } };
    const lead = doc.tracks[0];
    const pad = mkTrack({ name: 'Pad', role: 'melody', instrumentId: 'sine', color: 1 });
    doc.tracks.push(pad);
    // one lead note against a four-voice pad, all sounding together
    addNote(doc, lead.id, createNote({ pitch: 72, startTick: 0, durationTicks: 384 }));
    for (const p of [48, 52, 55, 59]) {
      addNote(doc, pad.id, createNote({ pitch: p, startTick: 0, durationTicks: 384 }));
    }
    const levels = (d) => {
      const evs = flattenSong(d).events;
      const pick = (id) => levelOf(evs.find((e) => e.trackId === id));
      return { lead: pick(lead.id), pad: pick(pad.id) };
    };

    const before = levels(doc);
    assert(before.lead < 0.999, `the lead is ducked while it takes part (${before.lead})`);

    lead.normalize = false;
    const after = levels(doc);
    assert(Math.abs(after.lead - 1) < 1e-9, `an exempt track plays at its written level (${after.lead})`);
    assert(!flattenSong(doc).events.filter((e) => e.trackId === lead.id).some((e) => e.gainCurve),
      'and carries no moving gain at all');
    assert(Math.abs(after.pad - before.pad) < 1e-9,
      'the rest of the arrangement still normalizes around it, unchanged');
  }


  {
    // one note for a bar, then four for a bar: k=0.5 halves the four.
    const doc = build({ track: 0, song: 0.5, smoothMs: 0 },
      [[60, 0, 384], [60, 384, 384], [64, 384, 384], [67, 384, 384], [71, 384, 384]]);
    const evs = flattenSong(doc).events;
    const solo = evs.find((e) => e.startTick === 0);
    const stack = evs.filter((e) => e.startTick === 384);
    assert(Math.abs(levelOf(solo) - 1) < 1e-6, 'a lone voice is left at full level');
    assert(stack.every((e) => Math.abs(levelOf(e) - 0.5) < 1e-3), 'four voices are scaled by 4^-0.5');
    // the sparse part not being taxed is the whole reason this is not one
    // global number
    assert(levelOf(solo) > levelOf(stack[0]) * 1.9, 'the thin part keeps its level');
  }

  {
    // k=1 makes a stack exactly as loud as one note; k=0 disables it.
    const flat = flattenSong(build({ track: 0, song: 1, smoothMs: 0 },
      [[60, 0, 384], [64, 0, 384], [67, 0, 384], [71, 0, 384]])).events;
    assert(flat.every((e) => Math.abs(levelOf(e) - 0.25) < 1e-3), 'k=1 is constant sum');
    const off = flattenSong(build({ track: 0, song: 0, smoothMs: 0 },
      [[60, 0, 384], [64, 0, 384]])).events;
    assert(off.every((e) => !('gainMul' in e) || e.gainMul === 1), 'k=0 leaves levels alone');
    const disabled = flattenSong(build({ enabled: false, smoothMs: 0 },
      [[60, 0, 384], [64, 0, 384]])).events;
    assert(disabled.every((e) => !('gainMul' in e)), 'disabled touches nothing at all');
  }

  {
    // The bug that hid for three rounds of debugging: a note spanning a dense
    // moment has the SAME factor at both ends, and checking only the ends
    // declared it constant - so it sailed through the chord at full level.
    const doc = build({ track: 0, song: 0.5, smoothMs: 0 },
      [[48, 0, 768], [60, 336, 96], [64, 336, 96], [67, 336, 96]]);
    const evs = flattenSong(doc).events;
    const held = evs.find((e) => e.durationTicks === 768);
    assert(!!held.gainCurve, 'a note spanning a chord gets a curve, not a constant');
    const min = Math.min(...held.gainCurve);
    assert(min < 0.55, 'and genuinely ducks while the chord sounds: ' + min.toFixed(3));
    assert(Math.max(...held.gainCurve) > 0.95, 'while keeping full level either side');
  }

  {
    // Per-track and song stages answer different questions and multiply.
    const d = createProject({ name: 'two', mode: 'poly' });
    d.master = { normalize: { ...DEFAULT_NORMALIZE, track: 0.5, song: 0.5, smoothMs: 0 } };
    const a = d.tracks[0];
    const b = mkTrack({ name: 'B', role: 'melody', instrumentId: 'sine' });
    d.tracks.push(b);
    for (const p of [60, 64]) addNote(d, a.id, createNote({ pitch: p, startTick: 0, durationTicks: 384 }));
    addNote(d, b.id, createNote({ pitch: 48, startTick: 0, durationTicks: 384 }));
    const evs = flattenSong(d).events;
    const onA = evs.find((e) => e.trackId === a.id);
    const onB = evs.find((e) => e.trackId === b.id);
    // A: 2 in its track, 3 in the song -> 2^-0.5 * 3^-0.5
    // B: 1 in its track, 3 in the song ->        3^-0.5
    assert(Math.abs(levelOf(onA) - Math.pow(2, -0.5) * Math.pow(3, -0.5)) < 1e-3, 'both stages apply');
    assert(Math.abs(levelOf(onB) - Math.pow(3, -0.5)) < 1e-3, 'a lone voice gets only the song stage');
    // A track can switch off its OWN stage and still follow the song, by
    // setting an exponent of 0 rather than opting out.
    b.normalize = 0;
    const onB2 = flattenSong(d).events.find((e) => e.trackId === b.id);
    assert(Math.abs(levelOf(onB2) - Math.pow(3, -0.5)) < 1e-3, 'exponent 0 keeps the song stage');
    // false is different, and stronger: exempt from both.
    b.normalize = false;
    const onB3 = flattenSong(d).events.find((e) => e.trackId === b.id);
    assert(Math.abs(levelOf(onB3) - 1) < 1e-9, 'opting out escapes the song stage too');
  }

  {
    // Mono must be untouched - this is what keeps .h/.fmf and the badge
    // preview out of reach of any of it.
    const d = createProject({ name: 'mono', mode: 'mono' });
    d.master = { normalize: { ...DEFAULT_NORMALIZE, song: 1, track: 1 } };
    const tid = d.tracks[0].id;
    addNote(d, tid, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
    addNote(d, tid, createNote({ pitch: 64, startTick: 96, durationTicks: 96 }));
    const evs = flattenSong(d).events;
    assert(evs.every((e) => !('gainMul' in e) && !e.gainCurve), 'mono events carry no normalization');
  }

  // ---- the release holds the note's own level ----
  {
    // A voice holds its final curve value through its release. That value has
    // to be the level the note actually HAD, or a ducked chord releases at
    // full volume - reported as "the release ramps up to clipping". Two
    // things conspired: the last sample was taken 0.1 ms inside a 5 ms grid
    // (same cell as the note's end, where the simultaneous notes had already
    // been decremented), and smoothing eases the factor back toward 1 before
    // the note is over.
    const d = createProject({ name: 'rel', mode: 'poly' });
    d.master = { normalize: { ...DEFAULT_NORMALIZE, track: 0.5, song: 0.5 } };
    d.instruments.find((i) => i.id === 'badge').adsr = { a: 0.005, d: 0, s: 1, r: 0.4 };
    const tid = d.tracks[0].id;
    for (const p of [60, 64, 67, 71]) {
      addNote(d, tid, createNote({ pitch: p, startTick: 0, durationTicks: 192 }));
    }
    addNote(d, tid, createNote({ pitch: 36, startTick: 0, durationTicks: 576 }));

    for (const ev of flattenSong(d).events.filter((e) => e.durationTicks === 192)) {
      const c = ev.gainCurve ? Array.from(ev.gainCurve) : [ev.gainMul ?? 1];
      const note = c[0];
      const held = c[c.length - 1];
      assert(held <= note * 1.25,
        `the release holds the note's level (${note.toFixed(3)} -> ${held.toFixed(3)})`);
    }

    // ...but a note that OUTLIVES the others is alone by the time it ends, so
    // releasing at full level is correct, not a bug.
    const long = flattenSong(d).events.find((e) => e.durationTicks === 576);
    const lc = long.gainCurve ? Array.from(long.gainCurve) : [long.gainMul ?? 1];
    assert(lc[lc.length - 1] > lc[0] * 2, 'a note left alone does recover');
  }

  // ---- a monophonic line is never ducked ----
  {
    // Counting release tails as full voices made a plain melody - no chords
    // anywhere - read as two voices and halved. Voice count says nothing
    // about loudness, and a decaying tail is not another note.
    for (const r of [0, 0.1, 0.4]) {
      const d = createProject({ name: 'mono-line', mode: 'poly' });
      d.master = { normalize: { ...DEFAULT_NORMALIZE, track: 0.5, song: 0.5 } };
      d.instruments.find((i) => i.id === 'badge').adsr = { a: 0.005, d: 0, s: 1, r };
      const tid = d.tracks[0].id;
      for (let i = 0; i < 6; i++) {
        addNote(d, tid, createNote({ pitch: 60 + i, startTick: i * 96, durationTicks: 96 }));
      }
      for (const ev of flattenSong(d).events) {
        const lvl = ev.gainCurve ? Math.min(...ev.gainCurve) : ev.gainMul ?? 1;
        assert(lvl >= 1, `a melody with a ${r * 1000} ms release is untouched (got ${lvl.toFixed(3)})`);
      }
    }
  }

  // ---- predictPeak ----
  {
    const doc = build({ enabled: false }, [[60, 0, 384], [64, 0, 384], [67, 0, 384]]);
    const p = predictPeak(doc, flattenSong(doc).events, (ev) => getInstrument(doc, ev.instrumentId), 1);
    assert(p.voices === 3, 'the loudest moment counts its voices');
    assert(p.tick === 0, 'and reports where it is');
    const one = build({ enabled: false }, [[60, 0, 384]]);
    const p1 = predictPeak(one, flattenSong(one).events, (ev) => getInstrument(one, ev.instrumentId), 1);
    assert(Math.abs(p.peak - p1.peak * 3) < 1e-6, 'three voices sum to three times one');
    eq(predictPeak(doc, [], () => null), { peak: 0, tick: 0, voices: 0 }, 'no events, no peak');

    // The mixer counts. Without this the estimate described a render nobody
    // could produce: every project with a fader below unity read high.
    const faded = build({ enabled: false }, [[60, 0, 384]]);
    faded.tracks[0].gain = 0.5;
    const pFaded = predictPeak(faded, flattenSong(faded).events, (ev) => getInstrument(faded, ev.instrumentId), 1);
    assert(Math.abs(pFaded.peak - p1.peak * 0.5) < 1e-9,
      `a fader at 50% halves the predicted peak (${pFaded.peak} vs ${p1.peak})`);
    const boosted = build({ enabled: false }, [[60, 0, 384]]);
    boosted.tracks[0].gain = 1.5;
    const pBoost = predictPeak(boosted, flattenSong(boosted).events, (ev) => getInstrument(boosted, ev.instrumentId), 1);
    assert(Math.abs(pBoost.peak - p1.peak * 1.5) < 1e-9, 'and a boosted one raises it');

    // Velocity is carried but NOT applied, so the estimate must not move with
    // it either - an estimate that disagreed with the voice would warn about
    // clipping that cannot happen, or miss clipping that can.
    const loud = build({ enabled: false }, [[60, 0, 384]]);
    loud.tracks[0].notes[0].velocity = 127;
    const quiet = build({ enabled: false }, [[60, 0, 384]]);
    quiet.tracks[0].notes[0].velocity = 20;
    const pLoud = predictPeak(loud, flattenSong(loud).events, (ev) => getInstrument(loud, ev.instrumentId), 1);
    const pQuiet = predictPeak(quiet, flattenSong(quiet).events, (ev) => getInstrument(quiet, ev.instrumentId), 1);
    assert(Math.abs(pLoud.peak - pQuiet.peak) < 1e-9,
      `velocity does not move the predicted peak (${pLoud.peak} vs ${pQuiet.peak})`);
    assert(Math.abs(pLoud.peak - p1.peak) < 1e-9, 'and both match a nominal-velocity note');

    // Carried, though: dropping it from the document would lose MIDI data we
    // cannot recover, and the whole point is that it waits for a UI.
    eq(flattenSong(quiet).events[0].velocity, 20, 'the event stream still carries the velocity');
    eq(quiet.tracks[0].notes[0].velocity, 20, 'and so does the note');
  }
}

// ---- per-track mix: gain, pan, solo ----
{
  const {
    trackGain, trackPan, needsStereo, playableTracks, createTrack,
  } = await import('../js/core/doc.js');
  const { formatPan } = await import('../js/core/units.js');

  const doc = createProject({ name: 'mix', mode: 'poly' });
  const a = doc.tracks[0];
  const b = createTrack({ name: 'B', role: 'melody', instrumentId: 'sine' });
  const c = createTrack({ name: 'C', role: 'melody', instrumentId: 'saw' });
  doc.tracks.push(b, c);

  // Additive with defaults: a project that never opened the mixer behaves
  // exactly as it did before the mixer existed.
  assert(trackGain(a) === 1 && trackPan(a) === 0, 'untouched tracks are unity and centred');
  assert(needsStereo(doc) === false, 'and need no second channel');
  assert(trackGain({ gain: 2 }) === 1.5, 'gain is clamped to the slider range');
  assert(trackGain({ gain: -1 }) === 0, 'and cannot go negative');
  assert(trackPan({ pan: -9 }) === -1 && trackPan({ pan: 9 }) === 1, 'pan is clamped to the field');
  assert(trackGain({ gain: 'loud' }) === 1, 'a non-number falls back to the default');

  b.pan = -0.5;
  assert(needsStereo(doc) === true, 'one panned track makes the render stereo');
  const mono = createProject({ name: 'm', mode: 'mono' });
  mono.tracks[0].pan = 1;
  assert(needsStereo(mono) === false, 'mono stays mono however it is panned');
  b.pan = 0;

  // Solo beats mute-by-omission: "let me hear only this".
  eq(playableTracks(doc).map((t) => t.name), [a.name, 'B', 'C'], 'everything plays by default');
  b.solo = true;
  eq(playableTracks(doc).map((t) => t.name), ['B'], 'a soloed track plays alone');
  c.solo = true;
  eq(playableTracks(doc).map((t) => t.name), ['B', 'C'], 'several soloed tracks play together');
  b.role = 'muted';
  eq(playableTracks(doc).map((t) => t.name), ['C'], 'muting a soloed track still silences it');
  b.role = 'melody';
  b.solo = false;
  c.solo = false;
  a.role = 'muted';
  eq(playableTracks(doc).map((t) => t.name), ['B', 'C'], 'mute alone still works');
  a.role = 'melody';

  // Mono ignores all of it - the melody track is the voice, full stop, which
  // is what keeps .h and .fmf out of reach of any of this.
  mono.tracks[0].solo = false;
  mono.tracks[0].role = 'muted';
  eq(playableTracks(mono).map((t) => t.name), ['Lead'], 'mono plays its melody track regardless');

  // Spread: melody centred, the rest fanned outward alternately.
  {
    const { spreadPan, hasPanLane } = await import('../js/core/doc.js');
    const d = createProject({ name: 'spread', mode: 'poly' });
    for (const name of ['B', 'C', 'D', 'E']) {
      d.tracks.push(createTrack({ name, role: 'melody', instrumentId: 'sine' }));
    }
    spreadPan(d);
    assert(trackPan(d.tracks[0]) === 0, 'the melody track stays centred');
    const pans = d.tracks.slice(1).map(trackPan);
    assert(pans.some((p) => p < 0) && pans.some((p) => p > 0), 'the rest fan to both sides');
    assert(pans.every((p) => Math.abs(p) <= 1), 'and stay inside the field');
    assert(new Set(pans.map((p) => Math.sign(p))).size === 2, 'sides alternate rather than piling up');
    assert(needsStereo(d) === true, 'a spread project renders stereo');

    // A single-track project has nothing to fan out.
    const solo1 = createProject({ name: 'one', mode: 'poly' });
    spreadPan(solo1);
    assert(trackPan(solo1.tracks[0]) === 0, 'one track is left where it was');

    // A pan LANE takes over from the static value, so the static slider must
    // stand down rather than fight it.
    const laned = createProject({ name: 'laned', mode: 'poly' });
    assert(hasPanLane(laned.tracks[0]) === false, 'no lane by default');
    laned.tracks[0].automation = { pan: [{ tick: 0, value: -1, curve: 'linear' }] };
    assert(hasPanLane(laned.tracks[0]) === true, 'a pan lane is detected');
    assert(needsStereo(laned) === true, 'and forces a stereo render on its own');
  }

  // A pan lane is sampled per event, exactly like the other lanes, so an
  // arpeggio can ping-pong step by step.
  {
    const { flattenSong } = await import('../js/core/flatten.js');
    const d = createProject({ name: 'panlane', mode: 'poly' });
    const t = d.tracks[0];
    t.automation = { pan: [
      { tick: 0, value: -1, curve: 'linear' },
      { tick: 384, value: 1, curve: 'linear' },
    ] };
    addNote(d, t.id, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
    addNote(d, t.id, createNote({ pitch: 62, startTick: 192, durationTicks: 96 }));
    addNote(d, t.id, createNote({ pitch: 64, startTick: 384, durationTicks: 96 }));
    const evs = flattenSong(d).events;
    assert(Math.abs(evs[0].pan + 1) < 1e-9, 'the first event sits hard left');
    assert(Math.abs(evs[1].pan) < 1e-9, 'the middle event has swept to centre');
    assert(Math.abs(evs[2].pan - 1) < 1e-9, 'the last sits hard right');

    // No lane means no field on the event at all, so documents without one
    // flatten to exactly the stream they always did.
    const plain = createProject({ name: 'nopan', mode: 'poly' });
    addNote(plain, plain.tracks[0].id, createNote({ pitch: 60, startTick: 0, durationTicks: 96 }));
    assert(!('pan' in flattenSong(plain).events[0]), 'no lane, no pan field');
  }

  assert(formatPan(0) === 'C', 'centre reads as C');
  assert(formatPan(-0.5) === 'L50', 'left reads as L50');
  assert(formatPan(1) === 'R100', 'hard right reads as R100');
  assert(formatPan(0.001) === 'C', 'a hair off centre still reads as centre');
}

// ---- modulation: one shape for ADSR and drawn envelopes ----
{
  const {
    adsrToEnv, envToAdsr, isAdsrShaped, effectiveEnvelope, sampleEnvelope,
    releaseTime, buildGainCurve, sampleLfo, CURVE_STEP_S,
  } = await import('../js/core/modulation.js');

  const adsr = { a: 0.1, d: 0.2, s: 0.5, r: 0.3 };
  const env = adsrToEnv(adsr);

  // The sliders and a drawn curve must be the same data, or they would drift.
  eq(envToAdsr(env), adsr, 'ADSR round-trips through the envelope shape');
  assert(isAdsrShaped(env) === true, 'a generated envelope is recognised as ADSR-shaped');
  assert(releaseTime(env) === 0.3, 'release time comes off the post-sustain points');

  // A shape the four sliders cannot express must NOT be rounded back into
  // them - that is how the UI knows to grey them out instead of lying.
  const drawn = { ...env, points: [...env.points, { t: 0.5, value: 0.2, curve: 'linear' }] };
  assert(envToAdsr(drawn) === null, 'a drawn shape does not pretend to be ADSR');
  assert(isAdsrShaped(drawn) === false, 'and is reported as not ADSR-shaped');
  const eased = { ...env, points: env.points.map((p, i) => (i === 1 ? { ...p, curve: 'ease' } : p)) };
  assert(envToAdsr(eased) === null, 'a curved segment is not ADSR either');

  // Held long enough to reach sustain.
  const hold = 2;
  assert(sampleEnvelope(env, 0, hold) === 0, 'starts silent');
  assert(Math.abs(sampleEnvelope(env, 0.05, hold) - 0.5) < 1e-9, 'ramps up through the attack');
  assert(Math.abs(sampleEnvelope(env, 0.1, hold) - 1) < 1e-9, 'peaks at the end of the attack');
  assert(Math.abs(sampleEnvelope(env, 0.2, hold) - 0.75) < 1e-9, 'decays toward sustain');
  assert(Math.abs(sampleEnvelope(env, 0.3, hold) - 0.5) < 1e-9, 'reaches the sustain level');
  assert(Math.abs(sampleEnvelope(env, 1.5, hold) - 0.5) < 1e-9, 'holds it for as long as the note lasts');
  assert(Math.abs(sampleEnvelope(env, hold + 0.15, hold) - 0.25) < 1e-9, 'releases from the sustain level');
  assert(Math.abs(sampleEnvelope(env, hold + 0.3, hold)) < 1e-9, 'and reaches silence');
  assert(sampleEnvelope(env, hold + 5, hold) === 0, 'and stays there');

  // The case worth having a model for: a note SHORTER than its own attack.
  // Release must start from where the envelope actually got to. Starting from
  // the sustain level it never reached would jump the level UP at note-off -
  // an audible click, and a loud one on a slow pad.
  {
    const shortHold = 0.05; // half-way up a 0.1 s attack
    const atOff = sampleEnvelope(env, shortHold, shortHold);
    assert(Math.abs(atOff - 0.5) < 1e-9, 'a short note ends half-way up the attack');
    const justAfter = sampleEnvelope(env, shortHold + 0.0001, shortHold);
    assert(justAfter <= atOff + 1e-6, 'the level never jumps up at note-off');
    assert(Math.abs(sampleEnvelope(env, shortHold + 0.15, shortHold) - 0.25) < 1e-6,
      'the release is scaled to where the note actually was');
    assert(Math.abs(sampleEnvelope(env, shortHold + 0.3, shortHold)) < 1e-9, 'and still ends silent');
  }

  // A percussive envelope (sustain 0) must not divide by its own zero.
  {
    const perc = adsrToEnv({ a: 0.001, d: 0.05, s: 0, r: 0.01 });
    const v = sampleEnvelope(perc, 0.2, 0.5);
    assert(v === 0 && Number.isFinite(v), 'a zero-sustain envelope decays to silence, not NaN');
    assert(Number.isFinite(sampleEnvelope(perc, 0.55, 0.5)), 'and releases finitely');
  }

  // An event-level ADSR override (what the automation lanes sample) feeds the
  // envelope generator rather than a parallel code path.
  {
    const inst = { adsr, gain: 1 };
    assert(envToAdsr(effectiveEnvelope(inst)).a === 0.1, 'the instrument envelope is used by default');
    assert(envToAdsr(effectiveEnvelope(inst, { a: 0.5 })).a === 0.5, 'a lane override wins');
    assert(envToAdsr(effectiveEnvelope(inst, { a: 0.5 })).d === 0.2, 'and leaves the rest alone');
    const withDrawn = { adsr, gain: 1, env: drawn };
    assert(effectiveEnvelope(withDrawn) === drawn, 'an explicitly drawn envelope overrides the sliders');
  }

  // ---- the merged curve ----
  {
    const flat = buildGainCurve({ env, peak: 0.5, holdSec: 1 });
    assert(flat.curve.length > 2, 'a curve is produced');
    assert(Math.abs(flat.duration - 1.3) < 1e-9, 'it spans the note AND its release tail');
    assert(flat.curve[0] === 0, 'it starts silent');
    assert(flat.curve[flat.curve.length - 1] === 0, 'and ends silent, so the voice cannot hang');
    const peakIdx = flat.curve.indexOf(Math.max(...flat.curve));
    assert(Math.abs(peakIdx * (flat.duration / (flat.curve.length - 1)) - 0.1) < 0.005,
      'the peak lands at the end of the attack');
    assert(Math.abs(Math.max(...flat.curve) - 0.5) < 1e-6, 'and reaches instrument gain x velocity');

    // Resolution has to resolve the sharpest thing in the shape: the badge's
    // attack is 2 ms, so a fixed points-per-note budget would smear it away
    // on any long note.
    const badge = adsrToEnv({ a: 0.002, d: 0, s: 1, r: 0.002 });
    const long = buildGainCurve({ env: badge, peak: 1, holdSec: 8 });
    const step = long.duration / (long.curve.length - 1);
    assert(step <= CURVE_STEP_S + 1e-12, 'sampling is by time, not by a fixed point count');
    assert(long.curve[Math.round(0.002 / step)] > 0.99, 'a 2 ms attack still reaches full level');

    // The song-absolute lane multiplies the note-relative envelope - in the
    // value domain, which is the whole point of this module.
    const half = buildGainCurve({ env, peak: 1, holdSec: 1, laneAt: () => 0.5 });
    const plain = buildGainCurve({ env, peak: 1, holdSec: 1 });
    let sameShape = true;
    for (let i = 0; i < half.curve.length; i++) {
      if (Math.abs(half.curve[i] - plain.curve[i] * 0.5) > 1e-6) sameShape = false;
    }
    assert(sameShape, 'a constant lane scales the envelope exactly');

    const ramp = buildGainCurve({ env, peak: 1, holdSec: 1, laneAt: (t) => Math.min(1, t) });
    assert(ramp.curve[10] < plain.curve[10], 'a rising lane starts below the plain envelope');
  }

  // LFO: reserved for vibrato, tested so adding the UI is a UI job.
  assert(sampleLfo(null, 1) === 0, 'no LFO is silence');
  assert(sampleLfo({ rate: 5, depth: 50, delay: 0.2 }, 0.1) === 0, 'the delay holds it off');
  assert(Math.abs(sampleLfo({ rate: 1, depth: 100 }, 0.25) - 100) < 1e-9, 'a quarter cycle is full depth');
  assert(Math.abs(sampleLfo({ rate: 1, depth: 100 }, 0.75) + 100) < 1e-9, 'three quarters is full negative');
}

// ---- tool manifest ----
// The manifest must be usable with nothing but the two stores: no DOM, no
// piano roll, no tool module loaded. That is exactly what lets a COLLAPSED
// card show its indicator without importing anything - so it is worth
// proving here, where none of those things exist to accidentally lean on.
{
  const { TOOLS } = await import('../js/ui/tools/manifest.js');

  const ctxFor = (doc, ui = {}) => ({
    store: { getDoc: () => doc },
    uiStore: { state: { selection: new Set(), selectionTrackId: null, ...ui } },
  });

  assert(TOOLS.length >= 3, 'the manifest lists the tools');
  assert(new Set(TOOLS.map((t) => t.id)).size === TOOLS.length, 'tool ids are unique');
  for (const tool of TOOLS) {
    assert(typeof tool.name === 'string' && tool.name, `${tool.id} has a name`);
    assert(typeof tool.when === 'function', `${tool.id} declares when()`);
    assert(typeof tool.status === 'function', `${tool.id} declares status()`);
    assert(typeof tool.load === 'function', `${tool.id} declares load()`);
  }

  const byId = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
  const doc = createProject({ name: 'tools', mode: 'poly' });
  const trackId = doc.tracks[0].id;
  const plain = createNote({ pitch: 60, startTick: 0, durationTicks: 96 });
  const arped = createNote({
    pitch: 64, startTick: 96, durationTicks: 96,
    harmonics: { mode: 'arp', stepsPerBeat: 2, pattern: 'up', octaves: 1, gate: 1, chordType: 'major' },
  });
  addNote(doc, trackId, plain);
  addNote(doc, trackId, arped);

  // Nothing selected: no tool that acts on a selection applies.
  {
    const ctx = ctxFor(doc);
    assert(byId.harmonics.when(ctx) === false, 'harmonics needs a selection');
    // transpose falls back to the whole active track, which does have notes
    assert(byId.transpose.when(ctx) === true, 'transpose falls back to the whole track');
    assert(byId.transpose.status(ctx).label.includes('whole'), 'and says so');
  }

  // A selected note WITHOUT a decoration: applicable, but nothing is in play,
  // so the card has no reason to open itself.
  {
    const ctx = ctxFor(doc, { selection: new Set([plain.id]), selectionTrackId: trackId });
    const st = byId.harmonics.status(ctx);
    assert(byId.harmonics.when(ctx) === true, 'harmonics applies to a selection');
    assert(st.on === false, 'an undecorated note leaves the indicator off');
    assert(st.label === '1 note', 'the label still says what is selected: ' + st.label);
  }

  // A selected note WITH one: in play, so the card opens itself.
  {
    const ctx = ctxFor(doc, { selection: new Set([arped.id]), selectionTrackId: trackId });
    const st = byId.harmonics.status(ctx);
    assert(st.on === true, 'a decorated note lights the indicator');
    assert(st.label === '1/1 arp', 'and counts them: ' + st.label);
  }

  // Instrument: available in poly whenever there is an active track, which is
  // always - the card is cheap while collapsed, and hiding it would mean the
  // sound of the track you are editing is only reachable via a dropdown.
  {
    const ctx = ctxFor(doc);
    assert(byId.instrument.when(ctx) === true, 'instrument applies to the active track');

    // The three stock instruments are the baseline: nothing to show, so the
    // card stays closed.
    assert(byId.instrument.status(ctx).on === false, 'a stock instrument is not "configured"');
    assert(byId.instrument.status(ctx).label.includes('Square'), 'the label names the instrument');
    doc.tracks[0].instrumentId = 'sine';
    assert(byId.instrument.status(ctx).on === false, 'nor is another stock instrument');
    doc.tracks[0].instrumentId = 'saw';
    assert(byId.instrument.status(ctx).on === false, 'nor the third');

    // A saved preset means someone built that sound deliberately.
    doc.instruments.push({ id: 'my-preset', name: 'Bell', wave: 'sine', adsr: {}, gain: 0.5 });
    doc.tracks[0].instrumentId = 'my-preset';
    const preset = byId.instrument.status(ctx);
    assert(preset.on === true, 'a saved preset lights the indicator');
    assert(preset.label.includes('Bell'), 'and names it: ' + preset.label);

    // So does a fine-tuned Custom config.
    doc.tracks[0].instrumentId = 'badge';
    doc.tracks[0].instrument = { id: 'track:' + trackId, name: 'Custom', wave: 'square', adsr: {}, gain: 1 };
    const custom = byId.instrument.status(ctx);
    assert(custom.on === true, 'a Custom instrument lights the indicator');
    assert(custom.label.includes('Custom'), 'and says so: ' + custom.label);
    doc.tracks[0].instrument = null;
    doc.instruments.pop();

    const mono = createProject({ name: 'mono', mode: 'mono' });
    assert(byId.instrument.when(ctxFor(mono)) === false, 'the instrument tool is poly-only');
  }

  // Transpose keeps nothing, so it must never claim to be in play - that is
  // what keeps it closed by default.
  {
    const ctx = ctxFor(doc, { selection: new Set([arped.id]), selectionTrackId: trackId });
    assert(byId.transpose.status(ctx).on === false, 'a stateless tool never lights up');
  }
}

// ---- storage that never throws ----
// persist.js touches localStorage/document/window, none of which exist here,
// so this runs against minimal stubs. The point is the failure behaviour: an
// editor must not die because a browser refuses to store things.
{
  const store = new Map();
  let mode = 'ok'; // 'ok' | 'security' | 'quota'
  globalThis.localStorage = {
    getItem(k) {
      if (mode === 'security') throw Object.assign(new Error('denied'), { name: 'SecurityError' });
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      if (mode === 'security') throw Object.assign(new Error('denied'), { name: 'SecurityError' });
      if (mode === 'quota') throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      store.set(k, v);
    },
    removeItem(k) {
      if (mode !== 'ok') throw Object.assign(new Error('denied'), { name: 'SecurityError' });
      store.delete(k);
    },
  };
  globalThis.document = { addEventListener() {} };
  globalThis.window = { addEventListener() {} };

  const persist = await import('../js/core/persist.js');

  // Healthy path first, so the degraded assertions below mean something.
  const doc = createProject({ name: 'Saveable', mode: 'mono' });
  assert(persist.saveProject(doc) === true, 'a healthy store reports a durable save');
  assert(persist.isDegraded() === false, 'a healthy store is not degraded');
  assert(persist.loadProject(doc.id).name === 'Saveable', 'the project reads back');
  assert(persist.listProjects().length === 1, 'the index lists it');
  assert(persist.lastOpenId() === doc.id, 'lastOpen points at it');

  // A corrupt entry must read as absent rather than throw into the boot path.
  store.set('chipseq.v1.index', '{not json');
  eq(persist.listProjects(), [], 'a corrupt index reads as empty');
  store.set('chipseq.v1.proj.' + doc.id, 'garbage');
  assert(persist.loadProject(doc.id) === null, 'a corrupt project reads as missing');

  // Now the quota fills up mid-session.
  mode = 'quota';
  let reason = null;
  persist.onStorageDegraded((r) => (reason = r));
  const doc2 = createProject({ name: 'Too big', mode: 'mono' });
  let threw = false;
  let durable = true;
  try {
    durable = persist.saveProject(doc2);
  } catch {
    threw = true;
  }
  assert(!threw, 'a full quota does not throw at the caller');
  assert(durable === false, 'and the caller is told the save was not durable');
  assert(persist.isDegraded() === true, 'the store is marked degraded');
  assert(reason === 'storage is full', 'the reason is reported: ' + reason);

  // Degraded does NOT mean broken: the open project must keep working, in
  // memory, for the rest of the session.
  assert(persist.loadProject(doc2.id).name === 'Too big', 'a degraded store still serves this session');
  assert(persist.listProjects().some((p) => p.id === doc2.id), 'and still lists it');
  assert(store.has('chipseq.v1.proj.' + doc2.id) === false, 'nothing was written durably');

  // Crucially, it must never delete someone else's project to make room.
  assert(store.has('chipseq.v1.proj.' + doc.id), 'an existing project is never evicted to free space');

  // Reads keep working after a hard SecurityError too.
  mode = 'security';
  let readThrew = false;
  try {
    persist.listProjects();
    persist.lastOpenId();
    persist.loadPresets();
    persist.savePresets([{ name: 'x' }]);
  } catch {
    readThrew = true;
  }
  assert(!readThrew, 'a locked-down store never throws on read or write');
  eq(persist.loadPresets(), [{ name: 'x' }], 'presets round-trip through the in-memory fallback');

  delete globalThis.localStorage;
  delete globalThis.document;
  delete globalThis.window;
}

// ---- referential invariants ----
{
  const { enforceInvariants, normalizeDoc, createTrack, getTrack } = await import('../js/core/doc.js');
  const { createStore } = await import('../js/core/store.js');

  const twoTrack = () => {
    const d = createProject({ name: 'inv', mode: 'poly' });
    const extra = createTrack({ name: 'Second', role: 'melody', instrumentId: 'sine' });
    d.tracks.push(extra);
    return { d, extra };
  };

  // A clean document must be left completely alone - a pass that "repairs"
  // healthy projects would rewrite everyone's files on load.
  {
    const { d } = twoTrack();
    const before = JSON.stringify(d);
    eq(enforceInvariants(d), [], 'a well-formed project needs no repairs');
    assert(JSON.stringify(d) === before, 'a well-formed project is not modified');
  }

  // Duplicate track ids. Every lookup by id resolves to the first match, so
  // the second track answers to the first one's colour, selection and notes -
  // which is exactly how a track showed one colour in the panel and another
  // in the Mixer. The tracks are distinct; only the label collided.
  {
    const { d, extra } = twoTrack();
    const shared = d.tracks[0].id;
    extra.id = shared;
    extra.instrument = { kind: 'square' };
    extra.instrumentId = 'track:' + shared;
    const warnings = enforceInvariants(d);
    assert(d.tracks[0].id !== d.tracks[1].id, 'a duplicate id is re-issued');
    assert(d.tracks[0].id === shared, 'the first holder keeps the id it had');
    assert(extra.instrumentId === 'track:' + extra.id,
      'a per-track instrument reference follows the new id: ' + extra.instrumentId);
    assert(extra.instrument, 'and the custom instrument is not reset as an orphan');
    assert(warnings.some((w) => w.includes('shared an id')), 'the repair is reported: ' + JSON.stringify(warnings));
    // The property this all exists to protect.
    assert(getTrack(d, extra.id) === extra, 'each track is now reachable by its own id');
  }

  // A colour is part of the saved configuration, not something a view derives.
  {
    const { d } = twoTrack();
    delete d.tracks[1].color;
    enforceInvariants(d);
    assert(Number.isInteger(d.tracks[1].color), 'a track without a colour gets one baked in');
    assert(d.tracks[1].color !== d.tracks[0].color, 'and it is not one already in use');
    assert(Number.isInteger(createTrack({ name: 'x', doc: d }).color), 'createTrack bakes one at birth');
  }

  // Deleting a track: the markers follow, without the call site doing it.
  {
    const { d, extra } = twoTrack();
    d.activeTrackId = extra.id;
    d.melodyTrackId = extra.id;
    d.chordTrackId = extra.id;
    d.tracks = d.tracks.filter((t) => t.id !== extra.id);
    const warnings = enforceInvariants(d);
    assert(d.activeTrackId === d.tracks[0].id, 'a dangling active track is re-pointed');
    assert(d.melodyTrackId === d.tracks[0].id, 'a dangling melody marker is re-pointed');
    assert(d.chordTrackId === null, 'a dangling chords marker becomes null, not a guess');
    assert(warnings.length === 3, 'each repair is reported: ' + JSON.stringify(warnings));
  }

  // The melody marker should prefer something audible.
  {
    const { d, extra } = twoTrack();
    d.tracks[0].role = 'muted';
    d.melodyTrackId = 'gone';
    enforceInvariants(d);
    assert(d.melodyTrackId === extra.id, 'a re-pointed melody marker skips muted tracks');
  }

  // Muting the melody track is a legitimate thing to do; the marker must NOT
  // wander off on its own (moving markers behind the user's back is exactly
  // the behaviour that was reported as a bug once already).
  {
    const { d } = twoTrack();
    d.melodyTrackId = d.tracks[0].id;
    d.tracks[0].role = 'muted';
    eq(enforceInvariants(d), [], 'muting the melody track is not treated as damage');
    assert(d.melodyTrackId === d.tracks[0].id, 'the melody marker stays where the user put it');
  }

  // Instrument references may never dangle.
  {
    const { d } = twoTrack();
    d.tracks[0].instrumentId = 'deleted-preset';
    const warnings = enforceInvariants(d);
    assert(d.tracks[0].instrumentId === 'badge', 'an orphaned instrument falls back to Square');
    assert(warnings.length === 1 && /no longer exists/.test(warnings[0]), 'the fallback is reported');
  }
  {
    const { d } = twoTrack();
    d.tracks[0].instrumentId = 'track:' + d.tracks[0].id;
    d.tracks[0].instrument = null; // the virtual id resolves to nothing
    enforceInvariants(d);
    assert(d.tracks[0].instrumentId === 'badge', 'a custom id with no config falls back');
  }
  {
    const { d, extra } = twoTrack();
    d.tracks[0].instrumentId = 'track:' + extra.id; // another track's config
    d.tracks[0].instrument = null;
    enforceInvariants(d);
    assert(d.tracks[0].instrumentId === 'badge', 'a custom id borrowed from another track falls back');
  }

  // Structural minimums.
  {
    const d = createProject({ name: 'empty', mode: 'mono' });
    d.tracks = [];
    enforceInvariants(d);
    assert(d.tracks.length === 1, 'a track-less project gets one back');
    assert(getTrack(d, d.activeTrackId) && getTrack(d, d.melodyTrackId), 'and the markers point at it');
  }
  {
    const d = createProject({ name: 'noinst', mode: 'mono' });
    d.instruments = [];
    enforceInvariants(d);
    assert(d.instruments.length >= 3, 'an empty instrument list is restored');
    assert(d.instruments.some((i) => i.id === 'badge'), 'the badge square is always present');
  }
  {
    const d = createProject({ name: 'nobadge', mode: 'mono' });
    d.instruments = d.instruments.filter((i) => i.id !== 'badge');
    enforceInvariants(d);
    assert(d.instruments[0].id === 'badge', 'a missing badge square is restored - mono forces it');
  }

  // The store runs the pass on every path, so a snapshot restored by undo is
  // repaired too - history can never reintroduce a dangling reference.
  {
    const { d, extra } = twoTrack();
    d.activeTrackId = extra.id;
    d.melodyTrackId = extra.id; // the markers point at the track about to go
    const store = createStore(d);
    let reported = null;
    store.on('doc-repaired', (w) => (reported = w));
    store.commit('delete track', ['tracks'], (doc2) => {
      doc2.tracks = doc2.tracks.filter((t) => t.id !== extra.id);
    });
    assert(reported && reported.length >= 1, 'the store reports repairs it had to make');
    store.undo();
    assert(getTrack(store.getDoc(), store.getDoc().melodyTrackId), 'undo restores a well-formed document');
    store.redo();
    assert(getTrack(store.getDoc(), store.getDoc().melodyTrackId), 'redo does too');
  }
  {
    // setDoc is the project-open path: a corrupt file must be repaired there
    const store = createStore(createProject({ name: 'x', mode: 'mono' }));
    const broken = createProject({ name: 'broken', mode: 'mono' });
    broken.activeTrackId = 'nope';
    broken.melodyTrackId = 'nope';
    let reported = null;
    store.on('doc-repaired', (w) => (reported = w));
    store.setDoc(broken);
    assert(reported && reported.length === 2, 'opening a corrupt project reports the repairs');
    assert(getTrack(store.getDoc(), store.getDoc().activeTrackId), 'and the document is usable');
  }
}

// ---- tempo / meter maps ----
{
  const {
    migrate, bpmAt, timeSigAt, tickToSeconds, secondsToTick, setTempo, setTimeSig,
    ticksPerBeat, ticksPerBar, syncLegacyFields, normalizeDoc, unsupportedFeatures,
  } = await import('../js/core/doc.js');

  const d = createProject({ name: 'tempo', mode: 'poly' });
  assert(Array.isArray(d.song.tempo) && d.song.tempo[0].tick === 0, 'a new project starts with a tempo map');
  assert(Array.isArray(d.song.meter) && d.song.meter[0].tick === 0, 'a new project starts with a meter map');

  // Single entry: the map must behave exactly like the old scalar, or every
  // existing project would shift in time.
  assert(bpmAt(d, 0) === 120 && bpmAt(d, 99999) === 120, 'a one-entry map holds its tempo everywhere');
  assert(Math.abs(tickToSeconds(d, 96) - 0.5) < 1e-12, '96 ticks = one beat = 0.5 s at 120 BPM');
  assert(Math.abs(secondsToTick(d, 0.5) - 96) < 1e-9, 'seconds convert back to ticks');

  // Multi-entry: 120 BPM for the first bar, then 240. The second half must
  // take half as long - this is the whole reason the map exists.
  const m = createProject({ name: 'multi', mode: 'poly' });
  setTempo(m, 240, 384);
  assert(m.song.tempo.length === 2, 'a second tempo entry is added');
  assert(bpmAt(m, 0) === 120 && bpmAt(m, 383) === 120 && bpmAt(m, 384) === 240, 'tempo lookup is tick-indexed');
  const firstBar = tickToSeconds(m, 384);
  const twoBars = tickToSeconds(m, 768);
  assert(Math.abs(firstBar - 2) < 1e-9, 'bar 1 at 120 BPM takes 2 s');
  assert(Math.abs(twoBars - 3) < 1e-9, 'bar 2 at 240 BPM adds only 1 s');
  assert(Math.abs(secondsToTick(m, twoBars) - 768) < 1e-6, 'the inverse survives a tempo change');
  assert(Math.abs(secondsToTick(m, 2.5) - 576) < 1e-6, 'the inverse lands inside the second segment');

  // Meter map
  setTimeSig(m, 3, 4, 768);
  assert(timeSigAt(m, 0).num === 4 && timeSigAt(m, 768).num === 3, 'meter lookup is tick-indexed');
  assert(ticksPerBar(m, 0) === 384 && ticksPerBar(m, 768) === 288, 'bar length follows the meter map');
  assert(ticksPerBeat(m) === 96, 'the no-tick call still means the song opening');

  // Entries stay sorted however they arrive, so lookups can scan forward.
  const s2 = createProject({ name: 'sorted', mode: 'poly' });
  setTempo(s2, 200, 960);
  setTempo(s2, 150, 480);
  assert(s2.song.tempo.map((e) => e.tick).join(',') === '0,480,960', 'tempo entries stay sorted');
  setTempo(s2, 155, 480);
  assert(s2.song.tempo.length === 3 && bpmAt(s2, 480) === 155, 'writing an existing tick replaces it');

  // Legacy mirrors: OUTPUT ONLY, so the previously shipped build can still
  // open a v4 file. Nothing in this build may read them.
  assert(d.song.bpm === 120 && d.song.timeSig.den === 4, 'legacy scalars mirror the map');
  setTempo(d, 90);
  assert(d.song.bpm === 90, 'the mirror follows a tempo edit');
  d.song.bpm = 999; // a stale mirror must never win
  syncLegacyFields(d);
  assert(d.song.bpm === 90, 'the map is authoritative - the mirror is recomputed');

  // v3 -> v4
  const v3 = createProject({ name: 'old', mode: 'mono' });
  v3.version = 3;
  delete v3.song.tempo;
  delete v3.song.meter;
  v3.song.bpm = 140;
  v3.song.timeSig = { num: 6, den: 8 };
  const up = migrate(v3);
  assert(up.version === 4, 'v3 -> v4 bumps the version');
  eq(up.song.tempo, [{ tick: 0, bpm: 140 }], 'the scalar bpm becomes a one-entry map');
  eq(up.song.meter, [{ tick: 0, num: 6, den: 8 }], 'the scalar timeSig becomes a one-entry map');
  assert(up.song.bpm === 140 && up.song.timeSig.den === 8, 'the mirrors survive the migration');
  assert(migrate(JSON.parse(JSON.stringify(up))).song.tempo.length === 1, 'migrating a v4 file is idempotent');

  // ---- doc.uses ----
  const plain = createProject({ name: 'plain', mode: 'mono' });
  normalizeDoc(plain);
  eq(plain.uses, [], 'a plain project declares no features');

  const withArp = createProject({ name: 'arp', mode: 'mono' });
  addNote(withArp, withArp.tracks[0].id, createNote({
    pitch: 60, startTick: 0, durationTicks: 96,
    harmonics: { mode: 'arp', stepsPerBeat: 2, pattern: 'up', octaves: 1, gate: 1, chordType: 'major' },
  }));
  normalizeDoc(withArp);
  eq(withArp.uses, ['harmonics'], 'a note with harmonics declares it');

  const withAuto = createProject({ name: 'auto', mode: 'poly' });
  withAuto.tracks[0].automation = { gain: [{ tick: 0, value: 0.5, curve: 'linear' }] };
  normalizeDoc(withAuto);
  eq(withAuto.uses, ['automation'], 'automation keyframes are declared');
  withAuto.tracks[0].automation = { gain: [] };
  normalizeDoc(withAuto);
  eq(withAuto.uses, [], 'an empty lane declares nothing');

  // A multi-entry tempo map is exactly the case an older build would get
  // WRONG rather than fail on - it would read the mirror and play one tempo
  // throughout - so it has to be declared.
  const multi = createProject({ name: 'multi-uses', mode: 'poly' });
  setTempo(multi, 200, 384);
  normalizeDoc(multi);
  assert(multi.uses.includes('tempoMap'), 'a multi-entry tempo map is declared');
  setTimeSig(multi, 3, 4, 384);
  normalizeDoc(multi);
  assert(multi.uses.includes('meterMap'), 'a multi-entry meter map is declared');

  // A declaration this build cannot evaluate must survive a load/save cycle.
  // Recomputing doc.uses from scratch would strip it - which is the very
  // data loss the field exists to prevent.
  const fromFuture = createProject({ name: 'future', mode: 'poly' });
  fromFuture.uses = ['granular@1', 'wavetable@2'];
  normalizeDoc(fromFuture);
  assert(fromFuture.uses.includes('granular@1'), 'an unknown declaration is carried over');
  assert(fromFuture.uses.includes('wavetable@2'), 'every unknown declaration is carried over');
  normalizeDoc(fromFuture);
  assert(fromFuture.uses.filter((u) => u === 'granular@1').length === 1, 'carrying over does not duplicate');
  // ...but a KNOWN feature that is no longer present is dropped, because we
  // can actually check that one.
  fromFuture.uses.push('harmonics');
  normalizeDoc(fromFuture);
  assert(!fromFuture.uses.includes('harmonics'), 'a known-but-absent feature is recomputed away');

  // A file from a FUTURE build must open, not be refused. Throwing here made
  // rules 2 and 3 unreachable: the document never got far enough for its
  // unknown blocks to be preserved or for doc.uses to explain itself.
  const future = createProject({ name: 'from the future', mode: 'poly' });
  future.version = 99;
  future.someV99Block = { kind: 'timewarp', v: 1 };
  const opened = migrate(JSON.parse(JSON.stringify(future)));
  assert(opened.version === 99, 'a newer file keeps its own version - we did not upgrade it');
  assert(!!opened.someV99Block, 'a newer file keeps its unknown blocks');
  assert(unsupportedFeatures(opened).includes('schema@99'), 'the schema level itself is reported');
  assert(bpmAt(opened, 0) === 120, 'a newer file is still playable');

  // The mirrors earn their keep in this direction too: a future version that
  // restructured song.tempo must still yield a usable tempo instead of
  // crashing on an undefined map.
  const restructured = { song: { bpm: 175, timeSig: { num: 7, den: 8 } }, ppq: PPQ };
  assert(bpmAt(restructured, 0) === 175, 'a missing tempo map falls back to the legacy scalar');
  assert(timeSigAt(restructured, 0).den === 8, 'a missing meter map falls back too');
  assert(Math.abs(tickToSeconds(restructured, 96) - 60 / 175) < 1e-12, 'the fallback drives tick->time');

  eq(unsupportedFeatures({ uses: [] }), [], 'nothing declared, nothing unsupported');
  eq(unsupportedFeatures({ uses: ['harmonics', 'automation'] }), [], 'known features are supported');
  eq(unsupportedFeatures({ uses: ['granular@1'] }), ['granular@1'], 'an unknown feature is reported');
  eq(unsupportedFeatures({ uses: ['effects@1'] }), [], 'effects are supported as of this build');
  eq(unsupportedFeatures({ uses: ['effects@2'] }), ['effects@2'], 'but a newer major of them is not');
  eq(unsupportedFeatures({ uses: ['harmonics@9'] }), ['harmonics@9'], 'a known feature at a newer major is reported');
  eq(unsupportedFeatures({ uses: ['harmonics@1'] }), [], 'an explicit supported major is fine');
}

// ---- level display units ----
{
  const { toPercent, fromPercent, formatPercent, formatSeconds, formatRaw, isHot, formatter, HOT_ABOVE }
    = await import('../js/core/units.js');
  const { AUTOMATION_PARAMS } = await import('../js/core/automation.js');

  assert(formatPercent(0) === '0%', 'silence reads as 0%');
  assert(formatPercent(1) === '100%', 'unity reads as 100%');
  assert(formatPercent(0.35) === '35%', 'the default Square gain reads as 35%');
  assert(formatPercent(1.5) === '150%', 'boost above unity is displayable');

  // The display layer must never round-trip a value into a different one -
  // a slider drag would otherwise walk a level away from where it was left.
  let stable = true;
  for (let p = 0; p <= 150; p++) if (Math.round(toPercent(fromPercent(p))) !== p) stable = false;
  assert(stable, 'percent -> linear -> percent is stable across the range');

  // Unity is the boundary, not a hot value: 100% must not be flagged.
  assert(isHot(HOT_ABOVE) === false, 'exactly unity is not hot');
  assert(isHot(1.0000000001) === false, 'float noise at unity is not hot');
  assert(isHot(1.01) === true, 'above unity is hot');
  assert(isHot(0.5) === false, 'below unity is not hot');

  assert(formatSeconds(0.002) === '2 ms', 'short times read in ms');
  assert(formatSeconds(0.25) === '0.25 s', 'longer times read in seconds');
  assert(formatter('percent') === formatPercent, 'formatter resolves by name');
  assert(formatter('nope') === formatRaw, 'an unknown display name degrades to raw');

  // The params table declares a display name; fmt is derived from it, so the
  // two can never disagree the way a hand-written pair could.
  for (const [name, meta] of Object.entries(AUTOMATION_PARAMS)) {
    assert(typeof meta.fmt === 'function', `${name} has a derived formatter`);
    assert(meta.fmt === formatter(meta.display), `${name} fmt matches its display descriptor`);
  }
  assert(AUTOMATION_PARAMS.gain.fmt(1) === '100%', 'gain lane reads in percent');
  assert(AUTOMATION_PARAMS.attack.fmt(0.05) === '50 ms', 'time lanes read in ms');
  // Gain reaches past unity so a quiet track can be pushed; the master
  // limiter is what makes that safe rather than a clipping hazard.
  assert(AUTOMATION_PARAMS.gain.max > HOT_ABOVE, 'the gain lane allows boost above unity');
  assert(AUTOMATION_PARAMS.gain.hot === true, 'the gain lane is marked as flaggable');
  assert(!AUTOMATION_PARAMS.duty.hot, 'duty is not a level and is never flagged');
}

// ---- .cbt: the tune a badge stores ----
{
  const {
    buildTune, parseTune, noteAt, crc32, tuneIdHex, NONE,
    HEADER_BYTES, TRACK_BYTES, NOTE_BYTES, FLAG_LOOP,
  } = await import('../js/core/badge-tune.js');
  const { badgeScore, REST } = await import('../js/core/badge-score.js');
  const { exportHeader } = await import('../js/core/export-h.js');
  const { migrate } = await import('../js/core/doc.js');
  const { readFile } = await import('node:fs/promises');

  const loadDemo = async (file) =>
    migrate(JSON.parse(await readFile(new URL(`../demos/${file}`, import.meta.url), 'utf8')));

  // CRC-32 against the check value every implementation publishes, so the
  // badge's table-driven C version has something to agree with.
  assert(crc32(new TextEncoder().encode('123456789')) === 0xcbf43926, 'CRC-32 check value');
  assert(crc32(new Uint8Array(0)) === 0, 'CRC-32 of nothing is 0');
  assert(tuneIdHex(0x0000beef) === '0000beef', 'tune ids are eight hex digits');

  // Round trip: what the writer emits is what the documented reader sees.
  {
    const doc = await loadDemo('poly.chipseq.json');
    const built = buildTune(doc, { name: 'Round Trip', loop: true });
    const back = parseTune(built.bytes);
    assert(back.name === 'Round Trip', 'the name survives');
    assert(back.loop === true && (back.flags & FLAG_LOOP) !== 0, 'the loop flag survives');
    assert(back.id === built.id, 'the parsed id is the built id');
    assert(back.tracks.length === doc.tracks.length, 'every track is present');
    eq(back.tracks.map((t) => t.notes.length), built.tracks.map((t) => t.notes), 'note counts match');
    eq(back.tracks.map((t) => t.name), doc.tracks.map((t) => t.name), 'track names survive');
    assert(back.totalMs === built.totalMs && back.totalMs > 0, 'the length survives');

    // Every note, not just the counts - this is the payload.
    doc.tracks.forEach((t, i) => {
      const want = badgeScore(doc, t.id, { includeRests: false })
        .map((n) => [n.startMs, n.durMs, n.pitch]);
      const got = back.tracks[i].notes.map((n) => [n.startMs, n.durMs, n.pitch]);
      eq(got, want, `track ${i} round-trips note for note`);
    });
  }

  // Damage is detected rather than played. A half-written tune in a library
  // is worse than no tune.
  {
    const doc = await loadDemo('mono.chipseq.json');
    const bad = buildTune(doc).bytes.slice();
    bad[bad.length - 2] ^= 0xff; // flip a pitch
    let threw = null;
    try { parseTune(bad); } catch (e) { threw = e.message; }
    assert(threw && /crc/i.test(threw), 'a flipped byte fails the CRC');
  }

  // Structure: everything castable, everything aligned. The firmware reads
  // this file by pointing structs at it, so an unaligned pool is not a
  // cosmetic issue.
  for (const file of ['mono.chipseq.json', 'poly.chipseq.json']) {
    const doc = await loadDemo(file);
    for (const name of ['', 'x', 'a name of quite ordinary length', 'ü'.repeat(40)]) {
      const built = buildTune(doc, { name });
      const view = new DataView(built.bytes.buffer);
      const poolOffset = view.getUint32(24, true);
      assert(poolOffset % 4 === 0, `${file}/${name.length}: note pool is 4-byte aligned`);
      assert(poolOffset === HEADER_BYTES + doc.tracks.length * TRACK_BYTES,
        `${file}/${name.length}: pool starts right after the track table`);
      assert((built.bytes.length - poolOffset) % NOTE_BYTES === 0,
        `${file}/${name.length}: the pool is a whole number of notes`);
      // An over-long name is truncated on a codepoint boundary, so the badge
      // renders a short name rather than a replacement character.
      assert(!parseTune(built.bytes).name.includes('�'),
        `${file}/${name.length}: truncation does not split a codepoint`);
    }
  }

  // The invariant: .cbt and .h describe the same music. .h chains durations
  // and includes rests; .cbt stores absolute starts and omits them. The two
  // agree exactly when each .cbt startMs equals the running sum of the .h
  // durations before it.
  for (const file of ['mono.chipseq.json', 'rickroll.chipseq.json']) {
    const doc = await loadDemo(file);
    const built = buildTune(doc, { trackIds: [doc.melodyTrackId] });
    const notes = parseTune(built.bytes).tracks[0].notes;

    const entries = [];
    for (const line of exportHeader(doc).text.split('\n')) {
      for (const m of line.matchAll(/\{(NOTE_[A-Z0-9]+|NOTE_REST)\s*,\s*(-?\d+)\}/g)) {
        entries.push({ symbol: m[1], ms: Number(m[2]) });
      }
    }
    // .h trims leading silence for a standalone file; .cbt keeps the song's
    // own origin. Rebase by the lead so the two are measured from one place.
    const score = badgeScore(doc, doc.melodyTrackId, { includeRests: false });
    const lead = score.length ? score[0].startMs : 0;

    const want = [];
    let at = 0;
    for (const e of entries) {
      if (e.symbol !== 'NOTE_REST') want.push([at, e.ms]);
      at += e.ms;
    }
    eq(notes.map((n) => [n.startMs - lead, n.durMs]), want,
      `${file}: .cbt starts are the running sum of the .h durations`);
    assert(notes.length > 20, `${file}: and it is a real tune`);
  }

  // ---- noteAt: the whole player ----
  {
    const notes = [
      { startMs: 100, durMs: 200, pitch: 60 }, // 100..300
      { startMs: 300, durMs: 100, pitch: 60 }, // 300..400, same pitch, adjacent
      { startMs: 900, durMs: 100, pitch: 64 }, // 900..1000, after a gap
    ];
    assert(noteAt(notes, 0) === NONE, 'silence before the first note');
    assert(noteAt(notes, 99) === NONE, 'still silent one ms before');
    assert(noteAt(notes, 100) === 0, 'the onset is inclusive');
    assert(noteAt(notes, 299) === 0, 'the last millisecond still sounds');
    assert(noteAt(notes, 300) === 1, 'the end is exclusive, so the next note owns it');
    assert(noteAt(notes, 400) === NONE, 'silence in the gap');
    assert(noteAt(notes, 899) === NONE, 'right up to the next onset');
    assert(noteAt(notes, 900) === 2, 'and then the next note');
    assert(noteAt(notes, 1000) === NONE, 'silence past the end');
    assert(noteAt(notes, 1e9) === NONE, 'and long past it');
    assert(noteAt([], 0) === NONE, 'an empty track is silent');

    // Adjacent identical pitches are DIFFERENT indices, which is what makes
    // the player re-articulate them instead of slurring them into one.
    assert(noteAt(notes, 299) !== noteAt(notes, 300), 'adjacent same-pitch notes are distinct');
  }

  // ---- resync: the guarantees the mesh design rests on ----
  //
  // Correction is applied by assigning a new t0 and nothing else. These are
  // the three claims that makes, tested against a real tune.
  {
    const doc = await loadDemo('rickroll.chipseq.json');
    const notes = parseTune(buildTune(doc, { trackIds: [doc.melodyTrackId] }).bytes).tracks[0].notes;
    const end = notes[notes.length - 1].startMs + notes[notes.length - 1].durMs;
    const STEP = 2; // the player's evaluation interval

    // (1) A correction the sounding note can absorb does not retrigger it.
    //     The note is truncated or prolonged instead - which is only possible
    //     because identity is the pool index, not a reconstructed cursor.
    {
      let checked = 0;
      let retriggered = 0;
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        for (const at of [n.startMs, n.startMs + Math.floor(n.durMs / 2), n.startMs + n.durMs - 1]) {
          for (const delta of [-20, -5, -1, 1, 5, 20]) {
            const after = noteAt(notes, at + delta);
            // Only meaningful where the correction stays inside the note.
            if (at + delta < n.startMs || at + delta >= n.startMs + n.durMs) continue;
            checked++;
            if (after !== i) retriggered++;
          }
        }
      }
      assert(checked > 500, 'the absorption case is actually exercised');
      assert(retriggered === 0, 'a correction absorbed by the sounding note does not retrigger it');
    }

    // (2) Correcting BACKWARD - a badge that ran ahead - never swallows a
    //     note. Every onset from the corrected position onward still plays.
    {
      let swallowed = 0;
      for (let i = 1; i < notes.length; i++) {
        const before = notes[i].startMs; // about to start note i
        for (const back of [1, 10, 120, 700]) {
          // After the correction the badge is earlier in the song, so note i
          // must still be ahead of it and therefore still reachable.
          const pos = before - back;
          const next = notes.findIndex((n) => n.startMs >= pos);
          if (next > i) swallowed++;
        }
      }
      assert(swallowed === 0, 'correcting backward never skips a pending onset');
    }

    // (3) The anti-accumulation property - the reason the format stores
    //     absolute starts at all. Run the derived player and the tempting
    //     "sound a note, wait durMs, advance" player over the SAME stalling
    //     clock, and compare. This is the whole argument, measured.
    {
      // A wall clock with a 137 ms stall every second: during a stall the
      // loop simply does not run, exactly as a flash write or a watchdog
      // would look from inside the player.
      const STALL_MS = 137;
      const ticks = [];
      const blind = []; // [from, to) song time nobody observed
      for (let wall = 0, next = 1000; wall <= end; wall += STEP) {
        if (wall >= next) { blind.push([wall, wall + STALL_MS]); wall += STALL_MS; next += 1000; }
        ticks.push(wall);
      }
      assert(blind.length > 20, 'the run is long enough for accumulation to show');
      const inBlind = (from, to) => blind.some(([a, b]) => from < b && to > a);

      // Derived: position is a pure function of the clock.
      let sounding = NONE;
      const derivedOnset = new Map(); // note index -> wall time it started
      for (const wall of ticks) {
        const i = noteAt(notes, wall);
        if (i !== sounding) {
          if (i !== NONE && !derivedOnset.has(i)) derivedOnset.set(i, wall);
          sounding = i;
        }
      }

      // A stall genuinely loses whatever fell inside it - that is the cost of
      // the stall, not of the player. What must be true is that NOTHING ELSE
      // is lost, and that the loss does not propagate past the stall.
      const missed = [];
      for (let i = 0; i < notes.length; i++) if (!derivedOnset.has(i)) missed.push(i);
      const unexplained = missed.filter(
        (i) => !inBlind(notes[i].startMs, notes[i].startMs + notes[i].durMs)
      );
      eq(unexplained, [], 'the derived player loses only notes that fell inside a stall');
      assert(derivedOnset.size > notes.length * 0.85,
        `and keeps the rest (${derivedOnset.size}/${notes.length})`);

      let worst = 0;
      for (const [i, wall] of derivedOnset) worst = Math.max(worst, wall - notes[i].startMs);
      assert(worst <= STEP + STALL_MS,
        `derived onset error stays bounded by one stall (worst ${worst} ms)`);

      // Accumulating: the .h player. It walks a list that includes rests,
      // advancing when the current entry's duration has elapsed since it
      // actually began - so every stall is added to the total, permanently.
      const withRests = badgeScore(doc, doc.melodyTrackId, { includeRests: true });
      let k = 0;
      let dueAt = withRests[0].startMs;
      const naiveStart = new Map();
      for (const wall of ticks) {
        if (wall >= dueAt && k < withRests.length) {
          naiveStart.set(k, wall);
          dueAt = wall + withRests[k].durMs;
          k++;
        }
      }
      const lateAt = (j) => naiveStart.get(j) - withRests[j].startMs;
      const lastK = k - 1;
      const naiveLate = lateAt(lastK);
      const midLate = lateAt(Math.floor(lastK / 2));

      // The defining property of an accumulating player: its error GROWS. The
      // derived player's is bounded by one stall no matter how long the song.
      assert(midLate > STALL_MS && naiveLate > midLate * 1.5,
        `an accumulating player falls further behind as it goes (${Math.round(midLate)} -> ${Math.round(naiveLate)} ms)`);
      assert(naiveLate > worst * 10,
        `and ends an order of magnitude worse than derived (${Math.round(naiveLate)} vs ${worst} ms)`);
    }
  }

  // tools/fake-badge.mjs implements CRC-32 and the header read separately, on
  // purpose: it is a specification artifact a firmware author reads on its
  // own, and following an import into the sequencer to see how an upload is
  // verified would make it worth less. The duplication is only safe because
  // this asserts the two agree - the same arrangement the clock maths uses.
  {
    const fake = await import('../tools/fake-badge.mjs');
    const doc = await loadDemo('poly.chipseq.json');
    const built = buildTune(doc, { name: 'agreement' });

    assert(fake.crc32(new TextEncoder().encode('123456789')) === 0xcbf43926,
      'the fake badge agrees on the CRC-32 check value');
    for (const file of ['mono.chipseq.json', 'tetris.chipseq.json']) {
      const d = await loadDemo(file);
      const t = buildTune(d);
      assert(fake.crc32(t.bytes, 12) === crc32(t.bytes, 12),
        `${file}: badge and sequencer compute the same CRC over a real tune`);
    }

    const head = fake.readTuneHeader(built.bytes);
    const mine = parseTune(built.bytes);
    assert(head.crc === mine.crc, 'the badge reads the same id out of the header');
    assert(head.tracks === mine.tracks.length, 'and the same track count');
    assert(head.totalMs === mine.totalMs, 'and the same length');
    assert(head.name === mine.name, 'and the same name');
  }

  // Mono and poly are one code path with a filter, not two formats.
  {
    const doc = await loadDemo('poly.chipseq.json');
    const one = buildTune(doc, { trackIds: [doc.tracks[0].id] });
    assert(parseTune(one.bytes).tracks.length === 1, 'a mono tune has one track');
    const all = buildTune(doc);
    assert(parseTune(all.bytes).tracks.length === doc.tracks.length, 'and poly has all of them');
    eq(parseTune(one.bytes).tracks[0].notes, parseTune(all.bytes).tracks[0].notes,
      'the shared track is byte-identical either way');
    assert(one.id !== all.id, 'but they are different tunes with different ids');
  }
}

// ---- uploading a tune: the window, the resends, the commit ----
//
// The whole point of keeping this out of the card is that it can be driven
// here with no socket and no clock.
{
  const { createUpload, splitChunks, toBase64, WINDOW, ACK_TIMEOUT_MS } =
    await import('../js/net/badge-upload.js');

  // A fake wire: collects what was sent, and lets the test decide when the
  // badge answers and when time passes.
  function rig(bytes, { chunkSize } = {}) {
    const sent = [];
    let clock = 0;
    let ticker = null;
    const up = createUpload({
      send: (m) => sent.push(m),
      badgeId: 'b1',
      tune: { bytes, id: 'deadbeef', name: 'T', tracks: 1 },
      now: () => clock,
      setTimer: (fn) => { ticker = fn; return 1; },
      clearTimer: () => { ticker = null; },
    });
    return {
      up, sent,
      advance: (ms) => { clock += ms; if (ticker) ticker(); },
      ack: (seq) => up.handle({ t: 'put_ack', badge: 'b1', id: 'deadbeef', seq }),
      done: (msg) => up.handle({ t: 'put_done', badge: 'b1', id: 'deadbeef', ...msg }),
      data: () => sent.filter((m) => m.t === 'put_data'),
    };
  }

  const bytes = new Uint8Array(5000).map((_, i) => i & 0xff);
  assert(splitChunks(bytes).length === 5, '5000 bytes is 5 chunks of 1024');
  assert(atob(toBase64(bytes)).length === 5000, 'base64 round-trips a large array');
  // The chunked encoder exists because one call would blow the argument limit.
  assert(toBase64(new Uint8Array(200000)).length > 0, 'and a 200 kB array does not overflow the stack');

  // The window: only WINDOW chunks go out before anything is acknowledged.
  {
    const r = rig(bytes);
    const p = r.up.start();
    p.catch(() => {}); // settled below; not awaited here
    assert(r.sent[0].t === 'put', 'the transfer is announced first');
    eq(r.sent[0].bytes, 5000, 'with the real size');
    assert(r.data().length === WINDOW, `only ${WINDOW} chunks are in flight at once`);

    r.ack(0);
    assert(r.data().length === WINDOW + 1, 'an ack releases exactly one more');
    for (const s of [1, 2, 3, 4]) r.ack(s);
    assert(r.sent.some((m) => m.t === 'put_end'), 'and the commit follows the last ack');
    assert(r.sent.filter((m) => m.t === 'put_end').length === 1, 'exactly once');

    r.done({ ok: true, crc: 'deadbeef', bytes: 5000 });
    const res = await p;
    assert(res.ok && res.crc === 'deadbeef', 'a committed upload resolves with the badge CRC');
  }
}
{
  const { createUpload, ACK_TIMEOUT_MS } = await import('../js/net/badge-upload.js');
  const bytes = new Uint8Array(3000);

  function rig() {
    const sent = [];
    let clock = 0;
    let ticker = null;
    const up = createUpload({
      send: (m) => sent.push(m),
      badgeId: 'b1',
      tune: { bytes, id: 'cafe0001', name: 'T', tracks: 1 },
      now: () => clock,
      setTimer: (fn) => { ticker = fn; return 1; },
      clearTimer: () => { ticker = null; },
    });
    return {
      up, sent,
      advance: (ms) => { clock += ms; if (ticker) ticker(); },
      data: () => sent.filter((m) => m.t === 'put_data'),
    };
  }

  // A chunk nobody acknowledged is re-sent. Over a relay this is not
  // hypothetical, and the badge is required to treat the repeat as idempotent.
  {
    const r = rig();
    r.up.start().catch(() => {});
    const before = r.data().length;
    r.advance(ACK_TIMEOUT_MS - 1);
    eq(r.data().length, before, 'nothing is re-sent before the timeout');
    r.advance(2);
    assert(r.data().length > before, 'an unacknowledged chunk is re-sent after it');
    const resent = r.data().slice(before);
    assert(resent.every((m) => m.seq < before), 'and it is the same seq, not a new one');
  }

  // Frames for another badge or another tune belong to another transfer.
  {
    const r = rig();
    r.up.start().catch(() => {});
    const before = r.data().length;
    r.up.handle({ t: 'put_ack', badge: 'someone-else', id: 'cafe0001', seq: 0 });
    r.up.handle({ t: 'put_ack', badge: 'b1', id: 'ffffffff', seq: 0 });
    eq(r.data().length, before, 'an ack for another transfer releases nothing');
    eq(r.up.state().acked, 0, 'and is not counted');
  }

  // A refusal rejects with the badge's reason, so the card can say why.
  {
    const r = rig();
    const p = r.up.start();
    r.up.handle({ t: 'put_done', badge: 'b1', id: 'cafe0001', ok: false, reason: 'space' });
    let rejected = null;
    try {
      await p;
      assert(false, 'a refused upload must not resolve');
    } catch (err) {
      rejected = err;
    }
    eq(rejected && rejected.reason, 'space', 'a refusal rejects with the badge reason');
    const after = r.sent.length;
    r.advance(10000);
    eq(r.sent.length, after, 'and nothing is sent after it settles');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
