// Ctrl+K: the commands table, made visible.
//
// It exists because the table exists - there is nothing here but a filter and
// a list. That is the point of Phase 9: once actions are data, enumerating
// them is free, and a command nobody can remember the shortcut for is still
// reachable.

import { openDialog } from './dialogs.js';
import { available, runCommand } from './commands.js';

// Shown as typed, not as coded: 'Ctrl+KeyZ' means nothing to a reader.
export function prettyChord(chord) {
  return chord
    .split('+')
    .map((part) => part.replace(/^Key/, '').replace(/^Digit/, '').replace('BracketLeft', '[').replace('BracketRight', ']'))
    .join('+');
}

export function initPalette(ctx) {
  const dlg = document.getElementById('dlg-palette');
  if (!dlg) return { open() {} };
  const input = dlg.querySelector('#palette-input');
  const list = dlg.querySelector('#palette-list');
  let shown = [];
  let cursor = 0;

  function render() {
    const q = input.value.trim().toLowerCase();
    // Only commands whose guard passes: offering "Undo" with nothing to undo
    // is a menu entry that lies.
    shown = available(ctx).filter((c) => !q || c.label.toLowerCase().includes(q));
    cursor = Math.max(0, Math.min(cursor, shown.length - 1));
    list.innerHTML = shown.length
      ? shown.map((c, i) => `
        <li class="palette-item${i === cursor ? ' on' : ''}" data-id="${c.id}">
          <span>${c.label}</span>
          ${c.keys && c.keys.length ? `<kbd>${prettyChord(c.keys[0])}</kbd>` : ''}
        </li>`).join('')
      : '<li class="palette-empty">Nothing matches.</li>';
  }

  function pick(cmd) {
    dlg.close();
    if (cmd) runCommand(cmd, ctx);
  }

  input.addEventListener('input', () => {
    cursor = 0;
    render();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      render();
      return;
    }
    if (e.key === 'Enter') {
      // The form's implicit submit would close the dialog without running
      // anything, which looks exactly like the command silently failing.
      e.preventDefault();
      pick(shown[cursor]);
    }
  });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-id]');
    if (li) pick(shown.find((c) => c.id === li.dataset.id));
  });

  return {
    open() {
      input.value = '';
      cursor = 0;
      render();
      openDialog(dlg);
      setTimeout(() => input.focus(), 0);
    },
  };
}
