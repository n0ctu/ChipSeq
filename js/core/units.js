// How stored values are shown to humans.
//
// Levels are stored as linear gain multipliers - 0.35, 0.5, 1 - which say
// nothing about how loud that is or where clipping starts. Everything the
// user sees goes through here instead, so a level reads as a percentage
// where 0% is silence and 100% is unity: the nominal maximum, and exactly
// the point above which the master limiter starts working (see graph.js).
//
// Above 100% is allowed rather than forbidden - boosting a quiet track is
// legitimate, and the limiter guarantees the result still cannot clip - but
// it is flagged, because that is where a mix starts needing help to fit.
//
// Formatters are looked up by name (a param declares display: 'percent') so
// offering dB or raw values later is a table edit, not a refactor. There is
// deliberately no user-facing unit switch yet.

// Unity. A value above this is "hot": audible, intentional, worth flagging.
export const HOT_ABOVE = 1;

export const toPercent = (v) => v * 100;
export const fromPercent = (p) => p / 100;

export function isHot(v) {
  return v > HOT_ABOVE + 1e-9;
}

export function formatPercent(v) {
  return Math.round(toPercent(v)) + '%';
}

// Sub-second values read better in milliseconds; anything longer in seconds.
export function formatSeconds(v) {
  return v >= 0.1 ? v.toFixed(2) + ' s' : Math.round(v * 1000) + ' ms';
}

export function formatRaw(v) {
  return String(Math.round(v * 1000) / 1000);
}

export const DISPLAY = {
  percent: formatPercent,
  seconds: formatSeconds,
  raw: formatRaw,
};

// Resolve a display descriptor to its formatter, falling back to raw so an
// unknown name degrades to a readable number instead of throwing.
export function formatter(display) {
  return DISPLAY[display] || formatRaw;
}
