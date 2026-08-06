// Polyphony normalization: keeping a thick arrangement from eating its own
// headroom, without taxing the thin parts.
//
// The problem it solves, measured rather than assumed: one voice at the
// default instrument gain peaks around 0.25, and voices sum linearly, so
// THREE simultaneous notes reach the limiter's knee. A polyphonic sequencer
// that distorts on the fourth note is mis-calibrated, and the shipped Tetris
// and Bad Apple demos were running about +5 dB into the limiter as a result.
//
// A single global "turn the song down" number was the obvious fix and the
// wrong one: it makes a sparse melody quiet for the sake of one dense bar
// somewhere else. So the scaling follows what is actually sounding, in two
// stages that answer two different questions:
//
//   track  how many voices does THIS track have right now? Normalizes a
//          chord against a single note within one instrument.
//   song   how many voices are sounding ANYWHERE right now? Normalizes the
//          whole arrangement against a solo passage.
//
// Both use N^-k. k is the dial:
//
//   k = 0    off - voices sum linearly (what the app did before)
//   k = 0.5  equal power - 4 voices are twice one voice, not four times.
//            The standard choice, and it keeps a chord feeling like a chord.
//   k = 1    constant sum - a chord is exactly as loud as a single note.
//            Very even, and it flattens the arrangement's dynamics.
//
// Everything here is a pure function of the flattened score, so the result is
// identical live and offline and the preview === export invariant holds. It
// needs no lookahead trickery because it can simply read ahead.
//
// MONO IS NEVER TOUCHED. Mono plays one voice by definition, so there is
// nothing to normalize - which is also what guarantees .h/.fmf output and the
// badge-accurate preview cannot be affected by any of this.

export const DEFAULT_NORMALIZE = {
  kind: 'normalize',
  v: 1,
  enabled: true,
  track: 0.5, // per-track polyphony exponent
  song: 0.5, // whole-arrangement polyphony exponent
  // How gently the factor may move. Too little clicks on held notes; too
  // much lets short dense hits through - measured on Bad Apple, whose notes
  // run 18-109 ms, 30 ms let a six-voice stack back over full scale while
  // 10 ms held it under. The Levels tool exposes it because the right value
  // depends entirely on how short the material's notes are.
  smoothMs: 10,
};

export function normalizeConfig(doc) {
  const cfg = doc && doc.master && doc.master.normalize;
  return cfg ? { ...DEFAULT_NORMALIZE, ...cfg } : DEFAULT_NORMALIZE;
}

// A track can opt out (false) or set its own exponent (a number).
export function trackExponent(cfg, track) {
  const own = track && track.normalize;
  if (own === false) return 0;
  if (typeof own === 'number') return Math.max(0, Math.min(1, own));
  return cfg.track;
}

// ---- polyphony over time ----

// Count of simultaneous events at every tick where the count CHANGES.
// Returns [{ tick, count }] sorted, starting at the first onset.
//
// A voice is counted until its RELEASE has finished, not until its notated
// end. Counting notated durations meant a chord's tails were invisible: the
// count dropped the instant the notes ended, the factor sprang back toward 1
// and every tail rang out at full level - four ducked notes releasing
// together straight back into the limiter.
export function polyphonyTimeline(events, releaseTicksOf = null) {
  const deltas = new Map();
  for (const ev of events) {
    if (ev.durationTicks <= 0) continue;
    deltas.set(ev.startTick, (deltas.get(ev.startTick) || 0) + 1);
    const end = ev.startTick + ev.durationTicks + (releaseTicksOf ? releaseTicksOf(ev) : 0);
    deltas.set(end, (deltas.get(end) || 0) - 1);
  }
  const ticks = [...deltas.keys()].sort((a, b) => a - b);
  const out = [];
  let count = 0;
  for (const tick of ticks) {
    count += deltas.get(tick);
    out.push({ tick, count: Math.max(0, count) });
  }
  return out;
}

// Step lookup into a timeline: how many voices at this tick.
export function countAt(timeline, tick) {
  if (!timeline.length) return 0;
  let lo = 0;
  let hi = timeline.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].tick <= tick) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best < 0 ? 0 : timeline[best].count;
}

const factorFor = (count, k) => (count > 1 && k > 0 ? Math.pow(count, -k) : 1);

// ---- smoothing ----

