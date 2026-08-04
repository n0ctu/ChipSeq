// Music theory helpers. Pitch = MIDI note number (0-127), time = integer ticks.

export const PPQ = 96;

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Arduino pitches.h style names (sharps written as S)
export const PITCH_SYMBOLS = ['C', 'CS', 'D', 'DS', 'E', 'F', 'FS', 'G', 'GS', 'A', 'AS', 'B'];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

// MIDI 60 = C4 (matches Arduino pitches.h octave numbering)
export function noteName(pitch) {
  return PITCH_NAMES[pitch % 12] + (Math.floor(pitch / 12) - 1);
}

export function pitchToFreq(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

export function keyName(key) {
  return PITCH_NAMES[key.tonic] + ' ' + key.mode;
}

export function keyPitchClasses(key) {
  return SCALES[key.mode].map((iv) => (key.tonic + iv) % 12);
}

export function isInKey(pitch, key) {
  return keyPitchClasses(key).includes(pitch % 12);
}

// Scale degree (0-6) of pitch in key, or -1 if chromatic.
export function scaleDegree(pitch, key) {
  return keyPitchClasses(key).indexOf(pitch % 12);
}

// Diatonic triad intervals (semitones above pitch) for the pitch's degree in key.
// Returns null if the pitch is chromatic (not in the scale).
export function diatonicTriadIntervals(pitch, key) {
  const deg = scaleDegree(pitch, key);
  if (deg < 0) return null;
  const scale = SCALES[key.mode];
  const third = (scale[(deg + 2) % 7] - scale[deg] + 12) % 12;
  const fifth = (scale[(deg + 4) % 7] - scale[deg] + 12) % 12;
  return [0, third, fifth];
}

export function snapTick(tick, gridTicks) {
  if (!gridTicks || gridTicks <= 1) return Math.round(tick);
  return Math.round(tick / gridTicks) * gridTicks;
}

export function snapTickFloor(tick, gridTicks) {
  if (!gridTicks || gridTicks <= 1) return Math.floor(tick);
  return Math.floor(tick / gridTicks) * gridTicks;
}

// Chord naming: match a set of pitch classes against common qualities.
// Returns e.g. "Am", "C", "G7", "A5", "Dsus4" — or a raw pc list if unknown.
const CHORD_QUALITIES = [
  { name: '', pcs: [0, 4, 7] },
  { name: 'm', pcs: [0, 3, 7] },
  { name: 'dim', pcs: [0, 3, 6] },
  { name: 'aug', pcs: [0, 4, 8] },
  { name: 'sus2', pcs: [0, 2, 7] },
  { name: 'sus4', pcs: [0, 5, 7] },
  { name: '7', pcs: [0, 4, 7, 10] },
  { name: 'maj7', pcs: [0, 4, 7, 11] },
  { name: 'm7', pcs: [0, 3, 7, 10] },
  { name: 'm7b5', pcs: [0, 3, 6, 10] },
  { name: '6', pcs: [0, 4, 7, 9] },
  { name: 'm6', pcs: [0, 3, 7, 9] },
  { name: '5', pcs: [0, 7] },
];

export function chordName(pcs) {
  if (!pcs || !pcs.length) return null;
  const set = new Set(pcs.map((p) => ((p % 12) + 12) % 12));
  if (set.size === 1) return PITCH_NAMES[[...set][0]];
  for (const root of set) {
    for (const q of CHORD_QUALITIES) {
      if (q.pcs.length !== set.size) continue;
      if (q.pcs.every((iv) => set.has((root + iv) % 12))) {
        return PITCH_NAMES[root] + q.name;
      }
    }
  }
  return [...set].sort((a, b) => a - b).map((p) => PITCH_NAMES[p]).join('·');
}

// Key detection from note content (Krumhansl-Schmuckler profile matching).
// Used when a MIDI file carries no key-signature meta event, and by the
// toolbar's "detect key" button. Returns {tonic, mode, confidence} or null.
const KEY_PROFILES = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};

export function detectKey(notes) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[n.pitch % 12] += n.durationTicks;
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const histMean = mean(hist);
  let best = null;
  for (const mode of ['major', 'minor']) {
    const profile = KEY_PROFILES[mode];
    const profMean = mean(profile);
    for (let tonic = 0; tonic < 12; tonic++) {
      // Pearson correlation between the duration-weighted pitch-class
      // histogram and the profile rotated to this tonic.
      let num = 0;
      let dh = 0;
      let dp = 0;
      for (let i = 0; i < 12; i++) {
        const h = hist[(tonic + i) % 12] - histMean;
        const p = profile[i] - profMean;
        num += h * p;
        dh += h * h;
        dp += p * p;
      }
      const r = dh && dp ? num / Math.sqrt(dh * dp) : 0;
      if (!best || r > best.confidence) best = { tonic, mode, confidence: r };
    }
  }
  return best;
}

// Deterministic PRNG for the "random" arp pattern.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
