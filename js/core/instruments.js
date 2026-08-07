// Voice scheduling shared by live playback and offline WAV rendering.

import { pitchToFreq } from './music.js';
import {
  effectiveEnvelope, envToAdsr, isAdsrShaped, releaseTime, buildGainCurve,
} from './modulation.js';

// PWM Fourier series: imag[k] = (2/(k*pi)) * sin(k*pi*duty)
export function dutyHarmonics(duty, n = 32) {
  const imag = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) {
    imag[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  }
  return imag;
}

// ---- additive (harmonic) waves ----
//
// A custom wave is stored as `wave: 'custom'` with `duty: null` and a list of
// partial amplitudes in `instrument.harmonics` - deliberately NOT a new wave
// id. An older build meeting this file takes the 'custom' branch, finds no
// duty, and falls through to exactly the same harmonics path, so it plays the
// sound correctly rather than throwing on an oscillator type it has never
// heard of. The capability has been in the engine since the beginning; only
// the editor is new.
export const MAX_PARTIALS = 8;

// Amplitudes are 0..1 and rounded, so a saved file stays readable and two
// documents that sound the same compare equal.
export function sanitizeHarmonics(list) {
  if (!Array.isArray(list)) return null;
  const out = list.slice(0, MAX_PARTIALS).map((v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;
  });
  return out.some((v) => v > 0) ? out : null; // all-silent is not a wave
}

// Partial amplitudes -> the imaginary part of a PeriodicWave. Index 0 is DC
// and stays 0; partial n lands at index n. Pure, so the wave a document
// describes can be asserted without an AudioContext.
export function harmonicImag(list) {
  const clean = sanitizeHarmonics(list) || [];
  const imag = new Float32Array(clean.length + 1);
  clean.forEach((v, i) => (imag[i + 1] = v));
  return imag;
}

// Starting points, not a fixed menu - each is just a partial list.
export const HARMONIC_PRESETS = [
  ['Organ', [1, 0.6, 0, 0.4, 0, 0, 0, 0.25]],
  ['Hollow', [1, 0, 0.33, 0, 0.2, 0, 0.14, 0]],
  ['Bright', [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.13]],
  ['Reed', [1, 0.8, 0.6, 0.7, 0.3, 0.35, 0.15, 0.2]],
];

const waveCache = new WeakMap(); // ctx -> Map<instrumentKey, PeriodicWave>

function getPeriodicWave(ctx, instrument, dutyOverride = null) {
  let byKey = waveCache.get(ctx);
  if (!byKey) {
    byKey = new Map();
    waveCache.set(ctx, byKey);
  }
  const effDuty = dutyOverride ?? instrument.duty;
  const key = instrument.id + ':' + (effDuty ?? '') + ':' + (instrument.harmonics ? instrument.harmonics.join(',') : '');
  let wave = byKey.get(key);
  if (!wave) {
    let imag;
    if (effDuty != null) {
      imag = dutyHarmonics(effDuty);
    } else if (instrument.harmonics && instrument.harmonics.length) {
      imag = harmonicImag(instrument.harmonics);
    } else {
      imag = dutyHarmonics(0.5);
    }
    const real = new Float32Array(imag.length);
    wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    byKey.set(key, wave);
  }
  return wave;
}

// Schedule one note into any BaseAudioContext (live or offline).
//
// ONE gain node, always. There used to be two - ADSR ramps on the first and
// the automation lane's value curve on a second, because those cannot share
// an AudioParam. They no longer have to: when both are moving they are
// multiplied together in modulation.js and handed over as a single curve.
//
// Two paths, chosen by whether anything actually varies:
//
//   ramps  nothing but the envelope moves, and it is ADSR-shaped. Scheduled
//          as exact Web Audio ramps - the badge's 2 ms attack lands on the
//          sample it should, which no sampled curve can promise.
//   curve  a gain lane varies across the note, or the envelope was drawn
//          freehand. One merged array covers the whole voice, release tail
//          included.
//
// opts: gainMul scales the note; gainCurve is the lane sampled across the
// note's span (from flatten); duty overrides the pulse width; adsr overrides
// the envelope per event (the ADSR automation lanes); detune shifts pitch in
// cents; lfo adds periodic detune (vibrato).
// Per-note velocity is PRESERVED in the document - MIDI import fills it in,
// and every edit path carries it through - but it is NOT APPLIED to the
// sound. Nothing in the UI shows or edits it, so a note sitting 6 dB below
// its neighbours looks identical to them with nothing on screen to explain
// why. Until there is a velocity editor, every note sounds at the nominal
// value, so the only thing that varies is something you can actually see.
//
// The nominal is 100 rather than 127 deliberately: 100 is what every note
// written in the app already carries, so ignoring velocity changes the level
// of the notes that DEVIATE without shifting the whole app 2.1 dB louder.
//
// Re-enabling is one line here and one in normalize.js - which is why they
// share this constant rather than each spelling out /127.
export const NOMINAL_VELOCITY = 100;
export const VELOCITY_GAIN = NOMINAL_VELOCITY / 127;

