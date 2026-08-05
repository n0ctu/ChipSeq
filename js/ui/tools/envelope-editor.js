// The envelope canvas in the Instrument tool.
//
// It draws and edits the SAME shape the four ADSR sliders drive - there is
// one envelope, two ways to reach it. While the shape is still ADSR-shaped
// the sliders stay live; the moment a point is dragged somewhere they cannot
// express, the envelope is stored explicitly on the instrument and the
// sliders grey out rather than rounding the curve back to four numbers.
//
// Time is drawn on a square-root scale. A 2 ms attack and a 2 s release want
// to be visible in the same 120 px, and a linear axis gives the attack a
// third of a pixel.

import { sampleEnvelope, releaseTime, isAdsrShaped } from '../../core/modulation.js';

const PAD_X = 6;
const PAD_Y = 8;
const HIT_PX = 7;
const MIN_SPAN_S = 0.4; // never zoom in so far that a short envelope fills the box

// Sustain is drawn as a held segment of this width, so the shape reads like a
// note being held rather than a spike with a tail.
const SUSTAIN_FRACTION = 0.25;

export function initEnvelopeEditor(canvas, { getEnv, onChange, onCommit }) {
  const ctx = canvas.getContext('2d');
  let drag = null;
  let hover = -1;

  const theme = () => {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue('--bg-0').trim(),
      line: cs.getPropertyValue('--line').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
      dim: cs.getPropertyValue('--text-dim').trim(),
      border: cs.getPropertyValue('--note-border').trim(),
    };
  };

  // ---- geometry ----
  // The x axis is split: [0 .. sustain) is attack+decay, then a held stretch,
  // then the release. Points therefore map to x by which stage they are in.
  function layout(env) {
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    const si = Math.min(env.sustainIndex, env.points.length - 1);
    const preSpan = Math.max(MIN_SPAN_S, env.points[si].t);
    const relSpan = Math.max(MIN_SPAN_S, releaseTime(env));
    const usable = w - PAD_X * 2;
    const holdW = usable * SUSTAIN_FRACTION;
    const preW = (usable - holdW) * (preSpan / (preSpan + relSpan));
    const relW = usable - holdW - preW;
    return { w, h, si, preSpan, relSpan, preW, holdW, relW, usable };
  }

  const root = (v, span) => (span > 0 ? Math.sqrt(Math.max(0, v) / span) : 0);
  const unroot = (u, span) => u * u * span;

  function pointXY(env, i, L) {
    const y = PAD_Y + (1 - env.points[i].value) * (L.h - PAD_Y * 2);
    if (i <= L.si) return { x: PAD_X + root(env.points[i].t, L.preSpan) * L.preW, y };
    return { x: PAD_X + L.preW + L.holdW + root(env.points[i].t, L.relSpan) * L.relW, y };
  }

  function xyToPoint(env, i, L, px, py) {
    const value = Math.min(1, Math.max(0, 1 - (py - PAD_Y) / (L.h - PAD_Y * 2)));
    let t;
    if (i <= L.si) {
      t = unroot(Math.min(1, Math.max(0, (px - PAD_X) / L.preW)), L.preSpan);
    } else {
      t = unroot(Math.min(1, Math.max(0, (px - PAD_X - L.preW - L.holdW) / L.relW)), L.relSpan);
    }
    return { t: Math.round(t * 1e4) / 1e4, value: Math.round(value * 1e4) / 1e4 };
  }

  function hitTest(env, L, px, py) {
    for (let i = 0; i < env.points.length; i++) {
      const p = pointXY(env, i, L);
      if (Math.abs(p.x - px) <= HIT_PX && Math.abs(p.y - py) <= HIT_PX) return i;
    }
    return -1;
  }

  // ---- drawing ----
  function draw() {
    const env = getEnv();
    if (!env) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width && (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr))) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const t = theme();
    const L = layout(env);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, L.w, L.h);

    // the held stretch, so it is obvious which part lasts as long as the note
    ctx.fillStyle = t.line;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(PAD_X + L.preW, 0, L.holdW, L.h);
    ctx.globalAlpha = 1;

    // the shape itself, sampled through the same function the audio uses -
    // what you see is what the voice will do, not an idealised drawing
    const holdSec = L.preSpan;
    ctx.beginPath();
    for (let px = 0; px <= L.usable; px++) {
      const x = PAD_X + px;
      let tSec;
      if (px <= L.preW) tSec = unroot(px / L.preW, L.preSpan);
      else if (px <= L.preW + L.holdW) tSec = L.preSpan;
      else tSec = holdSec + unroot((px - L.preW - L.holdW) / L.relW, L.relSpan);
      const v = sampleEnvelope(env, tSec, holdSec);
      const y = PAD_Y + (1 - v) * (L.h - PAD_Y * 2);
      px === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(PAD_X + L.usable, L.h);
    ctx.lineTo(PAD_X, L.h);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = t.accent;
    ctx.fill();
    ctx.globalAlpha = 1;

    for (let i = 0; i < env.points.length; i++) {
      const p = pointXY(env, i, L);
      ctx.fillStyle = i === hover || (drag && drag.index === i) ? t.accent : t.dim;
      ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      ctx.strokeStyle = t.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
    }
  }

  // ---- interaction ----
  const localXY = (e) => {
    const r = canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  function edited(env) {
    onChange(env);
    draw();
  }

  canvas.addEventListener('mousedown', (e) => {
    const env = getEnv();
    if (!env) return;
    const L = layout(env);
    const { px, py } = localXY(e);
    const index = hitTest(env, L, px, py);

    if (e.button === 2) {
      e.preventDefault();
      // The four ADSR stages are structural - removing one would leave a
      // shape the model has no name for. Only added points can go.
      if (index > 0 && index !== L.si && env.points.length > 4) {
        const next = { ...env, points: env.points.filter((_, i) => i !== index) };
        if (index < env.sustainIndex) next.sustainIndex = env.sustainIndex - 1;
        edited(next);
        onCommit(next);
      }
      return;
    }
    if (index < 0) return;
    drag = { index, moved: false };
    e.preventDefault();
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousemove', (e) => {
    const env = getEnv();
    if (!env) return;
    const L = layout(env);
    const { px, py } = localXY(e);
    if (!drag) {
      const h = hitTest(env, L, px, py);
      if (h !== hover) {
        hover = h;
        canvas.style.cursor = h >= 0 ? 'grab' : 'default';
        draw();
      }
      return;
    }
    drag.moved = true;
    const i = drag.index;
    const moved = xyToPoint(env, i, L, px, py);
    const points = env.points.map((p, k) => (k === i ? { ...p, ...moved } : p));
    // The first point anchors the envelope at silence; the last must end
    // there too, or a voice would never stop.
    if (i === 0) points[0] = { ...points[0], t: 0, value: 0 };
    if (i === points.length - 1) points[i] = { ...points[i], value: 0 };
    // Keep each stage's points in order, so the shape stays readable.
    const si = env.sustainIndex;
    if (i > 0 && i <= si) points[i].t = Math.max(points[i].t, points[i - 1].t);
    if (i < si) points[i].t = Math.min(points[i].t, points[i + 1].t);
    edited({ ...env, points });
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const wasMoved = drag.moved;
    drag = null;
    draw();
    if (wasMoved) onCommit(getEnv());
  });

  // Double-click adds a point to the decay stage - the only stage where a
  // free shape means anything before release.
  canvas.addEventListener('dblclick', (e) => {
    const env = getEnv();
    if (!env) return;
    const L = layout(env);
    const { px, py } = localXY(e);
    if (hitTest(env, L, px, py) >= 0) return;
    const at = xyToPoint(env, L.si, L, px, py);
    const si = env.sustainIndex;
    if (at.t <= env.points[0].t || at.t >= env.points[si].t) return;
    const points = [...env.points];
    let insert = 1;
    while (insert < si && points[insert].t < at.t) insert++;
    points.splice(insert, 0, { t: at.t, value: at.value, curve: 'linear' });
    const next = { ...env, points, sustainIndex: si + 1 };
    edited(next);
    onCommit(next);
  });

  draw();
  return { draw, isDrawn: () => !isAdsrShaped(getEnv()) };
}
