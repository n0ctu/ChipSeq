// Pure canvas drawing for the piano roll: grid, notes+ghosts, overlay,
// ruler, keys column. No event handling here.

import { tickToX, pitchToY, visibleTickRange, visiblePitchRange, PITCH_MIN, PITCH_MAX } from './coords.js';
import { isInKey, noteName, PITCH_NAMES } from '../../core/music.js';
import { ticksPerBeat, ticksPerBar, getLane } from '../../core/doc.js';
import { AUTOMATION_PARAMS, sampleAutomation } from '../../core/automation.js';

export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    bg: v('--bg-0'),
    panel: v('--bg-1'),
    rowInKey: v('--row-inkey'),
    rowOutKey: v('--row-outkey'),
    rowRoot: v('--row-root'),
    gridBeat: v('--grid-beat'),
    gridBar: v('--grid-bar'),
    gridSub: v('--grid-sub'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    text: v('--text'),
    textDim: v('--text-dim'),
    accent: v('--accent'),
    playhead: v('--playhead'),
    danger: v('--danger'),
    noteBorder: v('--note-border'),
    trackColors: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v('--track-' + i)),
  };
}

export function trackColor(theme, doc, trackId) {
  const idx = doc.tracks.findIndex((t) => t.id === trackId);
  return theme.trackColors[Math.max(0, idx) % theme.trackColors.length];
}

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

export function drawGrid(ctx, ui, doc, w, h, theme, snapTicks) {
  ctx.clearRect(0, 0, w, h);
  const { top, bottom } = visiblePitchRange(ui, h);
  const key = doc.song.key;

  // pitch rows (floor: a fractional scroll value must not detach p from real pitches)
  for (let p = Math.min(Math.floor(top), PITCH_MAX); p >= Math.max(bottom, PITCH_MIN); p--) {
    const y = pitchToY(ui, p);
    if (p % 12 === key.tonic) ctx.fillStyle = theme.rowRoot;
    else if (isInKey(p, key)) ctx.fillStyle = theme.rowInKey;
    else ctx.fillStyle = theme.rowOutKey;
    ctx.fillRect(0, y, w, ui.rowHeight);
  }
  // octave separators (between B and C)
  ctx.fillStyle = theme.line;
  for (let p = Math.min(Math.floor(top), PITCH_MAX); p >= Math.max(bottom, PITCH_MIN); p--) {
    if (p % 12 === 0) ctx.fillRect(0, pitchToY(ui, p) + ui.rowHeight - 0.5, w, 1);
  }

  // vertical time lines
  const { start, end } = visibleTickRange(ui, w);
  const tpb = ticksPerBeat(doc);
  const tpBar = ticksPerBar(doc);
  const sub = snapTicks && snapTicks * ui.pxPerTick > 6 ? snapTicks : 0;

  if (sub) {
    ctx.fillStyle = theme.gridSub;
    for (let t = Math.floor(start / sub) * sub; t <= end; t += sub) {
      if (t % tpb === 0) continue;
      ctx.fillRect(tickToX(ui, t), 0, 1, h);
    }
  }
  ctx.fillStyle = theme.gridBeat;
  for (let t = Math.floor(start / tpb) * tpb; t <= end; t += tpb) {
    if (t % tpBar === 0) continue;
    ctx.fillRect(tickToX(ui, t), 0, 1, h);
  }
  ctx.fillStyle = theme.gridBar;
  for (let t = Math.floor(start / tpBar) * tpBar; t <= end; t += tpBar) {
    ctx.fillRect(tickToX(ui, t), 0, 1, h);
  }
}