export function scheduleNote(
  ctx,
  destination,
  instrument,
  {
    pitch, startTime, stopTime, velocity = 100, // accepted and ignored - see VELOCITY_GAIN
    gainMul = 1, gainCurve = null, duty = null, adsr = null,
    detune = 0, lfo = null, pan = null,
  }
) {
  const osc = ctx.createOscillator();
  if (instrument.wave === 'custom') {
    osc.setPeriodicWave(getPeriodicWave(ctx, instrument, duty));
  } else {
    osc.type = instrument.wave;
  }
  osc.frequency.value = pitchToFreq(pitch);

  const env = effectiveEnvelope(instrument, adsr);
  const peak = instrument.gain * gainMul * VELOCITY_GAIN;
  const hold = Math.max(0, stopTime - startTime);
  const release = Math.max(releaseTime(env), 0.001);

  const gain = ctx.createGain();
  const laneVaries = gainCurve && gainCurve.length >= 2 && hold > 0;

  if (!laneVaries && isAdsrShaped(env)) {
    const { a, d, s } = envToAdsr(env);
    gain.gain.setValueAtTime(0, startTime);
    const attackEnd = startTime + Math.min(a, hold);
    gain.gain.linearRampToValueAtTime(peak, attackEnd);
    let sustainLevel = peak;
    if (d > 0 && s < 1 && attackEnd + d < stopTime) {
      sustainLevel = peak * s;
      gain.gain.linearRampToValueAtTime(sustainLevel, attackEnd + d);
    }
    gain.gain.setValueAtTime(sustainLevel, stopTime);
    gain.gain.linearRampToValueAtTime(0, stopTime + release);
  } else {
    // The lane arrives sampled evenly across [startTime, stopTime]; read it
    // back by position, and hold the final value through the release. That
    // final value is the right one to hold because normalization counts
    // ringing tails, so it is already the ducked level - it used to be the
    // level AFTER the other voices stopped, which released four ducked notes
    // at full volume straight back into the limiter.
    const laneAt = laneVaries
      ? (t) => {
          const u = hold > 0 ? Math.min(1, Math.max(0, t / hold)) : 0;
          const i = Math.min(gainCurve.length - 1, Math.round(u * (gainCurve.length - 1)));
          return gainCurve[i];
        }
      : null;
    const { curve, duration } = buildGainCurve({ env, peak, holdSec: hold, laneAt, tailSec: release });
    gain.gain.setValueCurveAtTime(curve, startTime, duration);
  }

  if (detune) osc.detune.value = detune;
  if (lfo && lfo.depth) {
    // Vibrato as a real oscillator on osc.detune - cheaper and more accurate
    // than sampling it into the pitch, and it costs two nodes only when used.
    const mod = ctx.createOscillator();
    mod.frequency.value = lfo.rate ?? 5;
    const depth = ctx.createGain();
    depth.gain.value = lfo.depth;
    mod.connect(depth).connect(osc.detune);
    mod.start(startTime + (lfo.delay ?? 0));
    mod.stop(stopTime + release + 0.001);
  }

  osc.connect(gain);
  // A pan lane makes position per-event, so this voice carries its own
  // panner. Without a lane the track node handles it once for every voice,
  // which is cheaper and is why this is conditional.
  if (pan != null && ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    gain.connect(panner);
    panner.connect(destination);
  } else {
    gain.connect(destination);
  }
  osc.start(startTime);
  osc.stop(stopTime + release + 0.001);
  return osc;
}

// Resolves shared instruments by id, and per-track "Custom" configs via the
// virtual id "track:<trackId>".
export function getInstrument(doc, instrumentId) {
  if (instrumentId && instrumentId.startsWith('track:')) {
    const track = doc.tracks.find((t) => t.id === instrumentId.slice(6));
    if (track && track.instrument) return track.instrument;
  }
  return doc.instruments.find((i) => i.id === instrumentId) || doc.instruments[0];
}
