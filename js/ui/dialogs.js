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
  setTimeout(() => input.select(), 0);
  const result = await openDialog(dlg);
  return result === 'ok' ? input.value.trim() : null;
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
