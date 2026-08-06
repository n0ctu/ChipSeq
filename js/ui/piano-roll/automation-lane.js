// Automation lanes (strip below the roll, poly mode): one expandable lane
// per instrument control of the active track - Gain, Attack, Decay, Sustain,
// Release (+ Duty for PWM). Gain starts expanded; collapsed lanes show a
// read-only curve preview and clicking them only expands (never edits).

import { xToTick, tickToX, effectiveSnap, visibleTickRange } from './coords.js';
import { snapTick } from '../../core/music.js';
import { ticksPerBar } from '../../core/doc.js';
import {
  activeTrack, getLane, setAutomationPoint, deleteAutomationPoint, moveAutomationPoint,
} from '../../core/doc.js';
import { getInstrument } from '../../core/instruments.js';
import { AUTOMATION_PARAMS, LANE_ORDER, sampleAutomation } from '../../core/automation.js';
import { HOT_ABOVE, isHot } from '../../core/units.js';
import { readRaw, writeRaw } from '../../core/persist.js';
import { trackColor } from './render.js';

const MASTER_H = 18;
const COLLAPSED_H = 16;
const EXPANDED_H = 60;
const PAD = 6;
const DRAG_THRESHOLD = 4;
const HIT_PX = 6;
const STORAGE_KEY = 'chipseq.v1.autolane';

