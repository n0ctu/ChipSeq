// Status bar: cursor position, selection info, mono conflicts chip, zoom.

import { ticksPerBeat, ticksPerBar } from '../core/doc.js';
import { noteName } from '../core/music.js';
import { APP_VERSION } from '../core/version.js';
import { onStorageDegraded } from '../core/persist.js';

export function initStatusBar({ store, uiStore, conflicts, roll, engine }) {
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

  // Clip indicator: the master limiter means a hot mix still sounds clean, so
  // without this the only symptom would be a vaguely squashed preview. The
  // peak is read before the limiter and latched briefly - a single overshoot
  // lasts a few milliseconds and would otherwise be impossible to notice.
  if (engine) {
    const clip = $('st-clip');
    let poll = null;
    let latchUntil = 0;
    engine.on('playstate', ({ playing }) => {
      if (poll) clearInterval(poll);
      poll = null;
      if (!playing) {
        clip.textContent = '';
        return;
      }
      latchUntil = 0;
      poll = setInterval(() => {
        const now = performance.now();
        if (engine.getPeak() > 1) latchUntil = now + 1500;
        clip.textContent = now < latchUntil ? '⚠ mix over 0 dB' : '';
      }, 100);
    });
  }

  const save = document.getElementById('st-save');
  store.on('saved', () => {
    if (save.classList.contains('warn')) return; // never overwrite "not saving"
    save.textContent = 'saved';
    setTimeout(() => (save.textContent = ''), 1500);
  });
  // A repaired reference changed the project, so say so - the alternative is
  // a file that quietly differs from what the user left behind.
  store.on('doc-repaired', (warnings) => {
    if (save.classList.contains('warn')) return; // "not saving" outranks this
    save.textContent = '⚠ ' + warnings[0] + (warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '');
    setTimeout(() => (save.textContent = ''), 6000);
  });
  // Storage that stopped working is a persistent condition, not an event:
  // once it is reported the message stays put, because every later edit is
  // also not being saved and the user needs that on screen, not for 3 seconds.
  const reportNotSaving = (reason) => {
    save.textContent = `⚠ not saving - ${reason}`;
    save.classList.add('warn');
  };
  onStorageDegraded(reportNotSaving);
  store.on('storage-error', (err) => {
    reportNotSaving(
      err && err.name === 'QuotaExceededError' ? 'storage is full - delete old projects' : (err && err.message) || 'storage error'
    );
  });

  render();
}
