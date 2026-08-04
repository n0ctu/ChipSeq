// Flipper Music Format (.fmf) exporter — RTTTL-style mono format used by the
// Flipper Zero Music Player. Notes are quantized to the representable
// durations (1..128 + dotted) with running-drift correction, rests become P.

import { flattenSong, clipEventsToRegion } from './flatten.js';
import { PITCH_SYMBOLS } from './music.js';

// den -> ticks at PPQ 96 (quarter = 96). Dotted = 1.5x where integral.
const DURATIONS = [];
for (const den of [1, 2, 4, 8, 16, 32, 64, 128]) {
  const ticks = (96 * 4) / den;
  DURATIONS.push({ den, dots: '', ticks });
  if (Number.isInteger(ticks * 1.5)) DURATIONS.push({ den, dots: '.', ticks: ticks * 1.5 });
}
DURATIONS.sort((a, b) => b.ticks - a.ticks);
const MAX_TICKS = DURATIONS[0].ticks; // dotted whole
const MIN_TICKS = DURATIONS[DURATIONS.length - 1].ticks;

// FMF note names: sharps only (PITCH_SYMBOLS uses CS/DS... map to C#/D#).
const FMF_NAMES = PITCH_SYMBOLS.map((s) => s.replace('S', '#'));

// Split a tick length into one or more duration tokens, minimizing error.
// carry (fractional ticks) rolls between calls so drift self-corrects.
function tokenize(ticks, state) {
  const tokens = [];
  let remaining = ticks + state.carry;
  state.carry = 0;
  while (remaining >= MIN_TICKS / 2) {
    let best = null;
    for (const d of DURATIONS) {
      const err = Math.abs(remaining - d.ticks);
      if (!best || err < best.err) best = { ...d, err };
    }
    // If the remainder is longer than the longest token, take the longest
    // and keep going (splits e.g. a double-whole into two tokens).
    if (remaining > MAX_TICKS * 1.25) best = { ...DURATIONS[0], err: 0 };
    tokens.push(best);
    remaining -= best.ticks;
    if (Math.abs(remaining) < MIN_TICKS / 2) break;
    if (remaining < 0) break;
  }
  state.carry = remaining;
  return tokens;
}

export function exportFmf(doc, opts = {}) {
  let { events, warnings: flatWarnings } = flattenSong(doc);
  const region = opts.region && opts.region.endTick > opts.region.startTick ? opts.region : null;
  if (region) events = clipEventsToRegion(events, region.startTick, region.endTick);

  const warnings = flatWarnings
    .filter((w) => w.type === 'overlap')
    .slice(0, 1)
    .map(() => 'Overlapping notes were truncated (fix conflicts for exact control).');

  const bpm = Math.round(doc.song.bpm);
  if (bpm !== doc.song.bpm) warnings.push(`BPM rounded from ${doc.song.bpm} to ${bpm} (FMF needs an integer BPM).`);

  // FMF assumes the file's PPQ-equivalent timing; our ticks are PPQ 96 too,
  // so durations translate directly. Build {kind, pitch?, den, dots} tokens.
  const state = { carry: 0 };
  const tokens = [];
  let tooShort = 0;
  let splitNotes = 0;
  let prevEndTick = region || !events.length ? 0 : events[0].startTick;

  const pushTokens = (ticks, pitch) => {
    if (ticks < MIN_TICKS / 2) {
      state.carry += ticks;
      if (pitch != null) tooShort++;
      return;
    }
    const parts = tokenize(ticks, state);
    if (pitch != null && parts.length > 1) splitNotes++;
    for (const p of parts) tokens.push({ pitch, den: p.den, dots: p.dots });
  };

  for (const ev of events) {
    if (ev.startTick > prevEndTick) pushTokens(ev.startTick - prevEndTick, null);
    pushTokens(ev.durationTicks, ev.pitch);
    prevEndTick = ev.startTick + ev.durationTicks;
  }
  if (region) {
    const regionTicks = region.endTick - region.startTick;
    if (regionTicks > prevEndTick) pushTokens(regionTicks - prevEndTick, null);
  }

  if (!tokens.length) throw new Error('Nothing to export — the song (or region) has no notes.');
  if (tooShort) warnings.push(`${tooShort} note(s) shorter than a 128th were merged into neighbors.`);
  if (splitNotes) warnings.push(`${splitNotes} long note(s) were split into re-attacked tokens (FMF has no ties).`);

  // Defaults = the most common plain denominator / octave (keeps the file
  // compact). Dots are always rendered on their token — the Duration header
  // cannot express them.
  const mode = (arr) => {
    const counts = new Map();
    for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const headerDen = mode(tokens.map((t) => t.den));
  const noteTokens = tokens.filter((t) => t.pitch != null);
  const defaultOctave = noteTokens.length ? mode(noteTokens.map((t) => Math.floor(t.pitch / 12) - 1)) : 5;

  const rendered = tokens.map((t) => {
    const denStr = t.den === headerDen ? '' : String(t.den);
    if (t.pitch == null) return `${denStr}P${t.dots}`;
    const octave = Math.floor(t.pitch / 12) - 1;
    const name = FMF_NAMES[t.pitch % 12];
    const octStr = octave === defaultOctave ? '' : String(octave);
    return `${denStr}${name}${octStr}${t.dots}`;
  });

  const octaves = noteTokens.map((t) => Math.floor(t.pitch / 12) - 1);
  if (octaves.some((o) => o < 0 || o > 8)) {
    warnings.push('Some notes fall outside octaves 0–8 — the Flipper buzzer may not play them.');
  }

  const text = [
    'Filetype: Flipper Music Format',
    'Version: 0',
    `BPM: ${bpm}`,
    `Duration: ${headerDen}`,
    `Octave: ${defaultOctave}`,
    'Notes: ' + rendered.join(', '),
    '',
  ].join('\n');

  return { text, warnings, tokenCount: tokens.length };
}