export function initAutomationLane({ store, uiStore, canvas }) {
  const ui = uiStore.state;
  const rollArea = document.getElementById('roll-area');
  const corner = document.getElementById('auto-corner');
  let drag = null;
  let lastCurve = 'linear';

  // ---- prefs ----
  function loadPrefs() {
    try {
      return JSON.parse(readRaw(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }
  const prefs = loadPrefs();
  let masterOpen = prefs.open !== false; // default open (gain lane visible)
  const expanded = { gain: true, ...(prefs.expanded || {}) };
  function savePrefs() {
    try {
      writeRaw(STORAGE_KEY, JSON.stringify({ open: masterOpen, expanded }));
    } catch {}
  }

  // ---- lane layout ----
  function effectiveInstrument(doc, track) {
    return getInstrument(doc, track.instrument ? 'track:' + track.id : track.instrumentId);
  }

  function laneDefault(doc, track, param) {
    const meta = AUTOMATION_PARAMS[param];
    if (meta.def != null) return meta.def;
    const inst = effectiveInstrument(doc, track);
    if (meta.adsrKey) return inst.adsr[meta.adsrKey];
    if (param === 'duty') return inst.duty ?? 0.25;
    return meta.min;
  }

  // [{param, y, h, expanded}] for the ACTIVE track; empty when hidden.
  function layout() {
    const doc = store.getDoc();
    if (doc.mode !== 'poly') return { lanes: [], totalH: 0, track: null };
    const track = activeTrack(doc);
    if (!track) return { lanes: [], totalH: 0, track: null };
    if (!masterOpen) return { lanes: [], totalH: MASTER_H, track };
    const isPwm = effectiveInstrument(doc, track).wave === 'custom';
    const lanes = [];
    let y = MASTER_H;
    for (const param of LANE_ORDER) {
      if (param === 'duty' && !isPwm) continue;
      const h = expanded[param] ? EXPANDED_H : COLLAPSED_H;
      lanes.push({ param, y, h, expanded: !!expanded[param] });
      y += h;
    }
    return { lanes, totalH: y, track };
  }

  // ---- chrome: grid row height + corner label stack ----
  function updateChrome() {
    const doc = store.getDoc();
    const mono = doc.mode !== 'poly';
    rollArea.classList.toggle('mono-mode', mono);
    const { lanes, totalH, track } = layout();
    const rowH = mono || !track ? 0 : totalH;
    rollArea.style.gridTemplateRows = `20px 28px 1fr ${rowH}px`;

    corner.innerHTML = '';
    if (mono || !track) return;
    const master = document.createElement('button');
    master.type = 'button';
    master.id = 'auto-master';
    master.className = 'auto-lane-btn auto-master-btn';
    master.style.height = MASTER_H + 'px';
    master.textContent = masterOpen ? 'Automation ▾' : 'Automation ▸';
    master.title = 'Automate the active track’s instrument controls over time';
    master.addEventListener('click', () => {
      masterOpen = !masterOpen;
      savePrefs();
      refresh();
    });
    corner.appendChild(master);

    for (const lane of lanes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'auto-lane-btn' + (lane.expanded ? ' expanded' : '');
      btn.dataset.param = lane.param;
      btn.style.height = lane.h + 'px';
      const hasPoints = getLane(track, lane.param).length > 0;
      btn.innerHTML = `${AUTOMATION_PARAMS[lane.param].label}${hasPoints ? ' <span class="auto-dot">●</span>' : ''}`;
      btn.title = (lane.expanded ? 'Collapse' : 'Expand') + ' the ' + AUTOMATION_PARAMS[lane.param].label + ' lane';
      btn.addEventListener('click', () => {
        expanded[lane.param] = !expanded[lane.param];
        savePrefs();
        refresh();
      });
      corner.appendChild(btn);
    }
  }

  function refresh() {
    updateChrome();
    uiStore.update('autolane', () => {});
  }

  store.subscribe(['doc', 'song', 'tracks', 'automation'], updateChrome);
  updateChrome();

  // ---- drawing (called from the piano-roll rAF loop) ----
  const valueToY = (lane, param, v) => {
    const { min, max } = AUTOMATION_PARAMS[param];
    return lane.y + PAD + (1 - (v - min) / (max - min)) * (lane.h - 2 * PAD);
  };
  const yToValue = (lane, param, y) => {
    const { min, max } = AUTOMATION_PARAMS[param];
    const t = 1 - (y - lane.y - PAD) / (lane.h - 2 * PAD);
    return Math.max(min, Math.min(max, min + t * (max - min)));
  };

  function draw(ctx, w, h, theme, playheadTick, playing) {
    ctx.clearRect(0, 0, w, h);
    const doc = store.getDoc();
    const { lanes, track } = layout();
    if (!track || h < 2) return;
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-mono');
    const color = trackColor(theme, doc, track);

    // master strip
    ctx.fillStyle = theme.panel;
    ctx.fillRect(0, 0, w, MASTER_H);
    ctx.fillStyle = theme.line;
    ctx.fillRect(0, 0, w, 1);
    ctx.fillRect(0, MASTER_H - 1, w, 1);

    const { start, end } = visibleTickRange(ui, w);
    const tpBar = ticksPerBar(doc);

    for (const lane of lanes) {
      const meta = AUTOMATION_PARAMS[lane.param];
      const def = laneDefault(doc, track, lane.param);
      const dragging = ui.autoDrag && ui.autoDrag.param === lane.param;
      const points = dragging ? ui.autoDrag.points : getLane(track, lane.param);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, lane.y, w, lane.h);
      ctx.clip();

      // background: expanded lanes on the app bg, collapsed on panel bg
      ctx.fillStyle = lane.expanded ? theme.bg : theme.panel;
      ctx.fillRect(0, lane.y, w, lane.h);
      if (lane.expanded) {
        ctx.fillStyle = theme.gridSub;
        for (let t = Math.max(0, Math.floor(start / tpBar) * tpBar); t <= end; t += tpBar) {
          ctx.fillRect(tickToX(ui, t), lane.y, 1, lane.h);
        }
      }

      // envelope (or dashed baseline when empty)
      if (!points.length) {
        const y = valueToY(lane, lane.param, def);
        ctx.strokeStyle = theme.textDim;
        ctx.globalAlpha = lane.expanded ? 0.8 : 0.4;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        if (lane.expanded) {
          ctx.fillStyle = theme.textDim;
          ctx.font = 'italic 10px ' + font;
          ctx.textBaseline = 'middle';
          ctx.fillText(`${meta.label} ${meta.fmt(def)} - click to add a keyframe`, 8, lane.y + lane.h / 2);
        }
      } else {
        ctx.beginPath();
        const stepPx = 4;
        for (let x = 0; x <= w; x += stepPx) {
          const tick = ui.scrollTick + x / ui.pxPerTick;
          const v = sampleAutomation(points, Math.max(0, tick), def);
          const y = valueToY(lane, lane.param, v);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.globalAlpha = lane.expanded ? 1 : 0.6;
        ctx.lineWidth = lane.expanded ? 1.5 : 1;
        ctx.stroke();
        if (lane.expanded) {
          ctx.lineTo(w, lane.y + lane.h);
          ctx.lineTo(0, lane.y + lane.h);
          ctx.closePath();
          ctx.globalAlpha = 0.12;
          ctx.fillStyle = color;
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        if (lane.expanded) {
          for (const p of points) {
            const x = tickToX(ui, p.tick);
            if (x < -6 || x > w + 6) continue;
            const y = valueToY(lane, lane.param, p.value);
            // a keyframe above unity is deliberate boost - colour it so the
            // reason a mix needs limiting is visible in the lane itself
            ctx.fillStyle = meta.hot && isHot(p.value) ? theme.warn : color;
            ctx.fillRect(x - 3, y - 3, 6, 6);
            ctx.strokeStyle = theme.noteBorder;
            ctx.lineWidth = 1;
            ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
          }
        }
      }

      // Unity reference, drawn ON TOP of the envelope so the curve's fill
      // can't hide it. The gain lane reaches past 100% so a quiet track can
      // be pushed - without a marked unity line "how loud is this?" would be
      // guesswork, since the top of the lane is no longer the nominal maximum.
      if (lane.expanded && meta.hot && meta.max > HOT_ABOVE) {
        const yUnity = valueToY(lane, lane.param, HOT_ABOVE);
        ctx.strokeStyle = theme.textDim;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, yUnity + 0.5);
        ctx.lineTo(w, yUnity + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = theme.textDim;
        ctx.font = '9px ' + font;
        ctx.textBaseline = 'bottom';
        ctx.fillText(meta.fmt(HOT_ABOVE), 4, yUnity - 1);
        ctx.globalAlpha = 1;
      }

      // dragged value label
      if (dragging && ui.autoDrag.label) {
        ctx.fillStyle = meta.hot && isHot(ui.autoDrag.point.value) ? theme.warn : theme.text;
        ctx.font = 'bold 10px ' + font;
        ctx.textBaseline = 'bottom';
        ctx.fillText(ui.autoDrag.label.text, ui.autoDrag.label.x + 8, ui.autoDrag.label.y - 4);
      }

      // lane separator
      ctx.fillStyle = theme.line;
      ctx.fillRect(0, lane.y + lane.h - 1, w, 1);
      ctx.restore();
    }

    // playhead across all lanes
    if (playing) {
      const phX = tickToX(ui, playheadTick);
      if (phX >= -1 && phX <= w + 1) {
        ctx.fillStyle = theme.playhead;
        ctx.fillRect(phX, MASTER_H, 2, h - MASTER_H);
      }
    }
  }

  // ---- interactions ----
  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function laneAt(y) {
    const { lanes } = layout();
    return lanes.find((l) => y >= l.y && y < l.y + l.h) || null;
  }

  function hitPoint(lane, p) {
    const track = activeTrack(store.getDoc());
    if (!track) return null;
    for (const point of getLane(track, lane.param)) {
      const x = tickToX(ui, point.tick);
      const y = valueToY(lane, lane.param, point.value);
      if (Math.abs(p.x - x) <= HIT_PX && Math.abs(p.y - y) <= HIT_PX) return point;
    }
    return null;
  }

  function snappedTick(p, e) {
    const snap = e.altKey ? 1 : effectiveSnap(ui);
    return Math.max(0, snapTick(xToTick(ui, p.x), snap || 1));
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    const doc = store.getDoc();
    if (doc.mode !== 'poly') return;
    const p = pos(e);
    if (p.y < MASTER_H) {
      if (e.button === 0) {
        masterOpen = !masterOpen;
        savePrefs();
        refresh();
      }
      return;
    }
    const lane = laneAt(p.y);
    if (!lane) return;

    // Collapsed lanes are read-only: clicking only expands them.
    if (!lane.expanded) {
      if (e.button === 0) {
        expanded[lane.param] = true;
        savePrefs();
        refresh();
      }
      return;
    }

    if (e.button === 2) {
      const hit = hitPoint(lane, p);
      if (hit) {
        store.commit('delete automation point', ['automation'], (d) =>
          deleteAutomationPoint(d, d.activeTrackId, lane.param, hit.tick)
        );
      }
      return;
    }
    if (e.button !== 0) return;

    const hit = hitPoint(lane, p);
    const tick = snappedTick(p, e);
    const point = hit
      ? { ...hit }
      : { tick, value: yToValue(lane, lane.param, p.y), curve: lastCurve };
    drag = { lane, param: lane.param, fromTick: hit ? hit.tick : null, point, startX: p.x, startY: p.y, isNew: !hit };
    previewDrag(p, e);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey, true);
  });

  canvas.addEventListener('dblclick', (e) => {
    if (store.getDoc().mode !== 'poly') return;
    const p = pos(e);
    const lane = laneAt(p.y);
    if (!lane || !lane.expanded) return;
    const hit = hitPoint(lane, p);
    if (!hit) return;
    const cycle = { step: 'linear', linear: 'ease', ease: 'step' };
    lastCurve = cycle[hit.curve] || 'linear';
    store.commit('set automation curve', ['automation'], (d) =>
      setAutomationPoint(d, d.activeTrackId, lane.param, { ...hit, curve: cycle[hit.curve] || 'linear' })
    );
  });

  canvas.addEventListener('mousemove', (e) => {
    if (drag) return;
    const p = pos(e);
    const lane = laneAt(p.y);
    if (!lane) {
      canvas.style.cursor = 'default';
      return;
    }
    if (!lane.expanded) {
      canvas.style.cursor = 'pointer';
      return;
    }
    canvas.style.cursor = hitPoint(lane, p) ? 'pointer' : 'crosshair';
  });

  function previewDrag(p, e) {
    const track = activeTrack(store.getDoc());
    if (!track || !drag) return;
    const others = getLane(track, drag.param).filter((pt) => pt.tick !== drag.fromTick);
    drag.point.tick = snappedTick(p, e);
    drag.point.value = yToValue(drag.lane, drag.param, p.y);
    const preview = [...others, { ...drag.point }].sort((a, b) => a.tick - b.tick);
    uiStore.update('autolane', (s) => {
      s.autoDrag = {
        param: drag.param,
        points: preview,
        label: { text: AUTOMATION_PARAMS[drag.param].fmt(drag.point.value), x: p.x, y: p.y },
      };
    });
  }

  function onMove(e) {
    if (!drag) return;
    const p = pos(e);
    if (
      drag.isNew ||
      drag.moved ||
      Math.abs(p.x - drag.startX) >= DRAG_THRESHOLD ||
      Math.abs(p.y - drag.startY) >= DRAG_THRESHOLD
    ) {
      drag.moved = true;
      previewDrag(p, e);
    }
  }

  function onUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    endWindowDrag();
    uiStore.update('autolane', (s) => {
      s.autoDrag = null;
    });
    store.commit(d.isNew ? 'add automation point' : 'move automation point', ['automation'], (doc) => {
      if (d.fromTick != null) {
        moveAutomationPoint(doc, doc.activeTrackId, d.param, d.fromTick, { ...d.point });
      } else {
        setAutomationPoint(doc, doc.activeTrackId, d.param, { ...d.point });
      }
    });
  }

  function onKey(e) {
    if (e.key === 'Escape' && drag) {
      e.stopPropagation();
      drag = null;
      endWindowDrag();
      uiStore.update('autolane', (s) => {
        s.autoDrag = null;
      });
    }
  }

  function endWindowDrag() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey, true);
  }

  return { draw };
}
