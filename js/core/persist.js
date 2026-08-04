// localStorage persistence: autosave, recent-projects index, arp presets.

import { migrate } from './doc.js';

const PREFIX = 'chipseq.v1.';
const KEY_INDEX = PREFIX + 'index';
const KEY_PRESETS = PREFIX + 'presets';
const KEY_LAST = PREFIX + 'lastOpen';
const projKey = (id) => PREFIX + 'proj.' + id;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function listProjects() {
  const index = readJson(KEY_INDEX, []);
  return index.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function loadProject(id) {
  const raw = localStorage.getItem(projKey(id));
  if (!raw) return null;
  return migrate(JSON.parse(raw));
}

export function saveProject(doc) {
  const raw = JSON.stringify(doc);
  localStorage.setItem(projKey(doc.id), raw);
  const index = readJson(KEY_INDEX, []).filter((e) => e.id !== doc.id);
  index.unshift({
    id: doc.id,
    name: doc.name,
    mode: doc.mode,
    updatedAt: doc.updatedAt,
    bytes: raw.length,
  });
  localStorage.setItem(KEY_INDEX, JSON.stringify(index));
  localStorage.setItem(KEY_LAST, doc.id);
}

export function deleteProject(id) {
  localStorage.removeItem(projKey(id));
  const index = readJson(KEY_INDEX, []).filter((e) => e.id !== id);
  localStorage.setItem(KEY_INDEX, JSON.stringify(index));
  if (localStorage.getItem(KEY_LAST) === id) localStorage.removeItem(KEY_LAST);
}

export function lastOpenId() {
  return localStorage.getItem(KEY_LAST);
}

// One-shot flag: demos are seeded only for brand-new users, not re-imposed
// on users who deliberately deleted everything.
const KEY_SEEDED = PREFIX + 'demosSeeded';
export const demosSeeded = () => localStorage.getItem(KEY_SEEDED) === '1';
export const markDemosSeeded = () => localStorage.setItem(KEY_SEEDED, '1');

// Debounced autosave wired to store changes. Emits 'storage-error' on the
// store if the quota is hit — never deletes other projects silently.
export function attachAutosave(store, { debounceMs = 400 } = {}) {
  let timer = null;

  function flush() {
    timer = null;
    try {
      saveProject(store.getDoc());
      store.emit('saved', { at: Date.now() });
    } catch (err) {
      store.emit('storage-error', err);
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
  return readJson(KEY_PRESETS, []);
}

export function savePresets(list) {
  localStorage.setItem(KEY_PRESETS, JSON.stringify(list));
}
