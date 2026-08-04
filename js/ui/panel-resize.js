// Draggable resize handles for the side panels; widths persist across
// sessions in localStorage.

const KEY = 'chipseq.v1.panelw';
const MIN_W = 130;
const MAX_W = 480;

function loadWidths() {
  try {
    const w = JSON.parse(localStorage.getItem(KEY)) || {};
    // legacy key from before the panel was renamed to "harmonics"
    if (w.arp && !w.harmonics) w.harmonics = w.arp;
    return w;
  } catch {
    return {};
  }
}

export function initPanelResizers() {
  const widths = loadWidths();
  const panels = [
    { id: 'tracks-panel', side: 'right', key: 'tracks' },
    { id: 'harmonics-panel', side: 'left', key: 'harmonics' },
  ];

  for (const cfg of panels) {
    const panel = document.getElementById(cfg.id);
    if (widths[cfg.key]) panel.style.width = widths[cfg.key] + 'px';

    const handle = document.createElement('div');
    handle.className = 'panel-resize ' + cfg.side;
    handle.title = 'Drag to resize';
    panel.appendChild(handle);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      const move = (ev) => {
        const delta = cfg.side === 'right' ? ev.clientX - startX : startX - ev.clientX;
        const w = Math.min(MAX_W, Math.max(MIN_W, startW + delta));
        panel.style.width = w + 'px';
      };
      const up = () => {
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        const w = Math.round(panel.getBoundingClientRect().width);
        const saved = loadWidths();
        saved[cfg.key] = w;
        try {
          localStorage.setItem(KEY, JSON.stringify(saved));
        } catch {}
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // double-click resets to the default width
    handle.addEventListener('dblclick', () => {
      panel.style.width = '';
      const saved = loadWidths();
      delete saved[cfg.key];
      try {
        localStorage.setItem(KEY, JSON.stringify(saved));
      } catch {}
    });
  }
}
