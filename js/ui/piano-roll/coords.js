// All tick/pitch <-> pixel math for the piano roll. Pure functions over
// (uiState, viewport size).

export const PITCH_MIN = 12; // C0
export const PITCH_MAX = 119; // B8

export function tickToX(ui, tick) {
  return (tick - ui.scrollTick) * ui.pxPerTick;
}

export function xToTick(ui, x) {
  return x / ui.pxPerTick + ui.scrollTick;
}

// scrollPitch = pitch rendered at the top edge; rows go downward.
export function pitchToY(ui, pitch) {
  return (ui.scrollPitch - pitch) * ui.rowHeight;
}

// Row for pitch p spans y in [(scrollPitch - p) * rowHeight, +rowHeight),
// so the inverse is a plain floor - anything else is off by one for part
// of the row.
export function yToPitch(ui, y) {
  return Math.floor(ui.scrollPitch) - Math.floor(y / ui.rowHeight);
}

export function visibleTickRange(ui, widthPx) {
  return { start: ui.scrollTick, end: ui.scrollTick + widthPx / ui.pxPerTick };
}

export function visiblePitchRange(ui, heightPx) {
  const top = ui.scrollPitch;
  const bottom = Math.floor(ui.scrollPitch - heightPx / ui.rowHeight);
  return { top, bottom };
}

// Where the view wants to sit so the playhead is anchored a third of the way
// across. Pure, and deliberately UNclamped: every phase of following comes from
// pairing it with clampScroll, so this must be free to return a position off
// either end.
//
//   before the anchor  a negative result, which the clamp pins to 0, so the
//                      playhead travels across an unmoving grid
//   after it           the grid scrolls and the playhead holds still
//   past the last page the clamp pins the scroll, so the playhead travels on
//
export const FOLLOW_ANCHOR = 1 / 3;

export function followScroll(ui, playheadTick, widthPx) {
  return playheadTick - (widthPx * FOLLOW_ANCHOR) / ui.pxPerTick;
}

export function clampScroll(ui, widthPx, heightPx, songEnd) {
  const maxTick = Math.max(songEnd + 4 * 96 * 4, widthPx / ui.pxPerTick + 96 * 16);
  ui.scrollTick = Math.max(0, Math.min(ui.scrollTick, maxTick - widthPx / ui.pxPerTick));
  // Keep scrollPitch integral: fractional values shift every row off its
  // pitch, breaking p % 12 checks (black keys, in-key tinting).
  const visibleRows = Math.ceil(heightPx / ui.rowHeight);
  ui.scrollPitch = Math.max(PITCH_MIN + visibleRows - 1, Math.min(Math.round(ui.scrollPitch), PITCH_MAX));
}

// Effective snap grid in ticks; triplet divides the straight value by 1.5.
export function effectiveSnap(ui) {
  if (!ui.snapTicks) return 0;
  return ui.triplet ? Math.round((ui.snapTicks * 2) / 3) : ui.snapTicks;
}