function noteRect(ui, ev) {
  return {
    x: tickToX(ui, ev.startTick),
    y: pitchToY(ui, ev.pitch) + 1,
    w: Math.max(2, ev.durationTicks * ui.pxPerTick - 1),
    h: ui.rowHeight - 2,
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// visibleNotes: [{track, note, ghost:[events]}] provided by piano-roll.js
export function drawNotes(ctx, ui, doc, w, h, theme, items, selection, conflictIds) {
  ctx.clearRect(0, 0, w, h);
  const monoFont = getComputedStyle(document.documentElement).getPropertyValue('--font-mono');

  // ghosts first (under real notes)
  for (const item of items) {
    if (!item.ghost) continue;
    const color = trackColor(theme, doc, item.track.id);
    const selected = selection.has(item.note.id);
    ctx.globalAlpha = selected ? 0.45 : 0.25;
    ctx.fillStyle = color;
    for (const ev of item.ghost) {
      const r = noteRect(ui, ev);
      roundRect(ctx, r.x, r.y, r.w, r.h, 2);
      ctx.fill();
    }
    ctx.globalAlpha = selected ? 0.7 : 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (const ev of item.ghost) {
      const r = noteRect(ui, ev);
      roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // real notes
  for (const item of items) {
    const { note, track } = item;
    const r = noteRect(ui, note);
    const color = trackColor(theme, doc, track.id);
    const isConflict = conflictIds && conflictIds.has(note.id);
    const isActiveTrack = track.id === doc.activeTrackId;
    const dimmed = doc.mode === 'poly' && !isActiveTrack;

    ctx.globalAlpha = dimmed ? 0.45 : 1;
    ctx.fillStyle = isConflict ? theme.danger : color;
    roundRect(ctx, r.x, r.y, r.w, r.h, 2);
    ctx.fill();

    // contrast border (themable) so note boundaries stay visible, e.g.
    // repeated same-pitch notes in a row
    ctx.strokeStyle = theme.noteBorder;
    ctx.lineWidth = 1;
    roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 2);
    ctx.stroke();

    if (isConflict) {
      // diagonal hatch
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1.5;
      for (let hx = r.x - r.h; hx < r.x + r.w; hx += 5) {
        ctx.beginPath();
        ctx.moveTo(hx, r.y + r.h);
        ctx.lineTo(hx + r.h, r.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (selection.has(note.id)) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      roundRect(ctx, r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5, 2);
      ctx.stroke();
    }

    // left-bounded pitch label (when there's room for it)
    if (r.w >= 24 && ui.rowHeight >= 10) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x + 1, r.y, r.w - (note.harmonics ? 14 : 2), r.h);
      ctx.clip();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.font = '9px ' + monoFont;
      ctx.textBaseline = 'middle';
      ctx.fillText(noteName(note.pitch), r.x + 3, r.y + r.h / 2 + 0.5);
      ctx.restore();
    }

    // "has arp" glyph: three ascending dots top-right
    if (note.harmonics && r.w > 16) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const gx = r.x + r.w - 12;
      const gy = r.y + r.h / 2;
      ctx.fillRect(gx, gy + 2, 2, 2);
      ctx.fillRect(gx + 4, gy, 2, 2);
      ctx.fillRect(gx + 8, gy - 2, 2, 2);
    }
  }
  ctx.globalAlpha = 1;
}

// overlay: playhead, grid cursor, marquee, drag preview
export function drawOverlay(ctx, ui, doc, w, h, theme, o) {
  ctx.clearRect(0, 0, w, h);

  // loop region shading
  if (o.loop) {
    const x1 = tickToX(ui, o.loop.startTick);
    const x2 = tickToX(ui, o.loop.endTick);
    ctx.fillStyle = 'rgba(74, 222, 128, 0.06)';
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  // grid cursor cell
  if (o.gridCursor && !o.playing) {
    const g = o.gridCursor;
    const x = tickToX(ui, g.tick);
    const y = pitchToY(ui, g.pitch);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(4, (o.snapTicks || 24) * ui.pxPerTick) - 1, ui.rowHeight - 1);
    ctx.setLineDash([]);
  }

  // drag preview rects
  if (o.dragPreview) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    for (const ev of o.dragPreview) {
      const r = noteRect(ui, ev);
      roundRect(ctx, r.x, r.y, r.w, r.h, 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // marquee
  if (o.marquee) {
    const m = o.marquee;
    ctx.fillStyle = 'rgba(74, 222, 128, 0.1)';
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1;
    const x = Math.min(m.x1, m.x2);
    const y = Math.min(m.y1, m.y2);
    ctx.fillRect(x, y, Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1));
    ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1));
  }

  // placed-cursor (origin) marker: dashed accent line, distinct from the playhead
  if (o.originTick != null && o.originTick !== o.playheadTick) {
    const ox = tickToX(ui, o.originTick);
    if (ox >= -1 && ox <= w + 1) {
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(ox + 0.5, 0);
      ctx.lineTo(ox + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // playhead / cursor line
  const phX = tickToX(ui, o.playheadTick);
  if (phX >= -1 && phX <= w + 1) {
    ctx.fillStyle = theme.playhead;
    ctx.fillRect(phX, 0, o.playing ? 2 : 1, h);
  }
}

export function drawRuler(ctx, ui, doc, w, h, theme, o) {
  ctx.fillStyle = theme.panel;
  ctx.fillRect(0, 0, w, h);
  const { start, end } = visibleTickRange(ui, w);
  const tpb = ticksPerBeat(doc);
  const tpBar = ticksPerBar(doc);

  // loop region
  if (o.loop) {
    const x1 = tickToX(ui, o.loop.startTick);
    const x2 = tickToX(ui, o.loop.endTick);
    ctx.fillStyle = 'rgba(74, 222, 128, 0.25)';
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  ctx.fillStyle = theme.gridBeat;
  for (let t = Math.floor(start / tpb) * tpb; t <= end; t += tpb) {
    if (t % tpBar === 0) continue;
    ctx.fillRect(tickToX(ui, t), h - 7, 1, 7);
  }
  ctx.fillStyle = theme.textDim;
  ctx.font = '10px ' + getComputedStyle(document.documentElement).getPropertyValue('--font-mono');
  ctx.textBaseline = 'top';
  for (let t = Math.max(0, Math.floor(start / tpBar) * tpBar); t <= end; t += tpBar) {
    const x = tickToX(ui, t);
    ctx.fillStyle = theme.lineStrong;
    ctx.fillRect(x, 0, 1, h);
    ctx.fillStyle = theme.textDim;
    ctx.fillText(String(Math.floor(t / tpBar) + 1), x + 4, 3);
  }

  // conflict markers
  if (o.conflictTicks) {
    ctx.fillStyle = theme.danger;
    for (const t of o.conflictTicks) {
      ctx.fillRect(tickToX(ui, t) - 1, h - 4, 3, 4);
    }
  }

  // placed-cursor (origin) caret: hollow green triangle
  if (o.originTick != null) {
    const ox = tickToX(ui, o.originTick);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ox - 4.5, 1);
    ctx.lineTo(ox + 4.5, 1);
    ctx.lineTo(ox, 8);
    ctx.closePath();
    ctx.stroke();
  }

  // playhead caret
  const phX = tickToX(ui, o.playheadTick);
  ctx.fillStyle = theme.playhead;
  ctx.beginPath();
  ctx.moveTo(phX - 5, 0);
  ctx.lineTo(phX + 5, 0);
  ctx.lineTo(phX, 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(phX, 0, 1, h);

  ctx.fillStyle = theme.line;
  ctx.fillRect(0, h - 1, w, 1);
}

// Chord lane above the ruler: analyzed chord events, each held until the
// next (labels come pre-computed as {startTick, name}).
export function drawChordLane(ctx, ui, doc, w, h, theme, chords) {
  ctx.fillStyle = theme.panel;
  ctx.fillRect(0, 0, w, h);
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font-mono');

  if (!chords.length) {
    ctx.fillStyle = theme.textDim;
    ctx.font = 'italic 10px ' + font;
    ctx.textBaseline = 'middle';
    ctx.fillText('no chords track — right-click a track to set one', 8, h / 2);
    ctx.fillStyle = theme.line;
    ctx.fillRect(0, h - 1, w, 1);
    return;
  }

  ctx.font = 'bold 11px ' + font;
  ctx.textBaseline = 'middle';
  for (let i = 0; i < chords.length; i++) {
    const ev = chords[i];
    const endTick = chords[i + 1] ? chords[i + 1].startTick : Infinity;
    const x1 = Math.max(-1, tickToX(ui, ev.startTick));
    const x2 = endTick === Infinity ? w + 1 : Math.min(w + 1, tickToX(ui, endTick));
    if (x2 < 0 || x1 > w) continue;
    // alternating tinted blocks so boundaries read even without labels
    ctx.fillStyle = theme.accent;
    ctx.globalAlpha = i % 2 ? 0.1 : 0.16;
    ctx.fillRect(x1, 0, x2 - x1, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x1, 0, 1, h);
    const label = ev.name || '';
    if (label && x2 - x1 > 14) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1 + 2, 0, x2 - x1 - 4, h);
      ctx.clip();
      ctx.fillStyle = theme.text;
      ctx.fillText(label, x1 + 5, h / 2 + 0.5);
      ctx.restore();
    }
  }
  ctx.fillStyle = theme.line;
  ctx.fillRect(0, h - 1, w, 1);
}

// ---- automation lane (strip below the roll, poly mode) ----

const LANE_PAD = 6;

export function valueToY(h, param, v) {
  const { min, max } = AUTOMATION_PARAMS[param];
  return LANE_PAD + (1 - (v - min) / (max - min)) * (h - 2 * LANE_PAD);
}

export function yToValue(h, param, y) {
  const { min, max } = AUTOMATION_PARAMS[param];
  const t = 1 - (y - LANE_PAD) / (h - 2 * LANE_PAD);
  return Math.max(min, Math.min(max, min + t * (max - min)));
}

// o: { param, track, drag (preview lane|null), playheadTick, playing,
//      defaultValue, instrumentName(id)->string }
export function drawAutomationLane(ctx, ui, doc, w, h, theme, o) {
  ctx.fillStyle = theme.panel;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = theme.line;
  ctx.fillRect(0, 0, w, 1);
  if (!o.track || h < 30) return; // collapsed: header row only
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font-mono');

  // faint bar lines
  const { start, end } = visibleTickRange(ui, w);
  const tpBar = ticksPerBar(doc);
  ctx.fillStyle = theme.gridSub;
  for (let t = Math.max(0, Math.floor(start / tpBar) * tpBar); t <= end; t += tpBar) {
    ctx.fillRect(tickToX(ui, t), 0, 1, h);
  }

  const points = o.drag || getLane(o.track, o.param);
  const color = trackColor(theme, doc, o.track.id);

  if (o.param === 'instrument') {
    // labeled step blocks, chord-lane style
    ctx.font = 'bold 10px ' + font;
    ctx.textBaseline = 'middle';
    if (!points.length) {
      ctx.fillStyle = theme.textDim;
      ctx.font = 'italic 10px ' + font;
      ctx.fillText(`no switches — always “${o.instrumentName(null)}” · click to add`, 8, h / 2);
    }
    for (let i = -1; i < points.length; i++) {
      const from = i < 0 ? 0 : points[i].tick;
      const to = points[i + 1] ? points[i + 1].tick : Infinity;
      const x1 = Math.max(-1, tickToX(ui, from));
      const x2 = to === Infinity ? w + 1 : Math.min(w + 1, tickToX(ui, to));
      if (x2 < 0 || x1 > w || (i < 0 && !points.length)) continue;
      const label = i < 0 ? o.instrumentName(null) : o.instrumentName(points[i].instrumentId);
      ctx.globalAlpha = i < 0 ? 0.06 : i % 2 ? 0.12 : 0.2;
      ctx.fillStyle = color;
      ctx.fillRect(x1, 1, x2 - x1, h - 1);
      ctx.globalAlpha = 1;
      if (i >= 0) {
        ctx.fillStyle = color;
        ctx.fillRect(x1, 1, 1, h - 1);
      }
      if (label && x2 - x1 > 16) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x1 + 2, 0, x2 - x1 - 4, h);
        ctx.clip();
        ctx.fillStyle = i < 0 ? theme.textDim : theme.text;
        ctx.fillText(label, x1 + 5, h / 2 + 0.5);
        ctx.restore();
      }
    }
  } else {
    // envelope polyline for gain / duty
    const def = o.defaultValue;
    if (!points.length) {
      if (def != null) {
        const y = valueToY(h, o.param, def);
        ctx.strokeStyle = theme.textDim;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = theme.textDim;
      ctx.font = 'italic 10px ' + font;
      ctx.textBaseline = 'middle';
      ctx.fillText('click to add a keyframe — double-click a point cycles its curve, right-click deletes', 8, h / 2);
      if (o.hint) ctx.fillText(o.hint, 8, h / 2 + 13);
      return;
    }

    // build the polyline by sampling (handles all curve types uniformly)
    const startTick = Math.max(0, ui.scrollTick);
    const endTick = ui.scrollTick + w / ui.pxPerTick;
    ctx.beginPath();
    const firstVal = sampleAutomation(points, startTick, def ?? points[0].value);
    ctx.moveTo(tickToX(ui, startTick), valueToY(h, o.param, firstVal));
    const stepPx = 4;
    for (let x = tickToX(ui, startTick) + stepPx; x <= tickToX(ui, Math.min(endTick, 1e9)); x += stepPx) {
      const tick = ui.scrollTick + x / ui.pxPerTick;
      const v = sampleAutomation(points, tick, def ?? points[0].value);
      ctx.lineTo(x, valueToY(h, o.param, v));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // area fill
    ctx.lineTo(tickToX(ui, endTick), h);
    ctx.lineTo(tickToX(ui, startTick), h);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;

    // points
    for (const p of points) {
      const x = tickToX(ui, p.tick);
      if (x < -6 || x > w + 6) continue;
      const y = valueToY(h, o.param, p.value);
      ctx.fillStyle = color;
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.strokeStyle = theme.noteBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    }

    // dragged-value label
    if (o.drag && o.dragLabel) {
      ctx.fillStyle = theme.text;
      ctx.font = 'bold 10px ' + font;
      ctx.textBaseline = 'bottom';
      ctx.fillText(o.dragLabel.text, o.dragLabel.x + 8, o.dragLabel.y - 4);
    }
    if (o.hint) {
      ctx.fillStyle = theme.textDim;
      ctx.font = 'italic 10px ' + font;
      ctx.textBaseline = 'top';
      ctx.fillText(o.hint, 8, 3);
    }
  }

  // playhead
  if (o.playing) {
    const phX = tickToX(ui, o.playheadTick);
    if (phX >= -1 && phX <= w + 1) {
      ctx.fillStyle = theme.playhead;
      ctx.fillRect(phX, 0, 2, h);
    }
  }
}

export function drawKeys(ctx, ui, doc, w, h, theme) {
  ctx.fillStyle = theme.panel;
  ctx.fillRect(0, 0, w, h);
  const { top, bottom } = visiblePitchRange(ui, h);
  ctx.font = '9px ' + getComputedStyle(document.documentElement).getPropertyValue('--font-mono');
  ctx.textBaseline = 'middle';

  for (let p = Math.min(Math.floor(top), PITCH_MAX); p >= Math.max(bottom, PITCH_MIN); p--) {
    const y = pitchToY(ui, p);
    const pc = p % 12;
    const black = BLACK_KEYS.has(pc);
    ctx.fillStyle = black ? '#0c0d0f' : '#e8eaed';
    ctx.fillRect(0, y + 0.5, w - 4, ui.rowHeight - 1);
    if (pc === 0) {
      ctx.fillStyle = black ? theme.textDim : '#555';
      ctx.fillText(noteName(p), w - 26, y + ui.rowHeight / 2);
    }
    if (pc === 11 || pc === 4) {
      ctx.fillStyle = theme.line;
      ctx.fillRect(0, y, w - 4, 1);
    }
  }
  ctx.fillStyle = theme.line;
  ctx.fillRect(w - 1, 0, 1, h);
}

export { PITCH_NAMES };
