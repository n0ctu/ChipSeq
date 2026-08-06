// Native <dialog> helpers. openDialog returns a Promise resolving with the
// dialog's returnValue; focus is restored to the invoking element on close.

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
// Returns { name, color } or null. color is a palette INDEX, so the theme
// stays in charge of the actual shade.
export async function trackDialog(track, colorCount = 8) {
  const dlg = document.getElementById('dlg-track');
  const input = dlg.querySelector('#track-name');
  const swatches = dlg.querySelector('#track-colors');
  input.value = track.name;

  let picked = Number.isInteger(track.color) ? track.color : null;
  swatches.innerHTML = '';
  for (let i = 0; i < colorCount; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (picked === i ? ' on' : '');
    b.style.background = `var(--track-${i + 1})`;
    b.dataset.color = String(i);
    b.title = `Colour ${i + 1}`;
    swatches.appendChild(b);
  }
  // "Auto" keeps the old behaviour - colour follows the row's position - and
  // is what every track uses until someone picks one.
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'swatch swatch-auto' + (picked === null ? ' on' : '');
  auto.dataset.color = 'auto';
  auto.textContent = 'auto';
  auto.title = 'Follow the track order';
  swatches.appendChild(auto);

  swatches.onclick = (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    picked = b.dataset.color === 'auto' ? null : Number(b.dataset.color);
    for (const el of swatches.children) {
      el.classList.toggle('on', el === b);
    }
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
  return { name: input.value.trim() || track.name, color: picked };
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
