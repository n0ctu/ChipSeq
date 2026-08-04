// Global trimmer: cut away everything before/after the playback cursor.

import { trimBefore, trimAfter, countTrimBefore, countTrimAfter } from '../core/doc.js';
import { confirmDialog } from './dialogs.js';

export async function trimBeforeAction(store, uiStore) {
  const tick = store.session.originTick;
  if (tick <= 0) return;
  const removed = countTrimBefore(store.getDoc(), tick);
  const ok = await confirmDialog(
    'Trim before cursor',
    `Everything before the cursor will be removed (${removed} note${removed === 1 ? '' : 's'} deleted, spanning notes truncated) and the song shifts to start at the cursor.`,
    'Trim'
  );
  if (!ok) return;
  store.commit('trim before cursor', ['notes', 'loop'], (doc) => trimBefore(doc, tick));
  store.session.cursorTick = 0;
  store.session.originTick = 0;
  uiStore.update('selection', (s) => s.selection.clear());
  uiStore.update('transport', () => {});
}

export async function trimAfterAction(store, uiStore) {
  const tick = store.session.originTick;
  const removed = countTrimAfter(store.getDoc(), tick);
  const ok = await confirmDialog(
    'Trim after cursor',
    `Everything after the cursor will be removed (${removed} note${removed === 1 ? '' : 's'} deleted, spanning notes truncated).`,
    'Trim'
  );
  if (!ok) return;
  store.commit('trim after cursor', ['notes', 'loop'], (doc) => trimAfter(doc, tick));
  uiStore.update('selection', (s) => s.selection.clear());
  uiStore.update('transport', () => {});
}
