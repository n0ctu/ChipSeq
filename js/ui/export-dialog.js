// Export dialog: .h (mono badge header), .wav render, .tune.json project file.

import { openDialog, downloadBlob } from './dialogs.js';
import { exportHeader, sanitizeSymbolName } from '../core/export-h.js';
import { exportFmf } from '../core/export-fmf.js';
import { renderWav } from '../core/export-wav.js';
import { exportTuneJson } from '../core/persist.js';
import { ticksPerBar, needsStereo, trackPan, hasPanLane } from '../core/doc.js';

export function initExportDialog({ store, conflicts }) {
  const dlg = document.getElementById('dlg-export');
  const $ = (id) => dlg.querySelector('#' + id);
  let tab = 'h';
  let lastHeader = null;
  let lastFmf = null;

  function fileBase(doc) {
    return (doc.name || 'tune').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tune';
  }

  // {startTick, endTick} when "loop region only" applies, else null.
  function exportRegion() {
    const loop = store.getLoop();
    if (!loop || loop.endTick <= loop.startTick) return null;
    if (tab === 'json' || !$('chk-export-region').checked) return null;
    return { startTick: loop.startTick, endTick: loop.endTick };
  }

  function renderRegionRow() {
    const doc = store.getDoc();
    const loop = store.getLoop();
    const row = $('export-region-row');
    const box = $('chk-export-region');
    row.hidden = tab === 'json';
    if (!loop || loop.endTick <= loop.startTick) {
      box.checked = false;
      box.disabled = true;
      $('export-region-label').textContent = 'Only export the loop region (none set - drag on the ruler)';
    } else {
      box.disabled = false;
      const tpBar = ticksPerBar(doc);
      const from = Math.floor(loop.startTick / tpBar) + 1;
      const to = Math.ceil(loop.endTick / tpBar);
      $('export-region-label').textContent = `Only export the loop region (bars ${from}-${to})`;
    }
  }

  // Report the rendered mix level. The limiter guarantees the file itself is
  // clean, so silence here would hide the fact that it only fits because it
  // was shaped - a mix 3 dB over sounds squashed and the user needs to know
  // why, not just that "it exported fine".
  function showLevel(level) {
    const el = $('export-level');
    if (!level) {
      el.textContent = '';
      el.classList.remove('warn');
      return;
    }
    const db = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
    if (level.over) {
      const pct = (level.shapedRatio * 100).toFixed(1);
      el.textContent =
        `⚠ Mix peaks at ${db(level.peakDb)} - the limiter held the file to 0 dB, ` +
        `shaping ${pct}% of it. Lower track or instrument gains for a cleaner render.`;
      el.classList.add('warn');
    } else {
      el.textContent = `Peak ${db(level.peakDb)} - headroom is fine.`;
      el.classList.remove('warn');
    }
  }

  // The output used to be described as "mono mix" in a hint that stopped
  // being true the moment panning shipped. Say what the file will actually
  // be, and what decides it, so stereo is a visible state rather than a side
  // effect of having moved a slider.
  function renderChannels() {
    const doc = store.getDoc();
    const row = $('export-channels');
    const box = $('chk-export-stereo');
    const forced = box.checked;
    const panned = doc.tracks.filter((t) => trackPan(t) !== 0 || hasPanLane(t));
    const auto = needsStereo(doc);
    row.hidden = tab !== 'wav';
    box.parentElement.hidden = tab !== 'wav' || doc.mode !== 'poly';
    if (doc.mode !== 'poly') {
      row.textContent = 'Output: mono - a mono project has one voice to place.';
    } else if (auto) {
      row.textContent =
        `Output: stereo - ${panned.length} of ${doc.tracks.length} track${doc.tracks.length === 1 ? '' : 's'} panned.`;
    } else if (forced) {
      row.textContent = 'Output: stereo - forced; nothing is panned, so both channels will match.';
    } else {
      row.textContent = 'Output: mono - nothing is panned. Pan a track in the Mixer, or force stereo below.';
    }
  }

  function renderTabs() {
    const doc = store.getDoc();
    const monoDisabled = doc.mode !== 'mono' || conflicts.count() > 0;
    const monoTitle =
      doc.mode !== 'mono'
        ? 'only available in Mono mode'
        : conflicts.count() > 0
          ? `Resolve ${conflicts.count()} overlapping notes first (press N)`
          : '';
    if ((tab === 'h' || tab === 'fmf') && monoDisabled) tab = 'wav';

    for (const btn of dlg.querySelectorAll('#seg-export .seg-btn')) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
      if (btn.dataset.tab === 'h' || btn.dataset.tab === 'fmf') {
        btn.disabled = monoDisabled;
        btn.title = monoTitle;
      }
    }
    $('export-h-pane').hidden = tab !== 'h';
    $('export-fmf-pane').hidden = tab !== 'fmf';
    $('export-wav-pane').hidden = tab !== 'wav';
    renderChannels();
    $('export-json-pane').hidden = tab !== 'json';
    $('btn-export-copy').hidden = tab !== 'h' && tab !== 'fmf';
    renderRegionRow();

    if (tab === 'h' || tab === 'fmf') renderPreview();
  }

  function renderPreview() {
    const doc = store.getDoc();
    if (tab === 'fmf') {
      try {
        lastFmf = exportFmf(doc, { region: exportRegion() });
        $('export-fmf-preview').textContent = lastFmf.text;
        $('export-fmf-warnings').innerHTML = lastFmf.warnings.map((w) => `<div>⚠ ${w}</div>`).join('');
      } catch (err) {
        lastFmf = null;
        $('export-fmf-preview').textContent = '';
        $('export-fmf-warnings').innerHTML = `<div>⚠ ${err.message}</div>`;
      }
      return;
    }
    lastHeader = exportHeader(doc, $('inp-symbol').value, { region: exportRegion() });
    $('export-preview').textContent = lastHeader.text;
    $('export-warnings').innerHTML = lastHeader.warnings.map((w) => `<div>⚠ ${w}</div>`).join('');
  }

  dlg.querySelector('#seg-export').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn && !btn.disabled) {
      tab = btn.dataset.tab;
      renderTabs();
    }
  });

  $('inp-symbol').addEventListener('input', renderPreview);
  // Enter in the array-name field must not implicitly submit (= Close)
  $('inp-symbol').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });

  $('chk-export-stereo').addEventListener('change', renderChannels);

  $('chk-export-region').addEventListener('change', () => {
    if (tab === 'h' || tab === 'fmf') renderPreview();
  });

  $('btn-export-copy').addEventListener('click', async () => {
    const current = tab === 'fmf' ? lastFmf : lastHeader;
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.text);
      $('btn-export-copy').textContent = 'Copied!';
      setTimeout(() => ($('btn-export-copy').textContent = 'Copy'), 1200);
    } catch {
      $('btn-export-copy').textContent = 'Copy failed';
    }
  });

  $('btn-export-download').addEventListener('click', async () => {
    const doc = store.getDoc();
    const base = fileBase(doc);
    const region = exportRegion();
    const suffix = region ? '-loop' : '';
    if (tab === 'h') {
      renderPreview();
      downloadBlob(new Blob([lastHeader.text], { type: 'text/plain' }), base + suffix + '.h');
    } else if (tab === 'fmf') {
      renderPreview();
      if (lastFmf) downloadBlob(new Blob([lastFmf.text], { type: 'text/plain' }), base + suffix + '.fmf');
    } else if (tab === 'wav') {
      const btn = $('btn-export-download');
      btn.disabled = true;
      btn.textContent = 'Rendering…';
      try {
        const { blob, level } = await renderWav(doc, { region, stereo: $('chk-export-stereo').checked });
        showLevel(level);
        downloadBlob(blob, base + suffix + '.wav');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Download';
      }
    } else {
      downloadBlob(exportTuneJson(doc), base + '.tune.json');
    }
  });

  return {
    open() {
      const doc = store.getDoc();
      $('inp-symbol').value = sanitizeSymbolName(doc.name);
      showLevel(null); // never show the previous render's level
      $('chk-export-stereo').checked = false;
      tab = doc.mode === 'mono' && conflicts.count() === 0 ? 'h' : 'wav';
      renderTabs();
      openDialog(dlg);
    },
  };
}
