// Post-import track assignment dialog: user confirms melody/chords roles.
// Each row has a preview play button so the auto-suggestion can be verified
// by ear before importing.

import { openDialog } from './dialogs.js';
import { icon } from './icons.js';
import { suggestRoles, trackStats } from '../core/midi-import.js';
import { keyName, PPQ } from '../core/music.js';
import { scheduleNote } from '../core/instruments.js';

const ROLES = [
  { id: 'melody', label: 'Melody' },
  { id: 'chords', label: 'Chords' },
  { id: 'muted', label: 'Import muted' },
  { id: 'skip', label: 'Skip' },
];

const PREVIEW_MAX_S = 15;
const PREVIEW_INSTRUMENT = {
  id: 'preview-square', name: 'Preview', wave: 'square',
  harmonics: null, duty: null,
  adsr: { a: 0.002, d: 0, s: 1, r: 0.002 }, gain: 0.3,
};

// Lightweight standalone player - the import dialog runs before any project
// exists, so it cannot use the transport engine.
function createPreviewPlayer(bpm) {
  let audioCtx = null;
  let currentGain = null;
  let playingIndex = null;
  let stopTimer = null;
  const secondsPerTick = 60 / ((bpm || 120) * PPQ);

  function stop() {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
    if (currentGain) {
      // fast fade to avoid clicks, then drop the whole subgraph
      const g = currentGain;
      const t = audioCtx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.03);
      setTimeout(() => g.disconnect(), 100);
      currentGain = null;
    }
    playingIndex = null;
  }

  function play(track, index, onEnded) {
    stop();
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    currentGain = audioCtx.createGain();
    currentGain.gain.value = 1;
    currentGain.connect(audioCtx.destination);
    playingIndex = index;

    const t0 = audioCtx.currentTime + 0.05;
    const firstTick = track.notes[0].startTick; // skip leading silence
    let endS = 0;
    for (const n of track.notes) {
      const startS = (n.startTick - firstTick) * secondsPerTick;
      if (startS > PREVIEW_MAX_S) break;
      const stopS = Math.min(startS + n.durationTicks * secondsPerTick, PREVIEW_MAX_S);
      scheduleNote(audioCtx, currentGain, PREVIEW_INSTRUMENT, {
        pitch: n.pitch,
        startTime: t0 + startS,
        stopTime: t0 + stopS,
        velocity: n.velocity,
      });
      endS = Math.max(endS, stopS);
    }
    stopTimer = setTimeout(() => {
      stop();
      onEnded();
    }, (endS + 0.2) * 1000);
  }

  return {
    toggle(track, index, onEnded) {
      if (playingIndex === index) {
        stop();
        return false;
      }
      play(track, index, onEnded);
      return true;
    },
    stop,
    close() {
      stop();
      if (audioCtx) audioCtx.close();
      audioCtx = null;
    },
  };
}

// Returns assignments [{index, role, name}] or null on cancel.
export async function midiImportDialog(parsed) {
  const dlg = document.getElementById('dlg-midi-import');
  const table = document.getElementById('midi-track-table');
  const meta = document.getElementById('midi-import-meta');
  const suggested = suggestRoles(parsed.tracks);
  const player = createPreviewPlayer(parsed.song.bpm);

  const bits = [];
  if (parsed.song.bpm != null) bits.push(`${parsed.song.bpm} BPM`);
  if (parsed.song.timeSig) bits.push(`${parsed.song.timeSig.num}/${parsed.song.timeSig.den}`);
  if (parsed.song.key) bits.push(keyName(parsed.song.key) + (parsed.song.keyGuessed ? ' (guessed from the notes)' : ''));
  meta.innerHTML =
    (bits.length ? 'Detected: ' + bits.join(' - ') : 'No tempo/key metadata found - current song settings are kept.') +
    '<br>Don’t worry about getting it perfect: melody and chords can be exchanged later' +
    ' with the M/C buttons in the track list.';

  const rows = parsed.tracks.map((t, i) => {
    const poly = Math.round(trackStats(t).polyRatio * 100);
    return `
      <tr>
        <td><button type="button" class="btn btn-icon midi-preview" data-index="${i}" title="Preview this track">${icon('player-play')}</button></td>
        <td>${escapeHtml(t.name)}${t.isDrums ? ' 🥁' : ''}</td>
        <td>${t.channel != null ? t.channel + 1 : ''}</td>
        <td>${t.notes.length}</td>
        <td>${poly}%</td>
        <td>
          <select data-index="${i}" class="midi-role">
            ${ROLES.map((r) => `<option value="${r.id}" ${suggested[i] === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}
          </select>
        </td>
      </tr>`;
  });
  table.innerHTML = `
    <table class="midi-table">
      <thead><tr><th></th><th>Instrument / track</th><th>Ch</th><th>Notes</th><th>Chords</th><th>Import as</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;

  const resetButtons = () => {
    for (const b of table.querySelectorAll('.midi-preview')) b.innerHTML = icon('player-play');
  };
  // onclick (not addEventListener) so re-opening the dialog replaces the handler
  table.onclick = (e) => {
    const btn = e.target.closest('.midi-preview');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    resetButtons();
    const started = player.toggle(parsed.tracks[index], index, resetButtons);
    if (started) btn.innerHTML = icon('player-pause');
  };

  const result = await openDialog(dlg);
  player.close();
  if (result !== 'ok') return null;

  const assignments = [];
  for (const sel of table.querySelectorAll('.midi-role')) {
    const index = Number(sel.dataset.index);
    assignments.push({ index, role: sel.value, name: parsed.tracks[index].name });
  }
  // At most one chords track: keep the first, downgrade the rest to muted.
  let chordsSeen = false;
  for (const a of assignments) {
    if (a.role === 'chords') {
      if (chordsSeen) a.role = 'muted';
      chordsSeen = true;
    }
  }
  if (assignments.every((a) => a.role === 'skip')) return null;
  return assignments;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
