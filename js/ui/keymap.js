// Global keyboard map. Contexts: open dialog -> native handling; focused
// text input -> only Escape; otherwise the editor map below.

import { PPQ, snapTick } from '../core/music.js';
import {
  createNote, addNote, deleteNotes, updateNotes, activeTrack, melodyTrack, getTrack,
  ticksPerBar, songEndTick,
} from '../core/doc.js';
import { effectiveSnap, PITCH_MIN, PITCH_MAX } from './piano-roll/coords.js';
import { chordOf, commandForChord, runCommand } from './commands.js';
import { initPalette } from './palette.js';

const SNAP_KEYS = {
  Digit1: PPQ * 4,
  Digit2: PPQ * 2,
  Digit3: PPQ,
  Digit4: PPQ / 2,
  Digit5: PPQ / 4,
  Digit6: PPQ / 8,
};

export function initKeymap({ store, uiStore, engine, roll, conflicts, actions }) {
  const ui = uiStore.state;
  let clipboard = null;

  function cursorStep() {
    return effectiveSnap(ui) || PPQ / 2;
  }

  function moveCursor(dTick, dPitch) {
    uiStore.update('cursor', (s) => {
      s.gridCursor.tick = Math.max(0, s.gridCursor.tick + dTick);
      s.gridCursor.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, s.gridCursor.pitch + dPitch));
    });
    roll.scrollTickIntoView(ui.gridCursor.tick);
    roll.scrollPitchIntoView(ui.gridCursor.pitch);
  }

  function selectedNotes() {
    return roll.interactions.selectedNotes();
  }

  function selTrackId() {
    return ui.selectionTrackId || store.getDoc().activeTrackId;
  }

  function transposeSelection(semis) {
    const sel = selectedNotes();
    if (!sel.length) return moveCursor(0, semis);
    store.commit('transpose', ['notes'], (doc) => {
      updateNotes(doc, selTrackId(), sel.map((n) => n.id), (n) => {
        n.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, n.pitch + semis));
      });
    });
    engine.previewNote(Math.max(PITCH_MIN, Math.min(PITCH_MAX, sel[0].pitch + semis)), null);
  }

  function nudgeSelection(dTick) {
    const sel = selectedNotes();
    if (!sel.length) return moveCursor(dTick, 0);
    if (dTick < 0 && sel.some((n) => n.startTick + dTick < 0)) return;
    store.commit('move', ['notes'], (doc) => {
      updateNotes(doc, selTrackId(), sel.map((n) => n.id), (n) => {
        n.startTick = Math.max(0, n.startTick + dTick);
      });
    });
  }

  function resizeSelection(dTick) {
    const sel = selectedNotes();
    if (!sel.length) return;
    const minLen = Math.max(1, effectiveSnap(ui) || 6);
    store.commit('resize', ['notes'], (doc) => {
      updateNotes(doc, selTrackId(), sel.map((n) => n.id), (n) => {
        n.durationTicks = Math.max(minLen, n.durationTicks + dTick);
      });
    });
    uiStore.update('cursor', (s) => {
      s.lastNoteLen = Math.max(minLen, sel[0].durationTicks + dTick);
    });
  }

  function enterAtCursor() {
    const doc = store.getDoc();
    const track = activeTrack(doc);
    if (!track) return;
    const { tick, pitch } = ui.gridCursor;
    const existing = track.notes.find(
      (n) => n.pitch === pitch && n.startTick <= tick && tick < n.startTick + n.durationTicks
    );
    if (existing) {
      roll.interactions.setSelection([existing.id], track.id);
      return;
    }
    const note = createNote({ pitch, startTick: tick, durationTicks: ui.lastNoteLen });
    store.commit('add note', ['notes'], (dd) => addNote(dd, track.id, note));
    roll.interactions.setSelection([note.id], track.id);
    engine.previewNote(pitch, track.instrumentId);
  }

  function tabToNote(dir) {
    const doc = store.getDoc();
    const track = activeTrack(doc);
    if (!track || !track.notes.length) return;
    const sel = selectedNotes();
    let idx;
    if (sel.length) {
      const currentId = sel[dir > 0 ? sel.length - 1 : 0].id;
      idx = track.notes.findIndex((n) => n.id === currentId) + dir;
    } else {
      idx = dir > 0 ? 0 : track.notes.length - 1;
    }
    idx = (idx + track.notes.length) % track.notes.length;
    const note = track.notes[idx];
    roll.interactions.setSelection([note.id], track.id);
    uiStore.update('cursor', (s) => {
      s.gridCursor = { tick: note.startTick, pitch: note.pitch };
    });
    roll.scrollTickIntoView(note.startTick);
    roll.scrollPitchIntoView(note.pitch);
  }

  function copySelection(cut) {
    const sel = selectedNotes();
    if (!sel.length) return;
    const baseTick = Math.min(...sel.map((n) => n.startTick));
    clipboard = sel.map((n) => ({
      pitch: n.pitch,
      startTick: n.startTick - baseTick,
      durationTicks: n.durationTicks,
      velocity: n.velocity,
      harmonics: n.harmonics ? structuredClone(n.harmonics) : null,
    }));
    if (cut) {
      store.commit('cut notes', ['notes'], (doc) => deleteNotes(doc, selTrackId(), sel.map((n) => n.id)));
      uiStore.update('selection', (s) => s.selection.clear());
    }
  }

  function paste() {
    if (!clipboard || !clipboard.length) return;
    const doc = store.getDoc();
    const track = activeTrack(doc);
    if (!track) return;
    const base = ui.gridCursor.tick;
    const newIds = [];
    store.commit('paste notes', ['notes'], (dd) => {
      for (const c of clipboard) {
        const note = createNote({ ...c, startTick: base + c.startTick, harmonics: c.harmonics ? structuredClone(c.harmonics) : null });
        addNote(dd, track.id, note);
        newIds.push(note.id);
      }
    });
    roll.interactions.setSelection(newIds, track.id);
  }

  function duplicateRight() {
    const sel = selectedNotes();
    if (!sel.length) return;
    const start = Math.min(...sel.map((n) => n.startTick));
    const end = Math.max(...sel.map((n) => n.startTick + n.durationTicks));
    const span = Math.max(1, snapTick(end - start, effectiveSnap(ui)) || end - start);
    const newIds = [];
    store.commit('duplicate', ['notes'], (doc) => {
      for (const n of sel) {
        const note = createNote({
          pitch: n.pitch,
          startTick: n.startTick + span,
          durationTicks: n.durationTicks,
          velocity: n.velocity,
          harmonics: n.harmonics ? structuredClone(n.harmonics) : null,
        });
        addNote(doc, selTrackId(), note);
        newIds.push(note.id);
      }
    });
    roll.interactions.setSelection(newIds, selTrackId());
  }

  function switchTrack(dir) {
    const doc = store.getDoc();
    if (doc.mode !== 'poly' || doc.tracks.length < 2) return;
    const idx = doc.tracks.findIndex((t) => t.id === doc.activeTrackId);
    const next = doc.tracks[(idx + dir + doc.tracks.length) % doc.tracks.length];
    store.commit('switch track', ['tracks'], (dd) => {
      dd.activeTrackId = next.id;
    });
    uiStore.update('selection', (s) => {
      s.selection.clear();
      s.selectionTrackId = next.id;
    });
  }

  function jumpToConflict() {
    const next = conflicts.nextTick(ui.gridCursor.tick);
    if (next == null) return;
    const doc = store.getDoc();
    const track = melodyTrack(doc);
    const ids = track.notes.filter((n) => conflicts.ids().has(n.id) && n.startTick === next).map((n) => n.id);
    roll.interactions.setSelection(ids, track.id);
    uiStore.update('cursor', (s) => {
      s.gridCursor.tick = next;
      if (ids.length) s.gridCursor.pitch = track.notes.find((n) => n.id === ids[0]).pitch;
    });
    roll.scrollTickIntoView(next);
  }

  // Everything that also has a button, or belongs in the palette, is
  // dispatched from the shared table first. What remains below is grid
  // editing - positional and contextual, and not palette material.
  const commandCtx = () => ({
    store, uiStore, engine, actions, roll, conflicts, jumpToConflict, goHome: actions.goHome,
  });
  // Built here because this is where the context it needs already lives.
  const palette = initPalette({
    get store() { return store; },
    get uiStore() { return uiStore; },
    get engine() { return engine; },
    get actions() { return actions; },
    get roll() { return roll; },
    get conflicts() { return conflicts; },
    jumpToConflict,
    goHome: actions.goHome,
  });

  window.addEventListener('keydown', (e) => {
    if (ui.screen !== 'editor') return;
    if (document.querySelector('dialog[open]')) return;

    const el = document.activeElement;
    const inText = el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
    if (inText) {
      if (e.key === 'Escape') el.blur();
      return;
    }

    const ctrl = e.ctrlKey || e.metaKey;
    const doc = store.getDoc();

    if (ctrl && e.code === 'KeyK') {
      e.preventDefault();
      palette.open();
      return;
    }

    const cmd = commandForChord(chordOf(e));
    if (cmd) {
      e.preventDefault();
      // A guard that fails means "not now" - the key is still ours, so it
      // must not fall through and be read as a grid edit.
      runCommand(cmd, commandCtx());
      return;
    }

    // --- ctrl combos ---
    if (ctrl) {
      switch (e.code) {
        case 'KeyA': {
          e.preventDefault();
          const track = activeTrack(doc);
          if (track) roll.interactions.setSelection(track.notes.map((n) => n.id), track.id);
          return;
        }
        case 'KeyC':
          e.preventDefault();
          copySelection(false);
          return;
        case 'KeyX':
          e.preventDefault();
          copySelection(true);
          return;
        case 'KeyV':
          e.preventDefault();
          paste();
          return;
        case 'KeyD':
          e.preventDefault();
          duplicateRight();
          return;
        case 'ArrowLeft':
          e.preventDefault();
          moveCursor(-ticksPerBar(doc), 0);
          return;
        case 'ArrowRight':
          e.preventDefault();
          moveCursor(ticksPerBar(doc), 0);
          return;
        case 'ArrowUp':
          e.preventDefault();
          switchTrack(-1);
          return;
        case 'ArrowDown':
          e.preventDefault();
          switchTrack(1);
          return;
        case 'Equal':
        case 'NumpadAdd':
          e.preventDefault();
          actions.zoom(1.25);
          return;
        case 'Minus':
        case 'NumpadSubtract':
          e.preventDefault();
          actions.zoom(1 / 1.25);
          return;
        case 'BracketLeft':
          if (e.shiftKey) {
            e.preventDefault();
            actions.trimBefore();
          }
          return;
        case 'BracketRight':
          if (e.shiftKey) {
            e.preventDefault();
            actions.trimAfter();
          }
          return;
      }
      return;
    }

    // --- snap digits ---
    if (SNAP_KEYS[e.code] !== undefined && !e.shiftKey && !e.altKey) {
      actions.setSnap(SNAP_KEYS[e.code], ui.triplet);
      return;
    }
    if (e.code === 'Digit7') {
      actions.setSnap(ui.snapTicks, !ui.triplet);
      return;
    }
    if (e.code === 'Digit0') {
      actions.setSnap(0, ui.triplet);
      return;
    }

    switch (e.code) {
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) nudgeSelection(-cursorStep());
        else if (e.altKey) resizeSelection(-cursorStep());
        else moveCursor(-cursorStep(), 0);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) nudgeSelection(cursorStep());
        else if (e.altKey) resizeSelection(cursorStep());
        else moveCursor(cursorStep(), 0);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey) transposeSelection(1);
        else moveCursor(0, 1);
        return;
      case 'ArrowDown':
        e.preventDefault();
        if (e.shiftKey) transposeSelection(-1);
        else moveCursor(0, -1);
        return;
      case 'PageUp':
        e.preventDefault();
        e.shiftKey ? transposeSelection(12) : moveCursor(0, 12);
        return;
      case 'PageDown':
        e.preventDefault();
        e.shiftKey ? transposeSelection(-12) : moveCursor(0, -12);
        return;
      case 'Home':
        e.preventDefault();
        uiStore.update('cursor', (s) => {
          s.gridCursor.tick = 0;
        });
        store.session.cursorTick = 0;
        store.session.originTick = 0;
        roll.scrollTickIntoView(0);
        uiStore.update('transport', () => {});
        return;
      case 'End': {
        e.preventDefault();
        const end = songEndTick(doc);
        uiStore.update('cursor', (s) => {
          s.gridCursor.tick = end;
        });
        roll.scrollTickIntoView(end);
        return;
      }
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        enterAtCursor();
        return;
      case 'Tab':
        e.preventDefault();
        tabToNote(e.shiftKey ? -1 : 1);
        return;
      case 'Delete':
      case 'Backspace': {
        e.preventDefault();
        const sel = selectedNotes();
        if (sel.length) {
          store.commit('delete notes', ['notes'], (dd) => deleteNotes(dd, selTrackId(), sel.map((n) => n.id)));
          uiStore.update('selection', (s) => s.selection.clear());
        }
        return;
      }
      case 'Escape':
        uiStore.update('selection', (s) => s.selection.clear());
        return;
      case 'KeyP': {
        const track = activeTrack(doc);
        engine.previewNote(ui.gridCursor.pitch, track ? track.instrumentId : null);
        return;
      }
      case 'KeyA':
        uiStore.update('view', (s) => {
          s.panels.harmonics = !s.panels.harmonics;
        });
        actions.applyPanels();
        return;
    }
  });
}
