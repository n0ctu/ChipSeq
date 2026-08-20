// Document store: delta-based undo/redo + scope-tagged change events.
// The whole project doc is plain JSON; every mutation goes through commit().
//
// Every path that changes the current document ends in normalizeDoc(), so
// derived state (the legacy tempo mirrors, doc.uses) is a property of every
// snapshot rather than something each call site has to remember. It is
// idempotent, which is why running it again after undo/redo is harmless.
//
// ---- undo history ----
//
// A step is the canonical serialization of the document - everything except
// `updatedAt`, which changes on every commit and would stretch every delta
// from the edit site to the timestamp field while carrying no user state.
// The view, loop and grid ride along DELIBERATELY: undoing an edit also puts
// the viewport and cursor back where that edit was made, so a run of Ctrl+Z
// shows each reverted change instead of rewinding the song somewhere
// off-screen.
//
// Steps live in js/core/history.js delta stacks: the newest state whole, the
// older ones as byte deltas against their newer neighbour. Costs, measured
// on the largest shipped demo (420 KB serialized): one extra stringify per
// commit at 1.9 ms, the delta scan at 0.06 ms, a pitch edit stored in ~2
// bytes. The old full-snapshot stack fit 19 steps in the same 8 MB.
//
// At most one step is logged per MERGE_WINDOW_MS per kind of action: a
// commit whose label matches the open step, within the window measured from
// where that step STARTED, folds into it instead of logging its own. Two
// hundred slider ticks become one entry; the same label still starts a fresh
// step every two seconds, so half a minute of steady note-drawing stays
// fifteen undoable steps rather than collapsing into one.
//
// The window is anchored, not sliding, for exactly that reason - a sliding
// window folds any unbroken run of one action, however long, into a single
// step, and "I drew for a minute, Ctrl+Z erased all of it" is a worse
// failure than a long slider drag costing a few entries.
//
// Same label only: a note edit one second after a fade must stay its own
// step, or one undo would revert both. Undo/redo/setDoc close the open step,
// so a commit right after an undo always starts fresh.

import { normalizeDoc, setView as writeView, viewOf } from './doc.js';
import { deltaStack } from './history.js';

const UNDO_CAP_ENTRIES = 1000;
const UNDO_CAP_BYTES = 8 * 1024 * 1024;
const MERGE_WINDOW_MS = 2000;

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

// `now` is injectable so tests can steer the merge window instead of racing
// a real clock.
export function createStore(doc, { now = Date.now } = {}) {
  const emitter = createEmitter();
  let current = doc;
  const undoStack = deltaStack({ maxEntries: UNDO_CAP_ENTRIES, maxBytes: UNDO_CAP_BYTES });
  const redoStack = deltaStack({ maxEntries: UNDO_CAP_ENTRIES, maxBytes: UNDO_CAP_BYTES });
  // The step currently open for folding: {label, scopes, startedAt} | null.
  let openStep = null;

  // Ephemeral, non-undoable, non-persisted UI-facing session state.
  // (the loop region lives in the DOCUMENT - doc.loop - so it is autosaved
  // and exported with .chipseq.json)
  const session = {
    cursorTick: 0, // current playhead / pause position
    originTick: 0, // where the user last manually placed the cursor
    metronome: false,
  };

  // The undo step: the whole document except its save timestamp. Key order
  // is insertion order minus the one dropped key, so the same state always
  // serializes to the same bytes - which is what makes neighbour deltas
  // meaningful.
  function canonical() {
    const { updatedAt, ...rest } = current;
    return JSON.stringify(rest);
  }

  function restoreCanonical(s) {
    current = JSON.parse(s);
    // The restored state is document state; the save timestamp is not. The
    // document just changed, so it is stamped fresh - autosave must treat an
    // undone document as new work, not as the old save it byte-matches.
    current.updatedAt = new Date().toISOString();
    reportRepairs(normalizeDoc(current));
  }

  // A repair means the document referenced something that no longer existed.
  // The user should hear about it - fixing it silently is how a project ends
  // up subtly different from what someone left behind.
  function reportRepairs(warnings) {
    if (warnings && warnings.length) emitter.emit('doc-repaired', warnings);
  }

  function emitChange(scopes, label) {
    emitter.emit('change', { scopes: new Set(scopes), label, doc: current });
  }

  return {
    getDoc: () => current,
    session,

    // Replace the whole document (project open / import), clears history.
    setDoc(newDoc) {
      current = newDoc;
      reportRepairs(normalizeDoc(current));
      undoStack.clear();
      redoStack.clear();
      openStep = null;
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

    // Saved view (scroll, zoom, cursor): project data, but not an edit -
    // scrolling must not push an undo snapshot or mark history dirty. It is
    // also deliberately NOT in the autosave's scope list: scrolling should
    // not trigger a write on its own, it just rides along with the next save.
    getView: () => viewOf(current),
    setView(view) {
      writeView(current, view);
      // Announced on its own scope: enough for autosave to know the document
      // differs from what is stored, but not enough to schedule a write -
      // scrolling should ride along with the next save, not cause one.
      emitChange(['view'], 'set view');
    },

    // Like commit, but for a value the APP measured rather than one the user
    // chose: no undo snapshot, so an automatic re-measurement cannot bury the
    // edit you actually made under a pile of history you never asked for.
    // Still marks the document changed, so the result is saved and does not
    // have to be recomputed on every load.
    commitDerived(label, scopes, fn) {
      fn(current);
      reportRepairs(normalizeDoc(current));
      current.updatedAt = new Date().toISOString();
      emitChange([...scopes], label);
    },

    // commit(label, scopes, fn): log the step, mutate, notify. A commit that
    // folds into the open step logs nothing - that step already holds the
    // state from before the run began, which is exactly where one undo
    // should land.
    commit(label, scopes, fn) {
      const at = now();
      const folds =
        openStep && openStep.label === label
        && openStep.scopes === String(scopes)
        && at - openStep.startedAt < MERGE_WINDOW_MS;
      if (!folds) {
        undoStack.push(canonical());
        openStep = { label, scopes: String(scopes), startedAt: at };
      }
      redoStack.clear();
      fn(current);
      reportRepairs(normalizeDoc(current));
      current.updatedAt = new Date().toISOString();
      emitChange([...scopes, 'history'], label);
    },

    canUndo: () => undoStack.size > 0,
    canRedo: () => redoStack.size > 0,

    undo() {
      if (!undoStack.size) return;
      redoStack.push(canonical());
      restoreCanonical(undoStack.pop());
      openStep = null;
      emitChange(['doc', 'song', 'notes', 'tracks', 'automation', 'history'], 'undo');
    },

    redo() {
      if (!redoStack.size) return;
      undoStack.push(canonical());
      restoreCanonical(redoStack.pop());
      openStep = null;
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
