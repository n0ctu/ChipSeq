// Status bar: cursor position, selection info, mono conflicts chip, zoom.

import { ticksPerBeat, ticksPerBar } from '../core/doc.js';
import { noteName } from '../core/music.js';
import { APP_VERSION } from '../core/version.js';

export function initStatusBar({ store, uiStore, conflicts, roll }) {
  const $ = (id) => document.getElementById(id);
  const ui = uiStore.state;

  $('st-brand').textContent = `ChipSeq by n0ctu - v${APP_VERSION}`;

  function render() {
    const doc = store.getDoc();
    const tpb = ticksPerBeat(doc);
    const tpBar = ticksPerBar(doc);
    const t = ui.gridCursor.tick;
    const bar = Math.floor(t / tpBar) + 1;
    const beat = Math.floor((t % tpBar) / tpb) + 1;
    const sub = Math.round(((t % tpb) / tpb) * 100);
    $('st-pos').textContent = `${bar}.${beat}${sub ? '+' + sub + '%' : ''} - ${noteName(ui.gridCursor.pitch)}`;

    $('st-sel').textContent = ui.selection.size
      ? `${ui.selection.size} note${ui.selection.size === 1 ? '' : 's'} selected`
      : '';

    const n = conflicts.count();
    const chip = $('st-conflicts');
    if (n > 0 && doc.mode === 'mono') {
      chip.innerHTML = `&#9888; ${n} conflict${n === 1 ? '' : 's'} - press N <span class="stfix">Auto-fix</span>`;
    } else {
      chip.textContent = '';
    }

    $('st-zoom').textContent = Math.round(ui.pxPerTick * 200) / 2 + '%';
  }

  $('st-conflicts').addEventListener('click', (e) => {
    if (e.target.classList.contains('stfix')) {
      conflicts.autoFix();
    } else {
      const next = conflicts.nextTick(ui.gridCursor.tick);
      if (next != null) {
        uiStore.update('cursor', (s) => {
          s.gridCursor.tick = next;
        });
        roll.scrollTickIntoView(next);
      }
    }
  });

  store.subscribe(['notes', 'tracks', 'song', 'doc'], render);
  uiStore.subscribe(['cursor', 'selection', 'view'], render);

  const save = document.getElementById('st-save');
  store.on('saved', () => {
    save.textContent = 'saved';
    setTimeout(() => (save.textContent = ''), 1500);
  });
  store.on('storage-error', (err) => {
    save.textContent = '⚠ save failed: ' + (err && err.name === 'QuotaExceededError' ? 'storage full - delete old projects' : 'storage error');
  });

  render();
}
