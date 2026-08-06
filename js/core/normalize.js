// Levels: keeping the mix under full scale without taxing the quiet parts.
//
// The problem, measured rather than assumed: one voice at the default
// instrument gain peaks around 0.25, voices sum linearly, and the master's
// soft clipper starts shaping at 0.708 - so the FOURTH simultaneous note was
// already being distorted, and the shipped Tetris and Bad Apple demos had
// been running about +5 dB into the limiter since they were made.
//
// This module went through two designs, and the second exists because the
// first was measurably wrong:
//
//   v1  scale every voice by N^-k, where N is how many are sounding. Simple,
//       but voice COUNT is a poor proxy for loudness. A plain monophonic
//       melody whose notes overlap only by their release tails was counted
//       as two voices and halved - nothing was near clipping, and it ducked
//       anyway.
//
//   v2  measure the actual amplitude sum and duck only by how far it exceeds
//       a target. Below the target nothing happens at all, so a sparse
//       melody, a two-note interval and a moderate chord are untouched, and
//       only a genuinely hot moment is pulled down. It is a limiter driven
//       by the score rather than by the audio - which means it needs no
//       lookahead trickery, because it can simply read ahead.
//
// N^-k survives as an OPTIONAL evenness dial (default 0, off) for anyone who
// wants a chord to sound only slightly louder than a single note. That is a
// taste preference, distinct from staying under full scale, so it is a
// separate control rather than the mechanism.
//
// Everything here is a pure function of the flattened score, so the result is
// identical live and offline and preview === export still holds.
//
// MONO IS NEVER TOUCHED. Mono plays one voice by definition, which is also
// what guarantees .h/.fmf output and the badge-accurate preview cannot be
// affected by any of this.

export const DEFAULT_NORMALIZE = {
  kind: 'normalize',
  v: 1,
  enabled: true,
  // Ceiling for the predicted sum, in dB relative to full scale. Set at the
  // master's soft-clip knee, so the clipper stays a safety net rather than
  // something the mix leans on.
  targetDb: -3,
  // Optional evenness: scale voices by N^-k on top of the headroom work.
  // 0 = off, 0.5 = equal power, 1 = a chord as loud as a single note.
  song: 0,
  track: 0,
  // How gently the factor may move. Too little clicks on held notes; too
  // much lets short dense hits through - Bad Apple's notes run 18-109 ms.
  smoothMs: 10,
};

export function normalizeConfig(doc) {
  const cfg = doc && doc.master && doc.master.normalize;
  return cfg ? { ...DEFAULT_NORMALIZE, ...cfg } : DEFAULT_NORMALIZE;
}

// A track can opt out of the evenness stage (false) or set its own exponent.
export function trackExponent(cfg, track) {
  const own = track && track.normalize;
  if (own === false) return 0;
  if (typeof own === 'number') return Math.max(0, Math.min(1, own));
  return cfg.track;
}

export const dbToLin = (db) => Math.pow(10, db / 20);

// ---- polyphony (evenness stage only) ----

// Count of simultaneous events at every tick where the count CHANGES.
//
// A voice is counted until its RELEASE has finished, not until its notated
// end: counting notated durations made a chord's tails invisible, so the
// count dropped the instant the notes ended and every tail rang out at full
// level.
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

// The sum moves in steps as notes start and stop, and a step in gain is a
// click. Smoothing is ZERO-PHASE (one pole forward, the same pole backward)
// rather than causal: a causal filter would let the first instant of a chord
// through at full level before ducking, which is the transient we exist to
// prevent. Reading the score lets us smooth into the future as easily as out
// of the past.
export function smooth(values, stepMs, smoothMs) {
  if (!(smoothMs > 0) || values.length < 3) return values;
  const a = Math.exp(-stepMs / smoothMs);
  const out = Float64Array.from(values);
  for (let i = 1; i < out.length; i++) out[i] = out[i] * (1 - a) + out[i - 1] * a;
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i] * (1 - a) + out[i + 1] * a;
  return out;
}

const SAMPLE_MS = 5; // resolution the factor grid is built at
const FLAT_ENOUGH = 0.01; // level spread treated as constant (~0.09 dB)
const q = (v) => Math.round(v * 1e6) / 1e6;

// ---- the amplitude sum ----

// Predicted output amplitude at every 5 ms step.
//
// Each voice contributes its actual level - instrument gain, velocity, track
// gain and any gain automation - held flat while the note sounds and decaying
// linearly through its release. Summing amplitudes is an upper bound, since
// real waves rarely align perfectly, which is the right direction to err for
// headroom.
export function amplitudeGrid(events, n, endTick, voiceOf) {
  const sum = new Float64Array(n);
  if (endTick <= 0) return sum;
  const pos = (tick) => (tick / endTick) * (n - 1);
  for (const ev of events) {
    if (ev.durationTicks <= 0) continue;
    const { level, releaseTicks } = voiceOf(ev);
    if (!(level > 0)) continue;
    const noteEnd = ev.startTick + ev.durationTicks;
    const from = Math.max(0, Math.floor(pos(ev.startTick)));
    const heldTo = Math.min(n - 1, Math.ceil(pos(noteEnd)));
    for (let i = from; i <= heldTo; i++) sum[i] += level;
    if (releaseTicks > 0) {
      const tailTo = Math.min(n - 1, Math.ceil(pos(noteEnd + releaseTicks)));
      const span = Math.max(1, tailTo - heldTo);
      for (let i = heldTo + 1; i <= tailTo; i++) {
        sum[i] += level * Math.max(0, 1 - (i - heldTo) / span);
      }
    }
  }
  return sum;
}

