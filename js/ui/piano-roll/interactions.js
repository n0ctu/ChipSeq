// Mouse interaction state machine for the piano roll + ruler + keys column.
// idle -> armed -> {marquee, move, resizeL, resizeR, erase}; Esc cancels.

import { xToTick, yToPitch, tickToX, effectiveSnap, PITCH_MIN, PITCH_MAX } from './coords.js';
import { snapTickFloor, snapTick } from '../../core/music.js';
import {
  createNote, addNote, deleteNotes, updateNotes, getTrack, activeTrack,
  ticksPerBeat, ticksPerBar,
} from '../../core/doc.js';
import { contextMenu } from '../dialogs.js';
import { trimBeforeAction, trimAfterAction } from '../trimmer.js';

const DRAG_THRESHOLD = 4;
const EDGE_PX = 5;

export function attachInteractions({ store, uiStore, engine, canvases, roll }) {
  const overlay = canvases.overlay;
  const ui = uiStore.state;
  let drag = null; // active drag descriptor

  function pos(e) {
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y, tick: xToTick(ui, x), pitch: yToPitch(ui, y) };
  }

  function hitTest(x, y) {
    const doc = store.getDoc();
    const pitch = yToPitch(ui, y);
    const tryTrack = (track) => {
      for (let i = track.notes.length - 1; i >= 0; i--) {
        const n = track.notes[i];
        if (n.pitch !== pitch) continue;
        const x1 = tickToX(ui, n.startTick);
        const x2 = tickToX(ui, n.startTick + n.durationTicks);
        if (x < x1 - 1 || x > x2 + 1) continue;
        let zone = 'body';
        if (x2 - x1 > EDGE_PX * 3) {
          if (x - x1 <= EDGE_PX) zone = 'left';
          else if (x2 - x <= EDGE_PX) zone = 'right';
        }
        return { track, note: n, zone };
      }
      return null;
    };
    const act = activeTrack(doc);
    if (act) {
      const hit = tryTrack(act);
      if (hit) return hit;
    }
    if (doc.mode === 'poly') {
      for (const track of doc.tracks) {
        if (track.id === doc.activeTrackId || track.role === 'muted') continue;
        const hit = tryTrack(track);
        if (hit) return hit;
      }
    }
    return null;
  }

  function setSelection(ids, trackId) {
    uiStore.update('selection', (s) => {
      s.selection = new Set(ids);
      s.selectionTrackId = trackId ?? store.getDoc().activeTrackId;
    });
  }

  function selectedNotes() {
    const doc = store.getDoc();
    const track = getTrack(doc, ui.selectionTrackId || doc.activeTrackId);
    if (!track) return [];
    return track.notes.filter((n) => ui.selection.has(n.id));
  }

  function switchActiveTrack(trackId) {
    if (store.getDoc().activeTrackId === trackId) return;
    store.commit('switch track', ['tracks'], (doc) => {
      doc.activeTrackId = trackId;
    });
  }

  // ---------- overlay mouse ----------

  overlay.addEventListener('mousedown', (e) => {
    if (e.button === 1) return; // middle = pan, handled in piano-roll.js
    overlay.focus();
    const p = pos(e);
    if (p.pitch < PITCH_MIN || p.pitch > PITCH_MAX) return;

    if (e.button === 2) {
      const hit = hitTest(p.x, p.y);
      drag = { kind: 'erase', erased: new Set(hit ? [hit.note.id] : []), trackId: hit ? hit.track.id : store.getDoc().activeTrackId, moved: false, startX: p.x, startY: p.y };
      ui.dragErasedIds = drag.erased;
      roll.markDirty('notes');
      beginWindowDrag();
      return;
    }
    if (e.button !== 0) return;

    const hit = hitTest(p.x, p.y);
    if (hit) {
      if (hit.track.id !== store.getDoc().activeTrackId) switchActiveTrack(hit.track.id);
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      let selection = new Set(ui.selection);
      if (ui.selectionTrackId !== hit.track.id) selection = new Set();
      if (additive) {
        if (selection.has(hit.note.id)) selection.delete(hit.note.id);
        else selection.add(hit.note.id);
        setSelection(selection, hit.track.id);
        return; // no drag from additive clicks
      }
      if (!selection.has(hit.note.id)) {
        selection = new Set([hit.note.id]);
        setSelection(selection, hit.track.id);
      }
      const doc = store.getDoc();
      const track = getTrack(doc, hit.track.id);
      const notes = track.notes.filter((n) => selection.has(n.id) || n.id === hit.note.id);
      drag = {
        kind: 'armed-note',
        zone: hit.zone,
        duplicate: e.altKey && hit.zone === 'body',
        noSnap: false,
        grab: hit.note,
        trackId: hit.track.id,
        orig: notes.map((n) => ({ id: n.id, pitch: n.pitch, startTick: n.startTick, durationTicks: n.durationTicks, velocity: n.velocity, harmonics: n.harmonics })),
        startX: p.x,
        startY: p.y,
        moved: false,
      };
      beginWindowDrag();
    } else {
      // empty grid: plain drag = marquee selection, plain click = move cursor;
      // Shift+drag draws a note, Shift+click adds one at the last-used length.
      // (deletion lives on the right mouse button)
      drag = {
        kind: e.shiftKey ? 'armed-draw' : 'armed-marquee',
        startX: p.x,
        startY: p.y,
        startTickRaw: Math.max(0, p.tick),
        pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, p.pitch)),
        moved: false,
      };
      beginWindowDrag();
    }
  });

  overlay.addEventListener('contextmenu', (e) => e.preventDefault());

  overlay.addEventListener('dblclick', (e) => {
    const p = pos(e);
    const hit = hitTest(p.x, p.y);
    if (!hit) return;
    const doc = store.getDoc();
    const tpBar = ticksPerBar(doc);
    const barStart = Math.floor(hit.note.startTick / tpBar) * tpBar;
    const ids = hit.track.notes
      .filter((n) => n.startTick >= barStart && n.startTick < barStart + tpBar)
      .map((n) => n.id);
    setSelection(ids, hit.track.id);
  });

  overlay.addEventListener('mousemove', (e) => {
    if (drag) return;
    const p = pos(e);
    const hit = hitTest(p.x, p.y);
    overlay.style.cursor = hit ? (hit.zone === 'body' ? 'move' : 'ew-resize') : 'cell';
  });

  function beginWindowDrag() {
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
    window.addEventListener('keydown', onDragKey, true);
  }
  function endWindowDrag() {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
    window.removeEventListener('keydown', onDragKey, true);
  }

  function onDragKey(e) {
    if (e.key === 'Escape' && drag) {
      e.stopPropagation();
      cancelDrag();
    }
  }

  function cancelDrag() {
    drag = null;
    ui.dragPreview = null;
    ui.marquee = null;
    ui.dragErasedIds = null;
    uiStore.update('overlay', () => {});
    roll.markDirty('notes', 'overlay');
    endWindowDrag();
  }

  function onDragMove(e) {
    if (!drag) return;
    const p = pos(e);
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    const snap = e.altKey ? 1 : effectiveSnap(ui);

    if (drag.kind === 'armed-marquee') drag.kind = 'marquee';
    if (drag.kind === 'armed-draw') drag.kind = 'draw';
    if (drag.kind === 'armed-note') {
      drag.kind = drag.zone === 'body' ? 'move' : drag.zone === 'left' ? 'resizeL' : 'resizeR';
    }

    if (drag.kind === 'draw') {
      const rawA = Math.min(drag.startTickRaw, Math.max(0, p.tick));
      const rawB = Math.max(drag.startTickRaw, Math.max(0, p.tick));
      let start;
      let end;
      if (snap > 1) {
        start = Math.max(0, snapTickFloor(rawA, snap));
        end = snapTickFloor(rawB, snap) + snap; // cell under the pointer is included
      } else {
        start = Math.max(0, Math.round(rawA));
        end = Math.max(Math.round(rawB), start + 3);
      }
      drag.draw = { pitch: drag.pitch, startTick: start, durationTicks: end - start };
      ui.dragPreview = [drag.draw];
      uiStore.update('overlay', () => {});
      return;
    }

    if (drag.kind === 'marquee') {
      ui.marquee = { x1: drag.startX, y1: drag.startY, x2: p.x, y2: p.y };
      // live selection on the active track
      const doc = store.getDoc();
      const track = activeTrack(doc);
      if (track) {
        const t1 = xToTick(ui, Math.min(drag.startX, p.x));
        const t2 = xToTick(ui, Math.max(drag.startX, p.x));
        const pTop = yToPitch(ui, Math.min(drag.startY, p.y));
        const pBot = yToPitch(ui, Math.max(drag.startY, p.y));
        const ids = track.notes
          .filter((n) => n.startTick < t2 && n.startTick + n.durationTicks > t1 && n.pitch <= pTop && n.pitch >= pBot)
          .map((n) => n.id);
        setSelection(ids, track.id);
      }
      uiStore.update('overlay', () => {});
      return;
    }

    if (drag.kind === 'move') {
      const rawDelta = dx / ui.pxPerTick;
      const grabOrig = drag.orig.find((o) => o.id === drag.grab.id) || drag.orig[0];
      const snappedStart = Math.max(0, snapTick(grabOrig.startTick + rawDelta, snap));
      const deltaTick = snappedStart - grabOrig.startTick;
      const deltaPitch = -Math.round(dy / ui.rowHeight);
      drag.deltaTick = deltaTick;
      drag.deltaPitch = deltaPitch;
      ui.dragPreview = drag.orig.map((o) => ({
        pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, o.pitch + deltaPitch)),
        startTick: Math.max(0, o.startTick + deltaTick),
        durationTicks: o.durationTicks,
      }));
      uiStore.update('overlay', () => {});
      return;
    }

    if (drag.kind === 'resizeL' || drag.kind === 'resizeR') {
      const rawDelta = dx / ui.pxPerTick;
      const minLen = Math.max(1, snap || 6);
      drag.resized = drag.orig.map((o) => {
        if (drag.kind === 'resizeR') {
          const end = snapTick(o.startTick + o.durationTicks + rawDelta, snap);
          return { ...o, durationTicks: Math.max(minLen, end - o.startTick) };
        }
        const start = Math.max(0, snapTick(o.startTick + rawDelta, snap));
        const end = o.startTick + o.durationTicks;
        return { ...o, startTick: Math.min(start, end - minLen), durationTicks: Math.max(minLen, end - Math.min(start, end - minLen)) };
      });
      ui.dragPreview = drag.resized.map((o) => ({ pitch: o.pitch, startTick: o.startTick, durationTicks: o.durationTicks }));
      uiStore.update('overlay', () => {});
      return;
    }

    if (drag.kind === 'erase') {
      const hit = hitTest(p.x, p.y);
      if (hit && hit.track.id === drag.trackId && !drag.erased.has(hit.note.id)) {
        drag.erased.add(hit.note.id);
        roll.markDirty('notes');
      }
    }
  }

  function onDragUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    endWindowDrag();
    const p = pos(e);

    if (d.kind === 'armed-marquee' && !d.moved) {
      // plain click on empty grid = move the cursor there (and clear selection)
      const snap = effectiveSnap(ui);
      const tick = Math.max(0, snapTickFloor(p.tick, snap || 1));
      const pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, p.pitch));
      store.session.originTick = tick;
      store.session.cursorTick = tick;
      uiStore.update('cursor', (s) => {
        s.gridCursor = { tick, pitch };
      });
      uiStore.update('selection', (s) => s.selection.clear());
      uiStore.update('transport', () => {});
      if (engine.isPlaying()) engine.play(tick);
      return;
    }

    if (d.kind === 'armed-draw' && !d.moved) {
      // Shift+click on empty grid = add a note at the last-used length
      const doc = store.getDoc();
      const track = activeTrack(doc);
      if (!track) return;
      const snap = effectiveSnap(ui);
      const startTick = Math.max(0, snapTickFloor(d.startTickRaw, snap || 1));
      const note = createNote({ pitch: d.pitch, startTick, durationTicks: ui.lastNoteLen });
      store.commit('add note', ['notes'], (dd) => addNote(dd, track.id, note));
      setSelection([note.id], track.id);
      uiStore.update('cursor', (s) => {
        s.gridCursor = { tick: startTick, pitch: d.pitch };
      });
      engine.previewNote(d.pitch, track.instrumentId);
      return;
    }

    if (d.kind === 'draw' && d.moved && d.draw) {
      // drag on empty grid = create a note spanning the dragged range
      ui.dragPreview = null;
      const doc = store.getDoc();
      const track = activeTrack(doc);
      if (!track) return;
      const note = createNote({ ...d.draw });
      store.commit('draw note', ['notes'], (dd) => addNote(dd, track.id, note));
      setSelection([note.id], track.id);
      uiStore.update('cursor', (s) => {
        s.gridCursor = { tick: d.draw.startTick, pitch: d.draw.pitch };
        s.lastNoteLen = d.draw.durationTicks;
      });
      engine.previewNote(d.draw.pitch, track.instrumentId);
      return;
    }

    if (d.kind === 'marquee') {
      ui.marquee = null;
      uiStore.update('overlay', () => {});
      return;
    }

    if (d.kind === 'move' && d.moved) {
      ui.dragPreview = null;
      const { deltaTick = 0, deltaPitch = 0 } = d;
      if (deltaTick === 0 && deltaPitch === 0 && !d.duplicate) {
        uiStore.update('overlay', () => {});
        return;
      }
      if (d.duplicate) {
        const newIds = [];
        store.commit('duplicate notes', ['notes'], (doc) => {
          for (const o of d.orig) {
            const note = createNote({
              pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, o.pitch + deltaPitch)),
              startTick: Math.max(0, o.startTick + deltaTick),
              durationTicks: o.durationTicks,
              velocity: o.velocity,
              harmonics: o.harmonics ? structuredClone(o.harmonics) : null,
            });
            addNote(doc, d.trackId, note);
            newIds.push(note.id);
          }
        });
        setSelection(newIds, d.trackId);
      } else {
        store.commit('move notes', ['notes'], (doc) => {
          updateNotes(doc, d.trackId, d.orig.map((o) => o.id), (n) => {
            const o = d.orig.find((x) => x.id === n.id);
            n.startTick = Math.max(0, o.startTick + deltaTick);
            n.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, o.pitch + deltaPitch));
          });
        });
      }
      const grabOrig = d.orig.find((o) => o.id === d.grab.id) || d.orig[0];
      engine.previewNote(Math.max(PITCH_MIN, Math.min(PITCH_MAX, grabOrig.pitch + deltaPitch)), null);
      return;
    }

    if ((d.kind === 'resizeL' || d.kind === 'resizeR') && d.moved && d.resized) {
      ui.dragPreview = null;
      store.commit('resize notes', ['notes'], (doc) => {
        updateNotes(doc, d.trackId, d.resized.map((o) => o.id), (n) => {
          const o = d.resized.find((x) => x.id === n.id);
          n.startTick = o.startTick;
          n.durationTicks = o.durationTicks;
        });
      });
      const grabResized = d.resized.find((o) => o.id === d.grab.id) || d.resized[0];
      uiStore.update('cursor', (s) => {
        s.lastNoteLen = grabResized.durationTicks;
      });
      return;
    }

    if (d.kind === 'erase') {
      ui.dragErasedIds = null;
      if (d.erased.size) {
        store.commit('delete notes', ['notes'], (doc) => deleteNotes(doc, d.trackId, [...d.erased]));
        uiStore.update('selection', (s) => {
          for (const id of d.erased) s.selection.delete(id);
        });
      } else {
        roll.markDirty('notes');
      }
      return;
    }

    // armed-note without movement: plain click already handled selection.
    ui.dragPreview = null;
    uiStore.update('overlay', () => {});
  }

  // ---------- ruler ----------

  const ruler = canvases.ruler;
  let rulerDrag = null;

  ruler.addEventListener('mousedown', (e) => {
    const rect = ruler.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const tick = Math.max(0, xToTick(ui, x));
    if (e.button === 2) return;
    const doc = store.getDoc();
    const tpb = ticksPerBeat(doc);
    rulerDrag = { startTick: snapTick(tick, tpb), moved: false, startX: x };
    const move = (ev) => {
      const mx = ev.clientX - rect.left;
      if (!rulerDrag.moved && Math.abs(mx - rulerDrag.startX) < DRAG_THRESHOLD) return;
      rulerDrag.moved = true;
      const cur = snapTick(Math.max(0, xToTick(ui, mx)), tpb);
      const a = Math.min(rulerDrag.startTick, cur);
      const b = Math.max(rulerDrag.startTick, cur);
      if (b > a) {
        store.setLoop({ startTick: a, endTick: b, enabled: true });
        uiStore.update('transport', () => {});
      }
    };
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!rulerDrag.moved) {
        const mx = ev.clientX - rect.left;
        const snap = effectiveSnap(ui) || 1;
        const tick = snapTick(Math.max(0, xToTick(ui, mx)), snap);
        store.session.originTick = tick; // the placed cursor keeps its own identity
        store.session.cursorTick = tick;
        uiStore.update('transport', () => {});
        if (engine.isPlaying()) engine.play(tick);
      }
      rulerDrag = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  ruler.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      {
        label: 'Reset cursor to start',
        disabled: store.session.originTick === 0 && store.session.cursorTick === 0,
        action: () => {
          store.session.originTick = 0;
          store.session.cursorTick = 0;
          uiStore.update('transport', () => {});
        },
      },
      {
        label: 'Clear loop',
        disabled: !store.getLoop(),
        action: () => {
          store.setLoop(null);
          uiStore.update('transport', () => {});
        },
      },
      { label: 'Trim before cursor', action: () => trimBeforeAction(store, uiStore) },
      { label: 'Trim after cursor', action: () => trimAfterAction(store, uiStore) },
    ]);
  });

  // ---------- keys column ----------

  canvases.keys.addEventListener('mousedown', (e) => {
    const rect = canvases.keys.getBoundingClientRect();
    const pitch = yToPitch(ui, e.clientY - rect.top);
    if (pitch < PITCH_MIN || pitch > PITCH_MAX) return;
    const doc = store.getDoc();
    const track = activeTrack(doc);
    engine.previewNote(pitch, track ? track.instrumentId : null);
  });

  return {
    cancelDrag,
    setSelection,
    selectedNotes,
    hitTest,
  };
}
