// Sending a song to badges, in the two modes the protocol offers.
//
// The measurement that shaped this (docs/badge-protocol.md §6, over a real
// Tailscale Funnel):
//
//   live       50 ms onset error   - the relay round trip, on every note
//   scheduled  0.3 ms              - paid once, in advance
//
// So SCHEDULED is the default and live exists to be compared against. Both are
// kept because the difference is worth being able to demonstrate, and because
// on a LAN the gap narrows to the point where live's simplicity may win.
//
// I/O only. What the music IS comes from js/core/badge-score.js.

import { badgeScore, sliceScore, toSchedNotes, schedT0 } from '../core/badge-score.js';
import { badgeCan } from './badges.js';

// How far ahead scheduled chunks are pushed, and how often. The protocol asks
// for 2-4 seconds of lead; refreshing twice per window means a dropped frame
// has a second chance before anything goes silent.
export const CHUNK_MS = 3000;
export const REFRESH_MS = 1500;

// Auditioning a note sends it to EVERY connected badge, not just the ones
// mapped to the track being edited. Clicking a note is "let me hear this", and
// an unmapped badge is idle anyway - it also makes the whole rig answer, which
// is the fastest way to see that eight badges are alive before a show.
//
// Held down, an arrow key repeats around 30 times a second. That is 30 frames
// per badge over a relay for something nobody can hear as separate notes, so
// previews are rate-limited and DROPPED rather than queued - the same "late is
// worse than absent" rule the rest of the protocol follows.
export const PREVIEW_MIN_GAP_MS = 60;

// A decorated note is sent as a scheduled chunk so its timing survives the
// relay. The lead has to clear the round trip - measured at 50 ms over a real
// Funnel - with enough margin that the first note is not already late.
export const PREVIEW_LEAD_MS = 250;

export function createBadgeStream({ client, store }) {
  let mode = 'sched'; // 'sched' | 'live'
  let timer = null;
  let scores = new Map(); // trackId -> score
  let sentUpTo = 0; // ms into the song that has been scheduled
  let originServerMs = 0; // server time at song position 0
  let running = false;

  const badgesByTrack = () => {
    const out = new Map();
    for (const b of client.state.badges) {
      if (!b.trackId || !b.online) continue;
      if (!out.has(b.trackId)) out.set(b.trackId, []);
      out.get(b.trackId).push(b);
    }
    return out;
  };

  // Scores are computed once per transport start, not per chunk: flattening a
  // song is not free, and the document cannot change mid-playback without the
  // engine re-flattening and restarting anyway.
  function buildScores() {
    const doc = store.getDoc();
    scores = new Map();
    for (const trackId of badgesByTrack().keys()) {
      scores.set(trackId, badgeScore(doc, trackId));
    }
  }

  // ---- scheduled ----

  function pump() {
    if (!running || mode !== 'sched') return;
    const nowInSong = client.serverNow() - originServerMs;
    const horizon = nowInSong + CHUNK_MS;
    if (horizon <= sentUpTo) return;

    for (const [trackId, badges] of badgesByTrack()) {
      const score = scores.get(trackId);
      if (!score) continue;
      const slice = sliceScore(score, sentUpTo, horizon);
      if (!slice.length) continue;
      // t0 and the offsets are derived together so they cannot disagree: both
      // come from the same rounding of the same origin. See toSchedNotes.
      const t0 = schedT0(originServerMs, sentUpTo);
      const notes = toSchedNotes(slice, originServerMs, t0);
      // Every badge on this track gets the IDENTICAL frame - two badges
      // playing one part is a supported arrangement, not a special case.
      for (const b of badges) client.sched(b.id, t0, notes);
    }
    sentUpTo = horizon;
  }

  // ---- live ----
  //
  // Driven by the engine's own scheduler rather than a second clock: the same
  // loop that decides what the speakers play decides what the badges play, so
  // the two cannot disagree about the song.
  function onEngineEvents(events) {
    if (!running || mode !== 'live') return;
    const byTrack = badgesByTrack();
    if (!byTrack.size) return;
    for (const ev of events) {
      const badges = byTrack.get(ev.trackId);
      if (!badges) continue;
      const ms = Math.round(ev.durationMs ?? 0);
      if (ms <= 0) continue;
      for (const b of badges) client.note(b.id, ev.pitch, ms);
    }
  }

  // ---- auditioning ----
  //
  // A note played by hand in the piano roll, on every badge at once.
  // -Infinity, not 0: the throttle must never swallow the FIRST preview. With
  // 0 it only works by accident, because Date.now() happens to be far from the
  // epoch - an injected clock starting at 0 loses the first note.
  let lastPreviewAt = -Infinity;

  function preview(notes, now = Date.now()) {
    // Never over a running transport. The badges are mid-song with a queue
    // already filled; a note arriving now plays on top of it, which is heard
    // as the ensemble glitching rather than as an audition.
    if (running) return false;
    if (!notes || !notes.length) return false;
    if (now - lastPreviewAt < PREVIEW_MIN_GAP_MS) return false;

    const online = client.state.badges.filter((b) => b.online);
    if (!online.length) return false;
    lastPreviewAt = now;

    const single = notes.length === 1;
    const t0 = single ? 0 : Math.round(client.serverNow() + PREVIEW_LEAD_MS);
    for (const b of online) {
      // One note goes as `note`: it plays the moment it lands, which is the
      // lowest latency available and needs no clock on the badge.
      if (single) {
        client.note(b.id, notes[0].pitch, notes[0].durMs);
      } else if (badgeCan(b, 'sched')) {
        client.sched(b.id, t0, notes.map((n) => [n.offsetMs, n.pitch, n.durMs]));
      } else {
        // No clock, so a burst of `note` frames would arrive as one blur.
        // The first event is the note actually under the cursor, so playing
        // just that is the honest reduction rather than a jumble.
        client.note(b.id, notes[0].pitch, notes[0].durMs);
      }
    }
    return true;
  }

  return {
    preview,
    setMode(next) {
      if (next === mode) return;
      this.stop();
      mode = next === 'live' ? 'live' : 'sched';
    },
    getMode: () => mode,

    // songMs: where playback starts within the song.
    start(songMs = 0) {
      buildScores();
      running = true;
      sentUpTo = songMs;
      // Where song position 0 sits on the server's clock. Everything
      // scheduled is expressed against this, so a badge and the browser are
      // talking about the same instant.
      originServerMs = client.serverNow() - songMs;
      if (mode === 'sched') {
        pump();
        clearInterval(timer);
        timer = setInterval(pump, REFRESH_MS);
      }
    },

    stop() {
      running = false;
      clearInterval(timer);
      timer = null;
      for (const b of client.state.badges) if (b.trackId) client.stop(b.id);
    },

    onEngineEvents,
    // Exposed for tests and the latency lab.
    _state: () => ({ mode, running, sentUpTo, originServerMs, lastPreviewAt, tracks: [...scores.keys()] }),
  };
}
