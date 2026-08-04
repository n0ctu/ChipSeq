// Hand-rolled Standard MIDI File parser (format 0/1) + track role suggestion.
// Returns parsed data only — nothing is applied to the store here.
// Notes are split into one output track per (MTrk chunk, MIDI channel), so
// multi-instrument chunks (typical for format 0) become separate tracks.

import { PPQ, detectKey } from './music.js';

// General MIDI program names (0-127), used to label split channels.
export const GM_PROGRAMS = [
  'Grand Piano', 'Bright Piano', 'Electric Grand', 'Honky-tonk', 'E-Piano 1', 'E-Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Perc. Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Nylon Guitar', 'Steel Guitar', 'Jazz Guitar', 'Clean Guitar', 'Muted Guitar', 'Overdrive Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Finger Bass', 'Pick Bass', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato', 'Harp', 'Timpani',
  'String Ens. 1', 'String Ens. 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Square Lead', 'Saw Lead', 'Calliope Lead', 'Chiff Lead', 'Charang Lead', 'Voice Lead', 'Fifths Lead', 'Bass+Lead',
  'New Age Pad', 'Warm Pad', 'Polysynth Pad', 'Choir Pad', 'Bowed Pad', 'Metallic Pad', 'Halo Pad', 'Sweep Pad',
  'Rain FX', 'Soundtrack FX', 'Crystal FX', 'Atmosphere FX', 'Brightness FX', 'Goblins FX', 'Echoes FX', 'Sci-Fi FX',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone', 'Helicopter', 'Applause', 'Gunshot',
];

export function parseMidi(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let pos = 0;
  const warnings = [];

  const u32 = () => {
    const v = view.getUint32(pos);
    pos += 4;
    return v;
  };
  const u16 = () => {
    const v = view.getUint16(pos);
    pos += 2;
    return v;
  };
  const u8 = () => view.getUint8(pos++);
  const vlq = () => {
    let v = 0;
    for (;;) {
      const b = u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
  };

  if (u32() !== 0x4d546864) throw new Error('Not a MIDI file (missing MThd)');
  const headerLen = u32();
  const format = u16();
  const ntrks = u16();
  const division = u16();
  pos += headerLen - 6;

  if (format === 2) throw new Error('MIDI format 2 is not supported (use format 0 or 1)');
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');
  const toTick = (t) => Math.round((t * PPQ) / division);

  const song = { bpm: null, timeSig: null, key: null };
  const tracks = [];

  for (let tr = 0; tr < ntrks; tr++) {
    if (pos >= view.byteLength) break;
    if (u32() !== 0x4d54726b) throw new Error(`Track ${tr}: missing MTrk chunk`);
    const len = u32();
    const end = pos + len;

    let tick = 0;
    let runningStatus = 0;
    let name = '';
    // Per-channel state within this MTrk chunk.
    const channels = new Map(); // ch -> { notes: [], program: null, open: Map<pitch, [{startTick, velocity}]> }
    const chan = (ch) => {
      if (!channels.has(ch)) channels.set(ch, { notes: [], program: null, open: new Map() });
      return channels.get(ch);
    };

    while (pos < end) {
      tick += vlq();
      let status = view.getUint8(pos);
      if (status & 0x80) {
        pos++;
        if (status < 0xf0) runningStatus = status;
      } else {
        if (!runningStatus) throw new Error(`Track ${tr}: running status without prior status byte`);
        status = runningStatus;
      }

      const type = status & 0xf0;
      const ch = status & 0x0f;

      if (type === 0x90 || type === 0x80) {
        const pitch = u8();
        const vel = u8();
        const c = chan(ch);
        if (type === 0x90 && vel > 0) {
          if (!c.open.has(pitch)) c.open.set(pitch, []);
          c.open.get(pitch).push({ startTick: toTick(tick), velocity: vel });
        } else {
          const t = toTick(tick);
          const stack = c.open.get(pitch);
          if (stack && stack.length) {
            const started = stack.pop();
            const durationTicks = t - started.startTick;
            if (durationTicks > 0) {
              c.notes.push({ pitch, startTick: started.startTick, durationTicks, velocity: started.velocity });
            }
          }
        }
      } else if (type === 0xc0) {
        const program = u8();
        const c = chan(ch);
        if (c.program == null) c.program = program;
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
        pos += 2;
      } else if (type === 0xd0) {
        pos += 1;
      } else if (status === 0xff) {
        const metaType = u8();
        const metaLen = vlq();
        const metaEnd = pos + metaLen;
        if (metaType === 0x51 && metaLen === 3) {
          const usPerQuarter = (u8() << 16) | (u8() << 8) | u8();
          const bpm = Math.round((60e6 / usPerQuarter) * 10) / 10;
          if (song.bpm == null) song.bpm = bpm;
          else if (song.bpm !== bpm) warnings.push(`Tempo change to ${bpm} BPM ignored (single global BPM).`);
        } else if (metaType === 0x58 && metaLen >= 2) {
          const num = u8();
          const den = Math.pow(2, u8());
          if (!song.timeSig) song.timeSig = { num, den };
        } else if (metaType === 0x59 && metaLen >= 2) {
          const sf = view.getInt8(pos);
          const mi = view.getUint8(pos + 1);
          if (!song.key) song.key = keyFromSignature(sf, mi);
        } else if (metaType === 0x03) {
          name = new TextDecoder('latin1').decode(new Uint8Array(arrayBuffer, pos, metaLen));
        }
        pos = metaEnd;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += vlq();
      } else {
        warnings.push(`Track ${tr}: skipping unknown status 0x${status.toString(16)}`);
        break;
      }
    }

    pos = end;

    // One output track per channel that produced notes.
    const usedChannels = [...channels.keys()].sort((a, b) => a - b);
    for (const ch of usedChannels) {
      const c = channels.get(ch);
      // Close unterminated notes at end of chunk.
      for (const [pitch, stack] of c.open) {
        for (const started of stack) {
          const durationTicks = toTick(tick) - started.startTick;
          if (durationTicks > 0) {
            c.notes.push({ pitch, startTick: started.startTick, durationTicks, velocity: started.velocity });
          }
        }
      }
      if (!c.notes.length) continue;
      c.notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);

      const isDrums = ch === 9;
      const instrument = isDrums ? 'Drums' : c.program != null ? GM_PROGRAMS[c.program] : null;
      const label = name && instrument && name.trim() !== instrument
        ? `${name.trim()} · ${instrument}`
        : name.trim() || instrument || `Track ${tracks.length + 1}`;
      tracks.push({
        name: label,
        channel: ch,
        program: c.program,
        isDrums,
        notes: c.notes,
      });
    }
  }

  if (!tracks.length) throw new Error('No notes found in this MIDI file');

  // Most files carry no key-signature meta event — fall back to analyzing
  // the notes themselves (drums excluded, they are atonal).
  if (!song.key) {
    const tonal = tracks.filter((t) => !t.isDrums).flatMap((t) => t.notes);
    const guess = detectKey(tonal);
    if (guess) {
      song.key = { tonic: guess.tonic, mode: guess.mode };
      song.keyGuessed = true;
    }
  }
  return { song, tracks, warnings };
}