// Voice counts change in steps, and a step in gain is a click. Smoothing is
// ZERO-PHASE (one pole forward, the same pole backward) rather than causal:
// a causal filter would let the first instant of a chord through at full
// level before ducking, which is exactly the transient we are trying to
// avoid. Reading the score means we can smooth into the future as easily as
// out of the past.
export function smooth(values, stepMs, smoothMs) {
  if (!(smoothMs > 0) || values.length < 3) return values;
  const a = Math.exp(-stepMs / smoothMs);
  const out = Float64Array.from(values);
  for (let i = 1; i < out.length; i++) out[i] = out[i] * (1 - a) + out[i - 1] * a;
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i] * (1 - a) + out[i + 1] * a;
  return out;
}

const SAMPLE_MS = 5; // resolution the factor curve is built at
const FLAT_ENOUGH = 0.01; // level spread treated as constant (~0.09 dB)

// Round applied levels to the microscopic, so smoothing's float tails do not
// leak into saved files and golden fixtures as 0.9499999999999998.
const q = (v) => Math.round(v * 1e6) / 1e6;

// Build the normalization factor for one track over the whole song, sampled
// on a uniform time grid so it can be smoothed.
function buildFactorCurve(doc, events, trackId, cfg, tickToSeconds, endTick, songMax, n, totalS, relOf) {
  const kTrack = trackExponent(cfg, doc.tracks.find((t) => t.id === trackId));
  const kSong = cfg.song;
  if (kTrack <= 0 && kSong <= 0) return null;

  const trackLine = polyphonyTimeline(events.filter((e) => e.trackId === trackId), relOf);
  const trackMax = maxCountGrid(trackLine, n, endTick);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    raw[i] = factorFor(trackMax[i], kTrack) * factorFor(songMax[i], kSong);
  }
  return { values: smooth(raw, SAMPLE_MS, cfg.smoothMs), totalS, n };
}

// The HIGHEST voice count each grid cell overlaps - not the count sampled at
// its midpoint.
//
// Polyphony changes in steps, and those steps land between grid points. Point
// sampling therefore reads the value from just BEFORE a chord arrives, and the
// note covering that instant sails through at full level: measured on the Bad
// Apple demo, a six-voice hit was being scaled by 1.0 instead of 0.41. Taking
// the worst count in each cell errs toward too much headroom, which is the
// only safe direction to err.
function maxCountGrid(timeline, n, endTick) {
  const out = new Int32Array(n);
  if (!timeline.length || endTick <= 0) return out;
  const pos = (tick) => (tick / endTick) * (n - 1);
  for (let j = 0; j < timeline.length; j++) {
    const count = timeline[j].count;
    if (count <= 1) continue;
    const from = Math.max(0, Math.floor(pos(timeline[j].tick)));
    const nextTick = j + 1 < timeline.length ? timeline[j + 1].tick : endTick;
    const to = Math.min(n - 1, Math.ceil(pos(nextTick)));
    for (let i = from; i <= to; i++) if (count > out[i]) out[i] = count;
  }
  return out;
}

function sampleCurve(curve, seconds) {
  const pos = (seconds * 1000) / SAMPLE_MS;
  const i = Math.max(0, Math.min(curve.n - 1, Math.round(pos)));
  return curve.values[i];
}

// ---- application ----

