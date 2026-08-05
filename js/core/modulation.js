// One model for "a value that moves over time".
//
// The app had two, and they were fighting:
//
//   ADSR             note-relative, gain only, four scalars on the instrument,
//                    rendered as Web Audio ramps on a gain node.
//   automation lanes song-absolute, any parameter, sampled per event - and
//                    for gain, rendered as a value curve on a SECOND gain
//                    node, because ramps and setValueCurveAtTime cannot share
//                    one AudioParam.
//
// That second node was the tell. Two systems were being combined in the node
// GRAPH when they should be combined in the VALUE domain: multiply the
// numbers first, hand Web Audio one curve. This module does the multiplying.
//
// Everything here is pure - no AudioContext, no DOM - so the shapes can be
// unit-tested at a resolution no listening test would catch.

// ---- envelope ----
//
// Envelope = { kind:'env', v:1, points:[{t, value, curve}], sustainIndex,
//              timeBase:'sec' }
//
// Points up to and including sustainIndex are measured in seconds from note
// ONSET; the sustain point holds for as long as the key is down. Points after
// it are measured from note OFF and form the release. That is the classic
// sustaining-envelope model, and it is what lets one shape describe both a
// 40 ms blip and a four-bar pad.
//
// `curve` describes the segment LEAVING the point - the same convention the
// automation lanes already use, so there is one thing to learn.

export const ENV_KIND = 'env';
export const ENV_VERSION = 1;

const smoothstep = (t) => t * t * (3 - 2 * t);

function shape(t, curve) {
  if (curve === 'step') return 0;
  if (curve === 'ease') return smoothstep(t);
  return t;
}

// The four ADSR sliders, expressed as an envelope. Sliders and a drawn curve
// therefore edit ONE data shape rather than two that have to agree.
export function adsrToEnv(adsr = {}) {
  const a = Math.max(0, adsr.a ?? 0.002);
  const d = Math.max(0, adsr.d ?? 0);
  const s = Math.min(1, Math.max(0, adsr.s ?? 1));
  const r = Math.max(0, adsr.r ?? 0.002);
  return {
    kind: ENV_KIND,
    v: ENV_VERSION,
    timeBase: 'sec',
    sustainIndex: 2,
    points: [
      { t: 0, value: 0, curve: 'linear' },
      { t: a, value: 1, curve: 'linear' },
      { t: a + d, value: s, curve: 'linear' },
      { t: r, value: 0, curve: 'linear' }, // measured from note-off
    ],
  };
}

// The inverse, when the shape still happens to be ADSR-shaped. Returns null
// otherwise, which is how the UI knows to grey the sliders out: a drawn curve
// it cannot represent must not be silently rounded back into four numbers.
export function envToAdsr(env) {
  if (!env || env.sustainIndex !== 2 || env.points.length !== 4) return null;
  const [p0, p1, p2, p3] = env.points;
  if (p0.t !== 0 || p0.value !== 0 || p1.value !== 1 || p3.value !== 0) return null;
  if (env.points.some((p) => p.curve && p.curve !== 'linear')) return null;
  // Decay is stored as the absolute time a+d, so recovering d subtracts two
  // floats. Round to the microsecond, or a UI that reads these values and
  // writes them back would walk the envelope a little further every time.
  const us = (v) => Math.round(v * 1e6) / 1e6;
  return { a: us(p1.t), d: us(p2.t - p1.t), s: p2.value, r: us(p3.t) };
}

export function isAdsrShaped(env) {
  return envToAdsr(env) !== null;
}

// The envelope a voice should use: an explicitly drawn one wins, otherwise the
// ADSR sliders. `adsrOverride` is what the automation lanes sampled for this
// event, so per-event ADSR automation still works - it now feeds the envelope
// generator instead of a parallel code path.
export function effectiveEnvelope(instrument, adsrOverride = null) {
  if (instrument && instrument.env && instrument.env.points) return instrument.env;
  const adsr = adsrOverride ? { ...(instrument?.adsr || {}), ...adsrOverride } : instrument?.adsr;
  return adsrToEnv(adsr || {});
}

