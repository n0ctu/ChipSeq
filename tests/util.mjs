// Shared helpers for the browser-based test suites.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Locate a Chrome/Chromium binary: CHROME_BIN env var, Playwright's cache,
// then common system paths.
export function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const pw = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(pw)) {
    const dirs = readdirSync(pw)
      .filter((d) => d.startsWith('chromium'))
      .sort()
      .reverse();
    for (const dir of dirs) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const p = join(pw, dir, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]) {
    if (existsSync(p)) return p;
  }
  throw new Error('No Chromium found - set CHROME_BIN to a Chrome/Chromium binary.');
}

// A synthetic arp-heavy song, for the tests that guard playback performance.
//
// Modelled on the real thing that broke: a poly project with a chord track and
// many notes carrying autoSong arps at 16 steps per beat, which is what a
// demoscene remake looks like in this app. autoSong is the expensive kind -
// every note resolves its chord against the chord track - so this exercises
// the path that costs, not the cheap one. Deterministic: no randomness, ids
// come from createNote but nothing here depends on their values.
//
// Kept in tests rather than demos/ deliberately: it is a stress fixture, not
// music, and Nico's real project is a work in progress that is not committed.
export async function arpHeavySong({ arpNotes = 400, chordNotes = 800 } = {}) {
  const { createProject, createTrack, createNote, PPQ } = await import('../js/core/doc.js');
  const doc = createProject({ name: 'Arp stress', mode: 'poly' });
  doc.tracks = [];

  // A chord track that costs what a real one costs. buildChordEvents is
  // O(unique starts x notes), and a real chord track is not block chords on
  // bar lines: the one that broke had 774 notes at 773 distinct starts -
  // comping, offbeats, broken figures. Block chords on the bar (100 starts)
  // made this fixture 5x too cheap and let the fps test pass with the cache
  // bypassed. So: every note starts on its own eighth-note slot. Same music
  // to the arps (they read the chord at their onset), honest to the profiler.
  const chords = createTrack({ name: 'Chords', role: 'melody', instrumentId: 'square', doc });
  const shapes = [[60, 64, 67], [57, 60, 64], [65, 69, 72], [67, 71, 74]];
  for (let i = 0; i < chordNotes; i++) {
    const startTick = i * (PPQ / 2);
    const bar = Math.floor(startTick / (PPQ * 4));
    const shape = shapes[bar % shapes.length];
    chords.notes.push(createNote({ pitch: shape[i % 3], startTick, durationTicks: PPQ * 2 }));
  }
  doc.tracks.push(chords);
  doc.chordTrackId = chords.id;

  // The arp tracks: long-ish notes, each arpeggiated against the song chords.
  const arp = {
    mode: 'arp', stepsPerBeat: 16, pattern: 'updown', octaves: 2, gate: 1,
    chordType: 'autoSong', anchor: 'above', octaveShift: 0,
  };
  const perTrack = Math.ceil(arpNotes / 4);
  for (let t = 0; t < 4; t++) {
    const track = createTrack({ name: `Arp ${t + 1}`, role: 'melody', instrumentId: 'square', doc });
    for (let i = 0; i < perTrack; i++) {
      track.notes.push(createNote({
        pitch: 60 + t * 3 + (i % 5),
        startTick: i * PPQ * 2 + t * (PPQ / 2),
        durationTicks: PPQ * 2,
        harmonics: { ...arp },
      }));
    }
    doc.tracks.push(track);
  }
  doc.activeTrackId = doc.tracks[1].id;
  doc.melodyTrackId = doc.tracks[1].id;
  return doc;
}
