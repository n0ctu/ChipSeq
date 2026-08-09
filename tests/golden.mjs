// Golden-file regression net for the pipeline and the text exporters.
//
// Everything downstream of flattenSong is the reason this app exists: the
// badge, the Flipper and the preview must agree. These fixtures make that a
// property the suite defends on every run instead of something verified once
// by hand.
//
//   node tests/golden.mjs             check
//   node tests/golden.mjs --update    regenerate after a DELIBERATE change
//
// Rendered audio is deliberately NOT compared here. WaveShaper oversampling
// and resampling details differ between Chromium builds, so byte-comparing a
// WAV would produce false alarms rather than catching regressions - the
// browser suites assert peak/RMS/duration on the rendered buffer instead.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate, createProject, normalizeDoc } from '../js/core/doc.js';
import { flattenSong } from '../js/core/flatten.js';
import { exportHeader } from '../js/core/export-h.js';
import { exportFmf } from '../js/core/export-fmf.js';
import { buildTune, parseTune, HEADER_BYTES, TRACK_BYTES, NOTE_BYTES } from '../js/core/badge-tune.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = join(ROOT, 'tests', 'fixtures', 'golden');
const UPDATE = process.argv.includes('--update');

// Above this, a golden stores a hash plus head/tail context instead of the
// full artifact - Bad Apple's document alone is 700 kB, and checking that
// into the repo five times over would dwarf the source it guards.
const MAX_INLINE = 32 * 1024;

let pass = 0, fail = 0, wrote = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('FAIL:', msg); }
}

// ---- golden comparison ----

function digestOf(text) {
  const sha = createHash('sha256').update(text).digest('hex');
  const oneLine = (s) => JSON.stringify(s).slice(1, -1);
  return [
    '# chipseq-golden digest v1',
    `# artifact exceeds ${MAX_INLINE} bytes - compared by hash, head/tail for context`,
    `bytes:  ${text.length}`,
    `sha256: ${sha}`,
    `head:   ${oneLine(text.slice(0, 300))}`,
    `tail:   ${oneLine(text.slice(-300))}`,
    '',
  ].join('\n');
}

