// Automation lane sampling - pure functions, no DOM/audio/store.
// Lanes live on Track.automation = { gain: [...], duty: [...], instrument: [...] }
// with points { tick, value, curve } ('step'|'linear'|'ease'; the curve
// describes the segment LEAVING the point) or { tick, instrumentId } for the
// step-only instrument lane. Points are sorted by tick, one per tick.

// Single source of truth for parameter ranges/formatting (core + UI).
// def null = resolved from the effective instrument (adsrKey / duty).
const pct = (v) => Math.round(v * 100) + '%';
const secs = (v) => (v >= 0.1 ? v.toFixed(2) + ' s' : Math.round(v * 1000) + ' ms');

export const AUTOMATION_PARAMS = {
  gain: { label: 'Gain', min: 0, max: 1, def: 1, fmt: pct },
  attack: { label: 'Attack', min: 0, max: 0.3, def: null, adsrKey: 'a', fmt: secs },
  decay: { label: 'Decay', min: 0, max: 0.5, def: null, adsrKey: 'd', fmt: secs },
  sustain: { label: 'Sustain', min: 0, max: 1, def: null, adsrKey: 's', fmt: pct },
  release: { label: 'Release', min: 0, max: 0.8, def: null, adsrKey: 'r', fmt: secs },
  duty: { label: 'Duty', min: 0.05, max: 0.5, def: null, fmt: pct },
};

// Lane stacking order in the UI; duty only applies to PWM instruments.
export const LANE_ORDER = ['gain', 'attack', 'decay', 'sustain', 'release', 'duty'];

const smoothstep = (t) => t * t * (3 - 2 * t);

// Index of the last point with point.tick <= tick, or -1 (binary search).
function lastIndexAtOrBefore(points, tick) {
  let lo = 0;
  let hi = points.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].tick <= tick) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// Value lanes: default before the first point, interpolate between points
// per the LEFT point's curve, hold after the last point.
export function sampleAutomation(points, tick, defaultValue) {
  if (!points || !points.length) return defaultValue;
  const i = lastIndexAtOrBefore(points, tick);
  if (i < 0) return defaultValue;
  const p = points[i];
  const q = points[i + 1];
  if (!q || p.curve === 'step' || q.tick === p.tick) return p.value;
  const t = (tick - p.tick) / (q.tick - p.tick);
  const shaped = p.curve === 'ease' ? smoothstep(t) : t;
  return p.value + (q.value - p.value) * shaped;
}

// Step-only lanes (instrument switches): last point at or before tick.
export function sampleStep(points, tick) {
  if (!points || !points.length) return null;
  const i = lastIndexAtOrBefore(points, tick);
  return i < 0 ? null : points[i];
}

// Quantize sampled duty to 1% steps so the PeriodicWave cache stays bounded.
export function quantizeDuty(v) {
  return Math.round(v * 100) / 100;
}

// Gain over a note's span: a scalar when the lane is constant across
// [startTick, endTick), else a sampled curve for setValueCurveAtTime.
const CURVE_STEP_TICKS = 24; // 1/16 note at PPQ 96
const CURVE_MAX_POINTS = 256;

export function sampleGainCurve(points, startTick, endTick, defaultValue = 1) {
  const first = sampleAutomation(points, startTick, defaultValue);
  // Short events (arp steps, staccato) sample once at their start - curves
  // are reserved for held notes where an intra-note ramp is audible.
  if (endTick - startTick <= CURVE_STEP_TICKS * 2) return { gainMul: first };
  const last = sampleAutomation(points, Math.max(startTick, endTick - 1), defaultValue);
  // Constant iff no lane point strictly inside the span and endpoints agree.
  const i0 = lastIndexAtOrBefore(points || [], startTick);
  const i1 = lastIndexAtOrBefore(points || [], endTick - 1);
  const flat = i0 === i1 && Math.abs(first - last) < 1e-6;
  if (flat) return { gainMul: first };

  const span = endTick - startTick;
  const steps = Math.min(CURVE_MAX_POINTS - 1, Math.max(2, Math.ceil(span / CURVE_STEP_TICKS)));
  const curve = new Float32Array(steps + 1);
  for (let s = 0; s <= steps; s++) {
    const tick = startTick + (span * s) / steps;
    curve[s] = sampleAutomation(points, tick, defaultValue);
  }
  return { gainCurve: curve };
}
