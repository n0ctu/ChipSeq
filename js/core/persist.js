// localStorage persistence: autosave, recent-projects index, arp presets.
//
// Storage is treated as something that can fail at any moment, because it can:
// private-browsing modes and restricted iframes throw SecurityError on the
// very first access, and a full quota throws QuotaExceededError on a write
// that used to succeed. Neither may take the editor down or lose the project
// that is open - so every access goes through the wrappers below, and a
// failure degrades to an in-memory store with the status bar saying
// "not saving" rather than throwing into a caller that cannot do anything
// about it.

import { migrate } from './doc.js';

const PREFIX = 'chipseq.v1.';
const KEY_INDEX = PREFIX + 'index';
const KEY_PRESETS = PREFIX + 'presets';
const KEY_LAST = PREFIX + 'lastOpen';
const projKey = (id) => PREFIX + 'proj.' + id;

// ---- storage access ----

// Set once the backing store proves unusable. From then on everything runs
// against the in-memory map: the session keeps working, nothing persists,
// and the UI can say so honestly.
let degraded = false;
let degradedReason = null;
const memory = new Map();

// Listeners for the first (and only the first) degradation, so the status bar
// can report it without polling.
const degradeListeners = new Set();
export function onStorageDegraded(fn) {
  degradeListeners.add(fn);
  if (degraded) fn(degradedReason);
  return () => degradeListeners.delete(fn);
}

function degrade(err) {
  if (degraded) return;
  degraded = true;
  degradedReason =
    err && err.name === 'QuotaExceededError'
      ? 'storage is full'
      : 'storage is unavailable (private mode?)';
  for (const fn of [...degradeListeners]) fn(degradedReason);
}

export function isDegraded() {
  return degraded;
}

// Never throws. A read failure is indistinguishable from "not there", which
// is the only thing a caller can act on anyway.
export function readRaw(key) {
  if (degraded) return memory.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch (err) {
    degrade(err);
    return memory.get(key) ?? null;
  }
}

// Never throws; returns whether the value actually reached durable storage,
// so a caller that cares (saveProject) can report it.
export function writeRaw(key, value) {
  memory.set(key, value); // the session keeps working either way
  if (degraded) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    degrade(err);
    return false;
  }
}

export function removeRaw(key) {
  memory.delete(key);
  if (degraded) return;
  try {
    localStorage.removeItem(key);
  } catch (err) {
    degrade(err);
  }
}

function readJson(key, fallback) {
  const raw = readRaw(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback; // corrupt entry - treated as absent, never thrown
  }
}

// ---- projects ----

export function listProjects() {
  const index = readJson(KEY_INDEX, []);
  if (!Array.isArray(index)) return [];
  return index.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function loadProject(id) {
  const raw = readRaw(projKey(id));
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw));
  } catch (err) {
    console.warn('project failed to load:', id, err);
    return null;
  }
}

// Writes the project, then the index. The project comes FIRST so a failure
// between the two leaves an unreferenced project rather than an index entry
// pointing at nothing - the recoverable direction.
export function saveProject(doc) {
  const raw = JSON.stringify(doc);
  const stored = writeRaw(projKey(doc.id), raw);
  const index = readJson(KEY_INDEX, []).filter((e) => e.id !== doc.id);
  index.unshift({
    id: doc.id,
    name: doc.name,
    mode: doc.mode,
    updatedAt: doc.updatedAt,
    bytes: raw.length,
  });
  writeRaw(KEY_INDEX, JSON.stringify(index));
  writeRaw(KEY_LAST, doc.id);
  return stored;
}

export function deleteProject(id) {
  removeRaw(projKey(id));
  const index = readJson(KEY_INDEX, []).filter((e) => e.id !== id);
  writeRaw(KEY_INDEX, JSON.stringify(index));
  if (readRaw(KEY_LAST) === id) removeRaw(KEY_LAST);
}

export function lastOpenId() {
  return readRaw(KEY_LAST);
}

// Demos are no longer copied into storage - they load fresh from demos/ on
// every visit so updates reach everyone. Clean up copies seeded by older
// builds (and the obsolete seed marker) so they don't shadow the live ones.
const KEY_SEEDED = PREFIX + 'demosSeeded';
export function purgeSeededDemos(demoIds) {
  removeRaw(KEY_SEEDED);
  for (const id of demoIds) {
    if (readRaw(projKey(id))) deleteProject(id);
  }
}

// Debounced autosave wired to store changes. Emits 'storage-error' on the
// store if the write did not reach durable storage - never deletes other
// projects to make room.
// shouldSave: optional guard - e.g. an open demo must not be persisted
// until the user edits it (which forks a personal copy).
export function attachAutosave(store, { debounceMs = 400, shouldSave = null } = {}) {
  let timer = null;
  let reported = false;

  function flush() {
    timer = null;
    if (shouldSave && !shouldSave()) return;
    const stored = saveProject(store.getDoc());
    if (stored) {
      store.emit('saved', { at: Date.now() });
      return;
    }
    // Report once: the condition persists, and a message on every keystroke
    // would bury everything else in the status bar.
    if (!reported) {
      reported = true;
      store.emit('storage-error', { name: 'StorageUnavailable', message: degradedReason });
    }
  }

  store.subscribe(['doc', 'song', 'notes', 'tracks', 'harmonics', 'loop', 'grid'], () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  const flushNow = () => {
    if (timer) {
      clearTimeout(timer);
      flush();
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
  window.addEventListener('pagehide', flushNow);
  return flushNow;
}

// ---- .tune.json file import/export ----

export function exportTuneJson(doc) {
  return new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
}

export function importTuneJson(text) {
  return migrate(JSON.parse(text));
}

// ---- global arp presets ----

export function loadPresets() {
  const list = readJson(KEY_PRESETS, []);
  return Array.isArray(list) ? list : [];
}

export function savePresets(list) {
  writeRaw(KEY_PRESETS, JSON.stringify(list));
}
