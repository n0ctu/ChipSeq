// Automation lane interactions (strip below the roll, poly mode).
// Conventions match interactions.js: 4px arm threshold, window-level drag
// handlers, Esc cancels, effectiveSnap with Alt bypass, commit on mouseup.

import { xToTick, tickToX, effectiveSnap } from './coords.js';
import { snapTick } from '../../core/music.js';
import {
  activeTrack, getLane, setAutomationPoint, deleteAutomationPoint, moveAutomationPoint,
} from '../../core/doc.js';
import { AUTOMATION_PARAMS } from '../../core/automation.js';
import { valueToY, yToValue } from './render.js';

const DRAG_THRESHOLD = 4;
const HIT_PX = 6;
const STORAGE_KEY = 'chipseq.v1.autolane';

export function initAutomationLane({ store, uiStore, canvas }) {
  const ui = uiStore.state;
  const rollArea = document.getElementById('roll-area');
  const toggle = document.getElementById('auto-toggle');
  const paramSel = document.getElementById('auto-param');
  const instPick = document.getElementById('auto-inst-pick');
  let lastCurve = 'linear';
  let drag = null;

  // ---- persistence of fold state + param ----
  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }
  function savePrefs(patch) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
    } catch {}
  }

  const prefs = loadPrefs();
  if (prefs.open) rollArea.classList.add('auto-open');
  if (prefs.param && AUTOMATION_PARAMS[prefs.param]) {
    ui.autoParam = prefs.param;
    paramSel.value = prefs.param;
  }

  function applyChrome() {
    const doc = store.getDoc();
    rollArea.classList.toggle('mono-mode', doc.mode !== 'poly');
    const open = rollArea.classList.contains('auto-open');
    toggle.textContent = open ? 'auto ▾' : 'auto ▸';
    paramSel.hidden = !open;
    instPick.hidden = !open || ui.autoParam !== 'instrument';
    if (!instPick.hidden) {
      const current = instPick.value;
      instPick.innerHTML = doc.instruments
        .map((i) => `<option value="${i.id}"${i.id === current ? ' selected' : ''}>${i.name}</option>`)
        .join('');
    }
  }

  toggle.addEventListener('click', () => {
    rollArea.classList.toggle('auto-open');
    savePrefs({ open: rollArea.classList.contains('auto-open') });
    applyChrome();
    uiStore.update('autolane', () => {});
  });

  paramSel.addEventListener('change', () => {
    uiStore.update('autolane', (s) => {
      s.autoParam = paramSel.value;
    });
    savePrefs({ param: paramSel.value });
    applyChrome();
  });

  store.subscribe(['doc', 'song', 'tracks'], applyChrome);
  applyChrome();

  // ---- hit testing ----
  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, h: rect.height };
  }

  function hitPoint(p) {
    const track = activeTrack(store.getDoc());
    if (!track) return null;
    const lane = getLane(track, ui.autoParam);
    for (const point of lane) {
      const x = tickToX(ui, point.tick);
      if (ui.autoParam === 'instrument') {
        if (Math.abs(p.x - x) <= HIT_PX) return point;
      } else {
        const y = valueToY(p.h, ui.autoParam, point.value);
        if (Math.abs(p.x - x) <= HIT_PX && Math.abs(p.y - y) <= HIT_PX) return point;
      }
    }
    return null;
  }

  function snappedTick(p, e) {
    const snap = e.altKey ? 1 : effectiveSnap(ui);
    return Math.max(0, snapTick(xToTick(ui, p.x), snap || 1));
  }

  // ---- mouse ----
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    if (store.getDoc().mode !== 'poly') return;
    const p = pos(e);
    const param = ui.autoParam;

    if (e.button === 2) {
      const hit = hitPoint(p);
      if (hit) {
        store.commit('delete automation point', ['automation'], (doc) =>
          deleteAutomationPoint(doc, doc.activeTrackId, param, hit.tick)
        );
      }
      return;
    }
    if (e.button !== 0) return;

    const hit = hitPoint(p);
    const tick = snappedTick(p, e);
    let point;
    if (hit) {
      point = { ...hit };
    } else if (param === 'instrument') {
      point = { tick, instrumentId: instPick.value || store.getDoc().instruments[0].id };
    } else {
      point = { tick, value: yToValue(p.h, param, p.y), curve: lastCurve };
    }
    drag = { param, fromTick: hit ? hit.tick : null, point, startX: p.x, startY: p.y, moved: false, isNew: !hit };
    previewDrag(p, e);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey, true);
  });

  canvas.addEventListener('dblclick', (e) => {
    if (store.getDoc().mode !== 'poly') return;
    const p = pos(e);
    const hit = hitPoint(p);
    if (!hit) return;
    const param = ui.autoParam;
    if (param === 'instrument') {
      store.commit('switch automation instrument', ['automation'], (doc) => {
        const ids = doc.instruments.map((i) => i.id);
        const next = ids[(ids.indexOf(hit.instrumentId) + 1) % ids.length];
        setAutomationPoint(doc, doc.activeTrackId, param, { ...hit, instrumentId: next });
      });
    } else {
      const cycle = { step: 'linear', linear: 'ease', ease: 'step' };
      lastCurve = cycle[hit.curve] || 'linear';
      store.commit('set automation curve', ['automation'], (doc) =>
        setAutomationPoint(doc, doc.activeTrackId, param, { ...hit, curve: cycle[hit.curve] || 'linear' })
      );
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (drag) return;
    canvas.style.cursor = hitPoint(pos(e)) ? 'pointer' : 'crosshair';
  });

  function previewDrag(p, e) {
    const track = activeTrack(store.getDoc());
    if (!track) return;
    const lane = getLane(track, drag.param).filter((pt) => pt.tick !== drag.fromTick);
    drag.point.tick = snappedTick(p, e);
    if (drag.param !== 'instrument') drag.point.value = yToValue(p.h, drag.param, p.y);
    const preview = [...lane, { ...drag.point }].sort((a, b) => a.tick - b.tick);
    uiStore.update('autolane', (s) => {
      s.autoDrag = {
        points: preview,
        label:
          drag.param !== 'instrument'
            ? { text: AUTOMATION_PARAMS[drag.param].fmt(drag.point.value), x: p.x, y: p.y }
            : null,
      };
    });
  }

  function onMove(e) {
    if (!drag) return;
    const p = pos(e);
    if (!drag.moved && Math.abs(p.x - drag.startX) < DRAG_THRESHOLD && Math.abs(p.y - drag.startY) < DRAG_THRESHOLD) {
      return;
    }
    drag.moved = true;
    previewDrag(p, e);
  }

  function onUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    endWindowDrag();
    uiStore.update('autolane', (s) => {
      s.autoDrag = null;
    });
    const label = d.isNew ? 'add automation point' : 'move automation point';
    store.commit(label, ['automation'], (doc) => {
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
}
