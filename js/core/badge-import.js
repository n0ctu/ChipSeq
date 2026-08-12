// A .cbt tune, reversed into a project - the badge's flattened milliseconds
// recovered onto the tick grid so the notes are editable again.
//
// This is a CONVERSION, not a restoration, and the distinction is the whole
// UX of the feature. The format stores the performance: arpeggios were
// flattened into plain notes when the tune was built, instruments, automation
// and effects were never in it (the badge is one square wave), and a tempo map
// was collapsed to the single bpmHint in the header. What comes back is an
// editable score - the same class of thing as importing a rendered MIDI file,
// and the caller is expected to say so to the user.
//
// The timing, though, is exact in the case that matters. Recovering ticks via
// bpmHint and regenerating the milliseconds reproduces the stored values
// precisely for every tune this app has ever built at a constant tempo -
// measured across every demo, 6341 notes, zero drift - because both directions
// round the same way. tests/unit.mjs holds buildTune(import(buildTune(doc)))
// byte-identical to buildTune(doc). Off-grid notes (a tune built elsewhere, or
// at another tempo) are snapped to the nearest tick - auto-quantize, reported
// rather than silent, in `worstOffGridMs`.

import { createProject, createTrack, createNote, setTempo, sortNotes, PPQ } from './doc.js';

// A tune with no bpmHint (the field is display-only in the spec, so a foreign
// writer may leave it 0) still has to land on SOME grid. 120 is the app's own
// default tempo; the warning tells the user the grid was assumed.
const FALLBACK_BPM = 120;

export function tuneToProject(tune) {
  const warnings = [];
  const bpm = tune.bpmHint > 0 ? tune.bpmHint : FALLBACK_BPM;
  if (!(tune.bpmHint > 0)) {
    warnings.push(`the tune reports no tempo - notes were placed on a ${FALLBACK_BPM} BPM grid`);
  }

  const msPerTick = 60000 / (bpm * PPQ);
  const msToTick = (ms) => Math.round(ms / msPerTick);

  const doc = createProject({
    name: tune.name || 'Fetched tune',
    mode: tune.tracks.length > 1 ? 'poly' : 'mono',
  });
  doc.tracks = [];
  setTempo(doc, bpm);

  let worstOffGridMs = 0;
  for (const src of tune.tracks) {
    const track = createTrack({
      name: src.name || `Track ${doc.tracks.length + 1}`,
      role: 'melody',
      instrumentId: doc.mode === 'mono' ? 'badge' : 'square',
      doc,
    });
    track.notes = src.notes.map((n) => {
      const startTick = msToTick(n.startMs);
      // A zero-length note would be invisible and uneditable; the shortest
      // thing the grid can say is one tick.
      const durationTicks = Math.max(1, msToTick(n.startMs + n.durMs) - startTick);
      worstOffGridMs = Math.max(worstOffGridMs, Math.abs(n.startMs - startTick * msPerTick));
      return createNote({ pitch: n.pitch, startTick, durationTicks });
    });
    sortNotes(track);
    doc.tracks.push(track);
  }
  doc.activeTrackId = doc.tracks[0] ? doc.tracks[0].id : null;

  // The discriminator is NOT half a tick - rounding bounds the error there by
  // construction, so that threshold could never fire. It is half a
  // MILLISECOND: the format stores integer ms, so a note that was genuinely on
  // this grid sits within 0.5 ms of it (measured across every demo: worst
  // 0.500). Past that, the tune was built on some other grid and the notes
  // really were moved; the user should hear it, not discover it.
  if (worstOffGridMs > 0.6) {
    warnings.push(`notes sat off the grid by up to ${worstOffGridMs.toFixed(1)} ms and were quantized to the nearest tick`);
  }

  if (tune.loopEndMs > tune.loopStartMs) {
    doc.loop = { startTick: msToTick(tune.loopStartMs), endTick: msToTick(tune.loopEndMs), enabled: false };
  }

  return { doc, warnings, worstOffGridMs };
}