// Fold the factor into each event's level. Events already carry gainMul (a
// scalar) or gainCurve (from a gain automation lane); normalization
// multiplies into whichever is there, so the two compose instead of one
// winning.
export function applyNormalization(doc, events, tickToSeconds, releaseTicksOf = null) {
  const cfg = normalizeConfig(doc);
  if (!cfg.enabled || doc.mode !== 'poly' || !events.length) return events;
  if (cfg.track <= 0 && cfg.song <= 0) return events;

  const relOf = releaseTicksOf || (() => 0);
  let endTick = 0;
  for (const ev of events) endTick = Math.max(endTick, ev.startTick + ev.durationTicks + relOf(ev));
  if (endTick <= 0) return events;

  // The song-wide timeline and its grid are identical for every track, so
  // they are built once rather than per track.
  const totalS = tickToSeconds(endTick);
  const n = Math.max(2, Math.ceil((totalS * 1000) / SAMPLE_MS) + 1);
  const songMax = maxCountGrid(polyphonyTimeline(events, relOf), n, endTick);

  const curves = new Map();
  for (const ev of events) {
    if (!curves.has(ev.trackId)) {
      curves.set(ev.trackId, buildFactorCurve(doc, events, ev.trackId, cfg, tickToSeconds, endTick, songMax, n, totalS, relOf));
    }
    const curve = curves.get(ev.trackId);
    if (!curve) continue;

    // The curve spans the NOTE, and the voice holds its final value through
    // the release. That is correct precisely because ringing tails are
    // counted (see polyphonyTimeline): at a note's end tick its own tail and
    // its neighbours' are all still sounding, so the last value is already
    // the ducked one the release should keep.
    const startS = tickToSeconds(ev.startTick);
    const endS = tickToSeconds(ev.startTick + ev.durationTicks);
    // Sample strictly INSIDE the note: at u=1 exactly, the grid has already
    // moved on to whatever starts next, so the last point of every curve
    // would carry the following moment's factor.
    const span = Math.max(0, endS - startS - 1e-4);
    const at = (u) => sampleCurve(curve, startS + span * u);

    // Whether the factor moves across this note has to be decided by looking
    // INSIDE it, not just at its ends. A held note that spans a chord dips in
    // the middle and comes back - endpoints alone report "constant 1.0" and
    // the note sails through the dense passage at full level, which is
    // exactly the overshoot this module exists to prevent.
    const probes = Math.max(2, Math.min(32, Math.ceil(((endS - startS) * 1000) / SAMPLE_MS)));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= probes; i++) {
      const v = at(i / probes);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }

    if (ev.gainCurve) {
      // Follow the existing lane curve point for point.
      const n = ev.gainCurve.length;
      for (let i = 0; i < n; i++) ev.gainCurve[i] = q(ev.gainCurve[i] * at(n === 1 ? 0 : i / (n - 1)));
    } else if (hi - lo < FLAT_ENOUGH) {
      // Smoothing means the factor is never EXACTLY constant, so an exact
      // test would push nearly every note onto the curve path - measured on
      // Bad Apple, 5280 of 5650 notes, at 127k float points per flatten, for
      // level changes far below hearing. Anything under 1% (0.09 dB) is taken
      // as flat, at its lowest value so headroom is never overstated.
      ev.gainMul = q((ev.gainMul ?? 1) * lo);
    } else {
      // The factor moves across this note, so it needs a curve of its own.
      const steps = Math.min(64, Math.max(2, Math.ceil(((endS - startS) * 1000) / SAMPLE_MS)));
      const arr = new Float32Array(steps + 1);
      const base = ev.gainMul ?? 1;
      for (let i = 0; i <= steps; i++) arr[i] = q(base * at(i / steps));
      ev.gainCurve = arr;
      delete ev.gainMul;
    }
  }
  return events;
}

// ---- reporting ----

// The loudest instant in the song, as a linear peak, so the UI can say what a
// setting will actually do before anyone renders anything. Summing voice
// gains is an upper bound (real waves rarely align perfectly) which is the
// right direction to err for headroom.
export function predictPeak(doc, events, resolveInstrument, masterGain = 0.9) {
  if (!events.length) return { peak: 0, tick: 0, voices: 0 };
  const starts = [...new Set(events.map((e) => e.startTick))].sort((a, b) => a - b);
  let best = { peak: 0, tick: 0, voices: 0 };
  for (const tick of starts) {
    let sum = 0;
    let voices = 0;
    for (const ev of events) {
      if (ev.startTick > tick || tick >= ev.startTick + ev.durationTicks) continue;
      voices++;
      const inst = resolveInstrument(ev);
      // Sample the event's curve AT THIS MOMENT, not at its own onset - a
      // note that started quiet and swelled would otherwise be counted at
      // the level it had bars ago.
      let level = ev.gainMul ?? 1;
      if (ev.gainCurve && ev.gainCurve.length) {
        const u = ev.durationTicks > 0 ? (tick - ev.startTick) / ev.durationTicks : 0;
        const i = Math.max(0, Math.min(ev.gainCurve.length - 1, Math.round(u * (ev.gainCurve.length - 1))));
        level = ev.gainCurve[i];
      }
      sum += (inst ? inst.gain : 1) * (ev.velocity / 127) * level;
    }
    const peak = sum * masterGain;
    if (peak > best.peak) best = { peak, tick, voices };
  }
  return best;
}
