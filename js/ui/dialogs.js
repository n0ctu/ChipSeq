// Native <dialog> helpers. openDialog returns a Promise resolving with the
// dialog's returnValue; focus is restored to the invoking element on close.

import { trackColorHex, hasTrackColor } from '../core/doc.js';

export function openDialog(dlg) {
  const opener = document.activeElement;
  dlg.returnValue = 'cancel';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => {
        if (opener && opener.focus) opener.focus();
        resolve(dlg.returnValue);
      },
      { once: true }
    );
  });
}

export async function confirmDialog(title, text, okLabel = 'OK') {
  const dlg = document.getElementById('dlg-confirm');
  dlg.querySelector('#confirm-title').textContent = title;
  dlg.querySelector('#confirm-text').textContent = text;
  dlg.querySelector('#btn-confirm-ok').textContent = okLabel;
  return (await openDialog(dlg)) === 'ok';
}

export async function promptDialog(title, initial = '') {
  const dlg = document.getElementById('dlg-prompt');
  dlg.querySelector('#prompt-title').textContent = title;
  const input = dlg.querySelector('#prompt-input');
  input.value = initial;
  // Enter must confirm - the form's default submit button is Cancel (first
  // in tree order), so implicit submission would DISCARD the input.
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dlg.close('ok');
    }
  };
  setTimeout(() => input.select(), 0);
  const result = await openDialog(dlg);
  return result === 'ok' ? input.value.trim() : null;
}

// Rename + recolour in one dialog: they are the two things you change about a
// track as an object, and splitting them across two interactions for the sake
// of one text field would be worse.
//
// Returns { name, color } or null. color is either a palette INDEX, leaving
// the theme in charge of the shade, or a literal "#rrggbb" for anything the
// palette does not cover. Always explicit - colours used to be able to follow
// row position, which meant reordering reshuffled them.
export async function trackDialog(track, colorCount = 8) {
  const dlg = document.getElementById('dlg-track');
  const input = dlg.querySelector('#track-name');
  const swatches = dlg.querySelector('#track-colors');
  input.value = track.name;

  // The two controls are one field. A swatch stores a palette index, which
  // follows the theme; the hex box stores a literal colour, which does not.
  // Whichever was touched last wins, so the dialog can never hand back both.
  const hexInput = dlg.querySelector('#track-hex');
  const ownHex = trackColorHex(track);
  let picked = Number.isInteger(track.color) ? track.color : 0;
  hexInput.value = ownHex || '';
  swatches.innerHTML = '';
  for (let i = 0; i < colorCount; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (!ownHex && picked === i ? ' on' : '');
    b.style.background = `var(--track-${i + 1})`;
    b.dataset.color = String(i);
    b.title = `Colour ${i + 1}`;
    swatches.appendChild(b);
  }
  swatches.onclick = (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    picked = Number(b.dataset.color);
    hexInput.value = ''; // picking a swatch means "back to the palette"
    hexInput.classList.remove('invalid');
    for (const el of swatches.children) {
      el.classList.toggle('on', el === b);
    }
  };
  hexInput.oninput = () => {
    const hex = hexInput.value.trim();
    // Empty is valid - it means "use the swatch". Anything else has to parse
    // before it is allowed to claim the selection.
    const ok = !hex || !!trackColorHex({ color: hex });
    hexInput.classList.toggle('invalid', !ok);
    if (hex) for (const el of swatches.children) el.classList.remove('on');
    else for (const el of swatches.children) el.classList.toggle('on', Number(el.dataset.color) === picked);
  };
  // Enter confirms; the form's first button is Cancel, so implicit submission
  // would otherwise discard everything.
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dlg.close('ok');
    }
  };
  setTimeout(() => input.select(), 0);
  const result = await openDialog(dlg);
  if (result !== 'ok') return null;
  // A hex that does not parse is discarded rather than stored - a typo must
  // not end up in the project file as a colour nothing can render. It leaves
  // the track's existing colour ALONE rather than falling back to the swatch,
  // which would silently repaint a hex track to palette entry 0 on a typo.
  const typed = hexInput.value.trim();
  const hex = trackColorHex({ color: typed });
  const color = hex || (typed && hasTrackColor(track) ? track.color : picked);
  return { name: input.value.trim() || track.name, color };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Transient floating context menu; closes on any click/Escape.
export function contextMenu(x, y, items) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.addEventListener('click', () => {
      close();
      item.action();
    });
    menu.appendChild(btn);
  }
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDown = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}