// ---- application ----

// Fold the headroom factor (and the optional evenness stages) into each
// event's level. Events already carry gainMul or gainCurve from a gain
// automation lane; this multiplies into whichever is there, so the two
// compose rather than one winning.
//
// voiceOf(ev) -> { level, releaseTicks }: the event's actual output level and
// how long it keeps ringing. Supplied by flatten, the layer that can resolve
// instruments and envelopes.
export function applyNormalization(doc, events, tickToSeconds, voiceOf) {
  const cfg = normalizeConfig(doc);
  if (!cfg.enabled || doc.mode !== 'poly' || !events.length || !voiceOf) return events;

  const relOf = (ev) => voiceOf(ev).releaseTicks || 0;
  let endTick = 0;
  for (const ev of events) endTick = Math.max(endTick, ev.startTick + ev.durationTicks + relOf(ev));
  if (endTick <= 0) return events;

  const totalS = tickToSeconds(endTick);
  const n = Math.max(2, Math.ceil((totalS * 1000) / SAMPLE_MS) + 1);

  // Headroom: duck only by how far the sum exceeds the target. Below it every
  // factor is exactly 1 and nothing is touched - which is what keeps a sparse
  // melody, an interval or a moderate chord out of this entirely.
  const target = dbToLin(cfg.targetDb);
  const sum = amplitudeGrid(events, n, endTick, voiceOf);
  const head = new Float64Array(n);
  let anyDuck = false;
  for (let i = 0; i < n; i++) {
    head[i] = sum[i] > target ? target / sum[i] : 1;
    if (head[i] < 1) anyDuck = true;
  }
  // Smoothing must never leave the factor ABOVE what the moment needs, or a
  // short dense hit slips through: Bad Apple's six-voice stacks overshot to
  // 1.045 at 10 ms of smoothing, where the raw requirement was 0.708. Taking
  // the lower of the two gives a limiter's shape - it eases in and recovers
  // gently, but reaches full depth wherever depth is actually required.
  const smoothed = smooth(head, SAMPLE_MS, cfg.smoothMs);
  const headroom = new Float64Array(n);
  for (let i = 0; i < n; i++) headroom[i] = Math.min(head[i], smoothed[i]);

  // Evenness (optional, off by default): the N^-k stages.
  const wantsEvenness = cfg.song > 0 || doc.tracks.some((t) => trackExponent(cfg, t) > 0);
  if (!anyDuck && !wantsEvenness) return events;

  const songLine = wantsEvenness ? polyphonyTimeline(events, relOf) : null;
  const trackLines = new Map();
  const evenAt = (ev, tick) => {
    if (!wantsEvenness) return 1;
    const kTrack = trackExponent(cfg, doc.tracks.find((t) => t.id === ev.trackId));
    if (!trackLines.has(ev.trackId)) {
      trackLines.set(ev.trackId, polyphonyTimeline(events.filter((e) => e.trackId === ev.trackId), relOf));
    }
    return (
      factorFor(countAt(trackLines.get(ev.trackId), tick), kTrack) *
      factorFor(countAt(songLine, tick), cfg.song)
    );
  };

  const sampleHead = (seconds) => {
    const i = Math.max(0, Math.min(n - 1, Math.round((seconds * 1000) / SAMPLE_MS)));
    return headroom[i];
  };

  for (const ev of events) {
    const startS = tickToSeconds(ev.startTick);
    const endS = tickToSeconds(ev.startTick + ev.durationTicks);
    // Sample strictly INSIDE the note: at its exact end the grid has already
    // moved on to whatever starts next.
    const span = Math.max(0, endS - startS - 1e-4);
    const at = (u) => sampleHead(startS + span * u) * evenAt(ev, ev.startTick + ev.durationTicks * u);

    // Whether the factor moves has to be decided by looking INSIDE the note,
    // not just at its ends: a held note spanning a chord dips in the middle
    // and comes back, and endpoints alone report "constant".
    const probes = Math.max(2, Math.min(32, Math.ceil(((endS - startS) * 1000) / SAMPLE_MS)));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= probes; i++) {
      const v = at(i / probes);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo >= 1) continue; // nothing to do for this note

    if (ev.gainCurve) {
      const len = ev.gainCurve.length;
      for (let i = 0; i < len; i++) ev.gainCurve[i] = q(ev.gainCurve[i] * at(len === 1 ? 0 : i / (len - 1)));
    } else if (hi - lo < FLAT_ENOUGH) {
      // Smoothing means the factor is never EXACTLY constant, so an exact
      // test would push nearly every note onto the curve path for level
      // changes far below hearing. Taken at its lowest value, so headroom is
      // never overstated.
      ev.gainMul = q((ev.gainMul ?? 1) * lo);
    } else {
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
// setting will do before anyone renders anything.
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
      // Sample the event's curve AT THIS MOMENT, not at its own onset.
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
