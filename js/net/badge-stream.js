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

import { badgeScore, sliceScore, toSchedNotes } from '../core/badge-score.js';

// How far ahead scheduled chunks are pushed, and how often. The protocol asks
// for 2-4 seconds of lead; refreshing twice per window means a dropped frame
// has a second chance before anything goes silent.
export const CHUNK_MS = 3000;
export const REFRESH_MS = 1500;

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
      const t0 = originServerMs + sentUpTo;
      const notes = toSchedNotes(slice, sentUpTo);
      // Every badge on this track gets the IDENTICAL frame - two badges
      // playing one part is a supported arrangement, not a special case.
      for (const b of badges) client.sched(b.id, Math.round(t0), notes);
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

  return {
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
    _state: () => ({ mode, running, sentUpTo, originServerMs, tracks: [...scores.keys()] }),
  };
}
