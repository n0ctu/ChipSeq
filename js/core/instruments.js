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

// ---- spectrum: a base wave, then multipliers on its own harmonics ----
//
// A base wave IS its harmonic series - a saw is every harmonic at 1/n, a
// square the odd ones, a triangle the odd ones at 1/n^2 with alternating
// sign. So "pick a wave, then tune its harmonics" is one idea, not two: the
// wave supplies the series and the spectrum scales it.
//
// This follows how additive engines actually work. In Harmor and Razor a
// filter acts at the GENERATION stage, scaling partial amplitudes in the
// oscillator rather than processing audio afterwards; Harmor starts from
// "the classic all-overtone saw wave" for exactly the reason below. The
// alternative - a slider per partial - is how the Kawai K5000 ended up with
// over a thousand parameters per patch and a reputation for being unusable.
// The Hammond's nine drawbars are the counter-example worth copying.
//
// TILT is the primary control: dB per octave across the series, so one knob
// darkens or brightens the whole wave. PARTIALS are the detail layer, eight
// multipliers on the lowest harmonics where the ear is most sensitive.
//
// Multipliers can only scale what the base already has. A sine has a single
// partial, so nothing to shape; start from SAW to sculpt freely, since it is
// the one wave containing every harmonic.
export const MAX_PARTIALS = 8;

// Far enough that the top partial of the series sits at 1/256 (-48 dB) for a
// saw, which is inaudible - and the browser band-limits per note anyway, so
// nothing above Nyquist is ever heard.
export const SERIES_LENGTH = 256;

export const DEFAULT_SPECTRUM = { kind: 'spectrum', v: 1, tilt: 0, partials: null };
export const TILT_MIN = -12;
export const TILT_MAX = 6;

// The Fourier series of each base wave, as the imaginary (sine) coefficients.
// Index 0 is DC and stays zero. Signs matter - a triangle alternates - which
// is the other reason multipliers beat absolute amplitudes: the base carries
// the signs and the editor stays unsigned.
export function baseSeries(wave, duty = null, n = SERIES_LENGTH) {
  if (wave === 'custom') return dutyHarmonics(duty ?? 0.5, n);
  const imag = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) {
    if (wave === 'sine') imag[k] = k === 1 ? 1 : 0;
    else if (wave === 'sawtooth') imag[k] = 1 / k;
    else if (wave === 'square') imag[k] = k % 2 ? 1 / k : 0;
    else if (wave === 'triangle') imag[k] = k % 2 ? (((k - 1) / 2) % 2 ? -1 : 1) / (k * k) : 0;
    else imag[k] = k === 1 ? 1 : 0;
  }
  return imag;
}

// 0..2, so a partial can be pushed above what the base gives it as well as
// pulled down - otherwise a saw could only ever get duller.
export function sanitizePartials(list) {
  if (!Array.isArray(list)) return null;
  const out = list.slice(0, MAX_PARTIALS).map((v) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return 1;
    return Math.round(Math.max(0, Math.min(2, x)) * 1000) / 1000;
  });
  return out.some((v) => v !== 1) ? out : null; // all-neutral is no spectrum
}

export function spectrumOf(instrument) {
  const raw = instrument && instrument.spectrum;
  if (!raw) return DEFAULT_SPECTRUM;
  const tilt = Number.isFinite(Number(raw.tilt))
    ? Math.max(TILT_MIN, Math.min(TILT_MAX, Number(raw.tilt))) : 0;
  return { ...DEFAULT_SPECTRUM, ...raw, tilt, partials: sanitizePartials(raw.partials) };
}

// Does this instrument actually shape anything? A neutral spectrum must fall
// back to the browser's own oscillator, so merely opening the editor cannot
// change the sound.
export function hasSpectrum(instrument) {
  const s = spectrumOf(instrument);
  return s.tilt !== 0 || !!s.partials;
}

// base x tilt x per-partial multipliers.
export function applySpectrum(base, spectrum) {
  const s = spectrum || DEFAULT_SPECTRUM;
  const out = new Float32Array(base.length);
  // dB per octave: partial n is log2(n) octaves above the fundamental.
  const slope = s.tilt ? s.tilt / 20 : 0;
  for (let k = 1; k < base.length; k++) {
    let v = base[k];
    if (slope) v *= Math.pow(10, slope * Math.log2(k));
    if (s.partials && k <= s.partials.length) v *= s.partials[k - 1];
    out[k] = v;
  }
  return out;
}

// A pre-existing field: an ABSOLUTE list of partial amplitudes, read by the
// engine since the beginning. Treated as a base series so it composes with
// the spectrum rather than competing with it.
function legacyImag(list) {
  const imag = new Float32Array(list.length + 1);
  list.forEach((v, i) => (imag[i + 1] = Number(v) || 0));
  return imag;
}

const waveCache = new WeakMap(); // ctx -> Map<instrumentKey, PeriodicWave>

function getPeriodicWave(ctx, instrument, dutyOverride = null) {
  let byKey = waveCache.get(ctx);
  if (!byKey) {
    byKey = new Map();
    waveCache.set(ctx, byKey);
  }
  const effDuty = dutyOverride ?? instrument.duty;
  const spec = spectrumOf(instrument);
  const key = [
    instrument.id, effDuty ?? '', instrument.wave,
    instrument.harmonics ? instrument.harmonics.join(',') : '',
    spec.tilt, spec.partials ? spec.partials.join(',') : '',
  ].join(':');
  let wave = byKey.get(key);
  if (!wave) {
    const base = instrument.harmonics && instrument.harmonics.length
      ? legacyImag(instrument.harmonics)
      : baseSeries(instrument.wave, effDuty);
    const imag = applySpectrum(base, spec);
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
  // A neutral spectrum falls through to the browser's own band-limited
  // oscillator: opening the editor and changing nothing must change nothing.
  const shaped = instrument.wave === 'custom'
    || hasSpectrum(instrument)
    || (instrument.harmonics && instrument.harmonics.length);
  if (shaped) {
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