// sf: -7..7 (flats/sharps), mi: 0 major / 1 minor. Circle of fifths.
function keyFromSignature(sf, mi) {
  const majorTonics = [0, 7, 2, 9, 4, 11, 6, 1]; // C G D A E B F# C# for sf 0..7
  const majorFlats = [0, 5, 10, 3, 8, 1, 6, 11]; // C F Bb Eb Ab Db Gb Cb for sf 0..-7
  let tonic = sf >= 0 ? majorTonics[sf] : majorFlats[-sf];
  if (mi === 1) tonic = (tonic + 9) % 12; // relative minor
  return { tonic, mode: mi === 1 ? 'minor' : 'major' };
}

export function trackStats(track) {
  // Sweep to measure time with >=2 simultaneous notes vs total sounding time.
  const edges = [];
  let pitchSum = 0;
  for (const n of track.notes) {
    edges.push([n.startTick, 1], [n.startTick + n.durationTicks, -1]);
    pitchSum += n.pitch;
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  let prev = 0;
  let sounding = 0;
  let poly = 0;
  for (const [tick, delta] of edges) {
    if (depth >= 1) sounding += tick - prev;
    if (depth >= 2) poly += tick - prev;
    depth += delta;
    prev = tick;
  }
  return {
    polyRatio: sounding ? poly / sounding : 0,
    avgPitch: track.notes.length ? pitchSum / track.notes.length : 0,
    noteCount: track.notes.length,
  };
}

// GM family helpers for role scoring.
const isPianoFamily = (p) => p != null && p <= 7;
const isPadOrFx = (p) => p != null && p >= 88 && p <= 103; // pads + FX: fillers/ambience
const isGuitarOrOrgan = (p) => p != null && ((p >= 16 && p <= 31));
const isLeadFamily = (p) => p != null && ((p >= 40 && p <= 47) || (p >= 56 && p <= 79) || (p >= 80 && p <= 87));
const isBassFamily = (p) => p != null && p >= 32 && p <= 39;

// Suggest roles. Typical pop/game MIDI has several chord-ish layers (pads,
// fillers, ambience) — the "classic piano chords" track is what we want as
// the chord source, so piano/organ/guitar comping beats pads.
export function suggestRoles(tracks) {
  const stats = tracks.map((t, index) => ({ index, track: t, ...trackStats(t) }));
  const roles = new Array(tracks.length).fill('muted');

  // Drums are useless on a tonal square-wave badge.
  for (const s of stats) if (s.track.isDrums) roles[s.index] = 'skip';

  // Chords: polyphonic, not drums/bass. Score: instrument family first
  // (piano > organ/guitar > other > pad/FX), then polyphony.
  const chordScore = (s) => {
    const p = s.track.program;
    const family = isPianoFamily(p) ? 3 : isGuitarOrOrgan(p) ? 2 : !isPadOrFx(p) ? 1 : 0;
    return family * 10 + s.polyRatio;
  };
  const chordCandidates = stats
    .filter((s) => roles[s.index] === 'muted' && s.polyRatio >= 0.4 && !isBassFamily(s.track.program))
    .sort((a, b) => chordScore(b) - chordScore(a) || a.avgPitch - b.avgPitch);
  if (chordCandidates.length) roles[chordCandidates[0].index] = 'chords';

  // Melody: mostly monophonic, busiest wins; lead instruments get a boost.
  const melodyScore = (s) =>
    s.noteCount * (isLeadFamily(s.track.program) || isPianoFamily(s.track.program) ? 2 : 1);
  const melodyCandidates = stats
    .filter((s) => roles[s.index] === 'muted' && s.polyRatio < 0.2 && !isBassFamily(s.track.program))
    .sort((a, b) => melodyScore(b) - melodyScore(a));
  if (melodyCandidates.length) {
    roles[melodyCandidates[0].index] = 'melody';
  } else {
    const rest = stats
      .filter((s) => roles[s.index] === 'muted')
      .sort((a, b) => b.noteCount - a.noteCount);
    if (rest.length) roles[rest[0].index] = 'melody';
  }
  return roles;
}
