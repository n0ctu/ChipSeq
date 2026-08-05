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
      imag = new Float32Array(instrument.harmonics.length + 1);
      instrument.harmonics.forEach((v, i) => (imag[i + 1] = v));
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
export function scheduleNote(
  ctx,
  destination,
  instrument,
  {
    pitch, startTime, stopTime, velocity = 100,
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
  const peak = instrument.gain * gainMul * (velocity / 127);
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
    // back by position so the merge does not care how many points it has.
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
