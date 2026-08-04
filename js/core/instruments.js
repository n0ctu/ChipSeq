// Voice scheduling shared by live playback and offline WAV rendering.

import { pitchToFreq } from './music.js';

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
// Automation extras: gainMul scales the whole note; gainCurve morphs the
// level across the note's span (applied on a SEPARATE gain node - ADSR ramps
// and setValueCurveAtTime may not share one AudioParam); duty overrides the
// pulse width for PWM instruments.
export function scheduleNote(
  ctx,
  destination,
  instrument,
  { pitch, startTime, stopTime, velocity = 100, gainMul = 1, gainCurve = null, duty = null, adsr = null }
) {
  const osc = ctx.createOscillator();
  if (instrument.wave === 'custom') {
    osc.setPeriodicWave(getPeriodicWave(ctx, instrument, duty));
  } else {
    osc.type = instrument.wave;
  }
  osc.frequency.value = pitchToFreq(pitch);

  const gain = ctx.createGain();
  const { a, d, s, r } = adsr ? { ...instrument.adsr, ...adsr } : instrument.adsr;
  const peak = instrument.gain * gainMul * (velocity / 127);
  const dur = stopTime - startTime;

  gain.gain.setValueAtTime(0, startTime);
  const attackEnd = startTime + Math.min(a, dur);
  gain.gain.linearRampToValueAtTime(peak, attackEnd);
  let sustainLevel = peak;
  if (d > 0 && s < 1 && attackEnd + d < stopTime) {
    sustainLevel = peak * s;
    gain.gain.linearRampToValueAtTime(sustainLevel, attackEnd + d);
  }
  gain.gain.setValueAtTime(sustainLevel, stopTime);
  gain.gain.linearRampToValueAtTime(0, stopTime + Math.max(r, 0.001));

  let tail = gain;
  if (gainCurve && gainCurve.length >= 2 && dur > 0) {
    const auto = ctx.createGain();
    // setValueCurveAtTime must not overlap ANY other event on this param -
    // it defines the start value itself and holds the final value after.
    auto.gain.setValueCurveAtTime(gainCurve, startTime, dur);
    gain.connect(auto);
    tail = auto;
  }

  osc.connect(gain);
  tail.connect(destination);
  osc.start(startTime);
  osc.stop(stopTime + Math.max(r, 0.001) + 0.001);
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