// Report the first difference by line, so a broken golden says WHAT moved
// rather than just that something did.
function firstDiff(actual, expected) {
  const a = actual.split('\n'), b = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n     got: ${JSON.stringify(a[i] ?? '<eof>')}\n    want: ${JSON.stringify(b[i] ?? '<eof>')}`;
    }
  }
  return 'trailing whitespace only';
}

function compare(name, text) {
  const path = join(GOLDEN_DIR, name);
  const stored = text.length > MAX_INLINE ? digestOf(text) : text;

  if (UPDATE) {
    mkdirSync(dirname(path), { recursive: true });
    const changed = !existsSync(path) || readFileSync(path, 'utf8') !== stored;
    if (changed) { writeFileSync(path, stored); wrote++; console.log('  updated', name); }
    pass++;
    return;
  }
  if (!existsSync(path)) {
    fail++;
    console.log(`FAIL: no golden for ${name} - run: node tests/golden.mjs --update`);
    return;
  }
  const expected = readFileSync(path, 'utf8');
  if (stored === expected) { pass++; return; }
  fail++;
  console.log(`FAIL: ${name} differs from its golden\n    ${firstDiff(stored, expected)}`);
}

// ---- canonical serialization ----

// gainCurve arrives as a Float32Array; JSON.stringify would spell it out as
// {"0":…,"1":…} and float noise would make the golden brittle, so typed
// arrays become plain arrays rounded well below audible resolution.
function canonical(value) {
  return JSON.stringify(value, (_k, v) => {
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      return { f32: Array.from(v, (n) => Number(n.toFixed(6))) };
    }
    return v;
  }, 1) + '\n';
}

// ---- .cbt, rendered as text ----
//
// The tune a badge stores is binary, and the golden machinery compares text.
// A hex dump would catch a change but not explain it, so the decoded header
// and track table come first and the bytes follow. A diff then says "the
// note pool moved" rather than "byte 64 differs".
//
// Firmware reads this file by casting structs at it, so the layout is as much
// the contract as the notes are - which is why the offsets are asserted here
// rather than only in the unit tests.
function cbtDump(bytes) {
  const t = parseTune(bytes);
  const lines = [
    `# chipseq .cbt v${t.fmtVersion}`,
    `bytes:          ${bytes.length}`,
    `id:             ${t.id}`,
    `name:           ${JSON.stringify(t.name)}`,
    `flags:          0x${t.flags.toString(16).padStart(2, '0')} (loop=${t.loop})`,
    `totalMs:        ${t.totalMs}`,
    `loop:           ${t.loopStartMs}..${t.loopEndMs}`,
    `bpmHint:        ${t.bpmHint}`,
    `notePoolOffset: ${HEADER_BYTES + t.tracks.length * TRACK_BYTES}`,
    '',
  ];
  t.tracks.forEach((track, i) => {
    lines.push(`track ${i}: ${JSON.stringify(track.name)} notes=${track.notes.length} lengthMs=${track.lengthMs}`);
  });
  lines.push('');
  for (let i = 0; i < bytes.length; i += 16) {
    const row = [...bytes.subarray(i, i + 16)].map((b) => b.toString(16).padStart(2, '0'));
    lines.push(`${i.toString(16).padStart(6, '0')}  ${row.join(' ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---- the shipped demos ----

const demoFiles = JSON.parse(readFileSync(join(ROOT, 'demos', 'index.json'), 'utf8'));

for (const file of demoFiles) {
  const base = file.replace(/\.chipseq\.json$/, '');
  const doc = migrate(JSON.parse(readFileSync(join(ROOT, 'demos', file), 'utf8')));

  // The migrated document: guards migrations and the "unknown keys survive"
  // rule against every demo we ship, including the v2 file among them.
  compare(`${base}.chipseq.json`, JSON.stringify(doc, null, 2) + '\n');

  // The flattened event stream: the single source every exporter and the
  // engine consume, so this catches pipeline drift before any exporter does.
  const { events, warnings } = flattenSong(doc);
  compare(`${base}.events.json`, canonical({ warnings, events }));

  // .h and .fmf are mono-only by construction (the UI gates them on mode).
  if (doc.mode === 'mono') {
    compare(`${base}.h`, exportHeader(doc).text);
    compare(`${base}.fmf`, exportFmf(doc).text);
  }

  // The tune a badge stores, for every demo regardless of mode: mono is the
  // one-track case of the same format, not a different one.
  const tune = buildTune(doc, { name: base });
  compare(`${base}.cbt.txt`, cbtDump(tune.bytes));

  // Structural invariants the firmware casts structs against. Cheap to check
  // here, and a change to any of them is a change the badge team must be told
  // about rather than one that ships quietly.
  const view = new DataView(tune.bytes.buffer);
  const poolOffset = view.getUint32(24, true);
  assert(poolOffset % 4 === 0, `${base}: .cbt note pool is 4-byte aligned`);
  assert(poolOffset === HEADER_BYTES + doc.tracks.length * TRACK_BYTES,
    `${base}: .cbt pool follows the track table`);
  assert((tune.bytes.length - poolOffset) % NOTE_BYTES === 0,
    `${base}: .cbt pool is a whole number of notes`);
}

// ---- determinism ----

// Random-pattern arps are seeded from the note id so that playback, ghost
// notes and exports can never disagree. Fixed ids here keep the fixture
// stable across runs as well as within one.
function seededDoc() {
  const doc = createProject({ name: 'Golden seed', mode: 'poly' });
  doc.id = 'golden-seed';
  doc.createdAt = doc.updatedAt = '2020-01-01T00:00:00.000Z';
  const track = doc.tracks[0];
  track.id = 'golden-track';
  doc.activeTrackId = doc.melodyTrackId = 'golden-track';
  track.notes = [0, 1, 2, 3].map((i) => ({
    id: `golden-note-${i}`,
    pitch: 60 + i * 4,
    startTick: i * 384,
    durationTicks: 384,
    velocity: 100,
    harmonics: { mode: 'arp', stepsPerBeat: 4, pattern: 'random', octaves: 2, gate: 0.9, chordType: 'major' },
  }));
  return doc;
}

{
  const doc = seededDoc();
  const runs = [0, 1, 2].map(() => canonical(flattenSong(doc).events));
  assert(runs[0] === runs[1] && runs[1] === runs[2], 'flattening one document three times is identical');
  // A separate parse of the same document must agree too - otherwise the
  // seed would be leaking from object identity rather than the note id.
  const reparsed = migrate(JSON.parse(JSON.stringify(doc)));
  assert(canonical(flattenSong(reparsed).events) === runs[0], 'a reparsed copy flattens identically');
  compare('seeded-random-arp.events.json', runs[0]);
}

// ---- forward compatibility ----

// The rule: loading and re-saving a document never drops what this build did
// not understand. An older build must be able to open a newer file, edit it
// and save it without silently deleting the blocks it cannot read.
{
  const doc = createProject({ name: 'Future', mode: 'poly' });
  doc.id = 'future-doc';
  doc.createdAt = doc.updatedAt = '2020-01-01T00:00:00.000Z';
  doc.tracks[0].id = 'future-track';
  doc.activeTrackId = doc.melodyTrackId = 'future-track';

  // Blocks no build understands yet, in every place a feature might attach.
  doc.futureThing = { kind: 'warp', v: 1, params: { amount: 0.5 } };
  doc.master = { chain: [{ kind: 'delay', v: 1, params: { timeTicks: 48 } }] };
  doc.tracks[0].sends = [{ busId: 'space', level: 0.35 }];
  doc.tracks[0].notes = [{
    id: 'future-note',
    pitch: 60, startTick: 0, durationTicks: 96, velocity: 100, harmonics: null,
    mods: { someFutureMod: { kind: 'vibrato', v: 2, rate: 5 } },
  }];

  // Normalize first so the fixture is already in the canonical state migrate()
  // would put it in. Otherwise this would be testing that migrate adds no
  // defaults, when the property that actually matters is narrower and more
  // important: it must not DROP anything.
  normalizeDoc(doc);

  const before = JSON.stringify(doc, null, 2);
  const reloaded = migrate(JSON.parse(before));
  const after = JSON.stringify(reloaded, null, 2);
  assert(after === before, 'a document with unknown blocks round-trips unchanged');
  // Named separately, so a failure says WHICH block was lost rather than
  // just that two long strings differ.
  assert(JSON.stringify(reloaded.futureThing) === JSON.stringify(doc.futureThing), 'unknown top-level block survives');
  assert(JSON.stringify(reloaded.tracks[0].sends) === JSON.stringify(doc.tracks[0].sends), 'unknown track field survives');
  assert(JSON.stringify(reloaded.tracks[0].notes[0].mods) === JSON.stringify(doc.tracks[0].notes[0].mods), 'unknown note block survives');
  assert(JSON.stringify(reloaded.master) === JSON.stringify(doc.master), 'unknown master block survives');
  compare('forward-compat.chipseq.json', before + '\n');
}

// ---- summary ----

if (UPDATE) console.log(`\n${wrote} golden file(s) written`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
