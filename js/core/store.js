// Document store: snapshot-based undo/redo + scope-tagged change events.
// The whole project doc is plain JSON; every mutation goes through commit().
//
// Every path that changes the current document ends in normalizeDoc(), so
// derived state (the legacy tempo mirrors, doc.uses) is a property of every
// snapshot rather than something each call site has to remember. It is
// idempotent, which is why running it again after undo/redo is harmless.

import { normalizeDoc } from './doc.js';

const UNDO_CAP_ENTRIES = 200;
const UNDO_CAP_BYTES = 8 * 1024 * 1024;

export function createEmitter() {
  const listeners = new Map();
  return {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event).delete(cb);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (set) for (const cb of [...set]) cb(payload);
    },
  };
}

export function createStore(doc) {
  const emitter = createEmitter();
  let current = doc;
  let undoStack = []; // serialized JSON strings
  let redoStack = [];

  // Ephemeral, non-undoable, non-persisted UI-facing session state.
  // (the loop region lives in the DOCUMENT - doc.loop - so it is autosaved
  // and exported with .tune.json)
  const session = {
    cursorTick: 0, // current playhead / pause position
    originTick: 0, // where the user last manually placed the cursor
    metronome: false,
  };

  function capUndo() {
    while (undoStack.length > UNDO_CAP_ENTRIES) undoStack.shift();
    let bytes = 0;
    for (const s of undoStack) bytes += s.length;
    while (bytes > UNDO_CAP_BYTES && undoStack.length > 1) {
      bytes -= undoStack.shift().length;
    }
  }

  function emitChange(scopes, label) {
    emitter.emit('change', { scopes: new Set(scopes), label, doc: current });
  }

  return {
    getDoc: () => current,
    session,

    // Replace the whole document (project open / import), clears history.
    setDoc(newDoc) {
      current = normalizeDoc(newDoc);
      undoStack = [];
      redoStack = [];
      session.cursorTick = 0;
      session.originTick = 0;
      emitChange(['doc', 'song', 'notes', 'tracks', 'loop', 'history'], 'open');
    },

    // Grid/snap preference: project data (saved + exported), no undo
    // snapshots - flipping the snap setting isn't an edit.
    getGrid: () => current.grid || null,
    setGrid(grid) {
      current.grid = { snapTicks: grid.snapTicks ?? 0, triplet: !!grid.triplet };
      current.updatedAt = new Date().toISOString();
      emitChange(['grid'], 'set grid');
    },

    // Loop region: project data (saved + exported), but edited without undo
    // snapshots - dragging a loop shouldn't pollute the undo history.
    getLoop: () => current.loop || null,
    setLoop(loop) {
      current.loop =
        loop && loop.endTick > loop.startTick
          ? { startTick: loop.startTick, endTick: loop.endTick, enabled: loop.enabled !== false }
          : null;
      current.updatedAt = new Date().toISOString();
      emitChange(['loop'], 'set loop');
    },

    // commit(label, scopes, fn): push snapshot, mutate, notify.
    commit(label, scopes, fn) {
      undoStack.push(JSON.stringify(current));
      capUndo();
      redoStack = [];
      fn(current);
      normalizeDoc(current);
      current.updatedAt = new Date().toISOString();
      emitChange([...scopes, 'history'], label);
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    undo() {
      if (!undoStack.length) return;
      redoStack.push(JSON.stringify(current));
      current = normalizeDoc(JSON.parse(undoStack.pop()));
      emitChange(['doc', 'song', 'notes', 'tracks', 'automation', 'history'], 'undo');
    },

    redo() {
      if (!redoStack.length) return;
      undoStack.push(JSON.stringify(current));
      current = normalizeDoc(JSON.parse(redoStack.pop()));
      emitChange(['doc', 'song', 'notes', 'tracks', 'automation', 'history'], 'redo');
    },

    // subscribe(scopes, cb): cb({scopes,label,doc}) when any scope matches.
    subscribe(scopes, cb) {
      const want = new Set(scopes);
      return emitter.on('change', (ev) => {
        for (const s of ev.scopes) {
          if (want.has(s)) {
            cb(ev);
            return;
          }
        }
      });
    },

    on: emitter.on,
    emit: emitter.emit,
  };
}