// How long a voice keeps sounding after note-off.
export function releaseTime(env) {
  if (!env || !env.points.length) return 0;
  let tail = 0;
  for (let i = env.sustainIndex + 1; i < env.points.length; i++) {
    tail = Math.max(tail, env.points[i].t);
  }
  return tail;
}

// Interpolate within a run of points whose `t` share one origin.
function sampleRun(points, from, to, t) {
  if (to < from) return 0;
  if (t <= points[from].t) return points[from].value;
  for (let i = from; i < to; i++) {
    const p = points[i];
    const q = points[i + 1];
    if (t >= q.t) continue;
    if (q.t === p.t) return q.value;
    const u = shape((t - p.t) / (q.t - p.t), p.curve);
    return p.value + (q.value - p.value) * u;
  }
  return points[to].value;
}

// Sample the envelope at `tSec` seconds after onset, for a note held for
// `holdSec` seconds.
//
// The subtle case is a note SHORTER than its own attack: release must then
// start from wherever the envelope actually got to, not from the sustain
// level it never reached. Otherwise a staccato note on a slow pad would jump
// to full level the instant it ended - a click, and a loud one.
export function sampleEnvelope(env, tSec, holdSec) {
  if (!env || !env.points || !env.points.length) return 0;
  const si = Math.min(env.sustainIndex, env.points.length - 1);
  const sustain = env.points[si];

  if (tSec < holdSec) return sampleRun(env.points, 0, si, tSec);

  const atOff = sampleRun(env.points, 0, si, holdSec);
  if (si >= env.points.length - 1) return 0; // no release stage

  // Post-sustain points are measured from note OFF, not from onset, so they
  // cannot be walked in the same frame as the attack/decay. Rebase the
  // sustain point to t=0 and read the release in its own frame.
  const relPoints = [{ t: 0, value: sustain.value, curve: sustain.curve }, ...env.points.slice(si + 1)];
  const rel = sampleRun(relPoints, 0, relPoints.length - 1, tSec - holdSec);

  // Scale the release shape to where the note actually was when it ended.
  if (sustain.value > 1e-9) return rel * (atOff / sustain.value);
  return tSec - holdSec <= 0 ? atOff : 0;
}

// ---- LFO (vibrato) ----
//
// Reserved shape for periodic modulation: `detune` is the target that makes
// vibrato and portamento data rather than deferred features. No UI yet - the
// resolver and its tests exist so adding one is a UI job.
export function sampleLfo(lfo, tSec) {
  if (!lfo) return 0;
  const delay = lfo.delay ?? 0;
  if (tSec < delay) return 0;
  const phase = (tSec - delay) * (lfo.rate ?? 5) * 2 * Math.PI;
  return Math.sin(phase) * (lfo.depth ?? 0);
}

// ---- the merged gain curve ----

// Sampling resolution for merged curves. setValueCurveAtTime interpolates
// linearly between UNIFORMLY spaced points, so the spacing has to resolve the
// sharpest thing in the shape - and the badge square's attack is 2 ms. At
// 0.5 ms a 2 ms attack is four points; a fixed "256 points per note" would
// smear it to nothing on any note longer than a second.
export const CURVE_STEP_S = 0.0005;
const CURVE_MAX_POINTS = 1 << 17; // ~65 s of voice; beyond that, resolution drops

// Build the whole voice level as one array: instrument gain x velocity x
// envelope x the song-absolute automation lane, sampled together.
//
// laneAt(tSec) supplies the lane value at a time offset from note start; pass
// null when the lane is constant (its value belongs in `peak` instead).
export function buildGainCurve({ env, peak, holdSec, laneAt = null, tailSec = null }) {
  const release = tailSec == null ? releaseTime(env) : tailSec;
  const total = Math.max(CURVE_STEP_S, holdSec + release);
  const n = Math.min(CURVE_MAX_POINTS, Math.max(2, Math.ceil(total / CURVE_STEP_S) + 1));
  const step = total / (n - 1);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * step;
    let v = peak * sampleEnvelope(env, t, holdSec);
    if (laneAt) v *= laneAt(t);
    curve[i] = v;
  }
  // Web Audio holds the final value after the curve ends; a voice must end
  // silent or it would keep sounding until the oscillator is stopped.
  curve[n - 1] = 0;
  return { curve, duration: total };
}
