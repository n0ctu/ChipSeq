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

function getPeriodicWave(ctx, instrument) {
  let byKey = waveCache.get(ctx);
  if (!byKey) {
    byKey = new Map();
    waveCache.set(ctx, byKey);
  }
  const key = instrument.id + ':' + (instrument.duty ?? '') + ':' + (instrument.harmonics ? instrument.harmonics.join(',') : '');
  let wave = byKey.get(key);
  if (!wave) {
    let imag;
    if (instrument.duty != null) {
      imag = dutyHarmonics(instrument.duty);
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
export function scheduleNote(ctx, destination, instrument, { pitch, startTime, stopTime, velocity = 100 }) {
  const osc = ctx.createOscillator();
  if (instrument.wave === 'custom') {
    osc.setPeriodicWave(getPeriodicWave(ctx, instrument));
  } else {
    osc.type = instrument.wave;
  }
  osc.frequency.value = pitchToFreq(pitch);

  const gain = ctx.createGain();
  const { a, d, s, r } = instrument.adsr;
  const peak = instrument.gain * (velocity / 127);
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

  osc.connect(gain).connect(destination);
  osc.start(startTime);
  osc.stop(stopTime + Math.max(r, 0.001) + 0.001);
  return osc;
}

export function getInstrument(doc, instrumentId) {
  return doc.instruments.find((i) => i.id === instrumentId) || doc.instruments[0];
}
