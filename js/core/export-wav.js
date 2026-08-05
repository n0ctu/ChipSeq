// Offline render to a mono 16-bit PCM WAV file, via the same flatten +
// scheduleNote path as live playback.

import { flattenSong, clipEventsToRegion } from './flatten.js';
import { scheduleNote, getInstrument } from './instruments.js';
import { buildGraph, applyLimiter } from './graph.js';
import { needsStereo } from './doc.js';
import { tickToSeconds } from './doc.js';

const SAMPLE_RATE = 44100;

// opts.region: {startTick, endTick} - render exactly that slice, rebased to
// 0 and cut to the exact region length so the file loops seamlessly.
// opts.stereo: render two channels even when nothing is panned.
// Returns {blob, level}, where level reports the pre-limiter peak so the
// export dialog can warn about a mix that only fits because it was limited.
export async function renderWav(doc, opts = {}) {
  let { events } = flattenSong(doc);
  const region = opts.region && opts.region.endTick > opts.region.startTick ? opts.region : null;
  if (region) events = clipEventsToRegion(events, region.startTick, region.endTick);
  // Region events are rebased to 0, so a tick here is an OFFSET into the
  // region - it has to be shifted back to its absolute position before the
  // tempo map can say what time it lands at. With a single tempo entry the
  // shift makes no difference; with two it is the difference between a
  // region export playing at the right speed and the wrong one.
  const base = region ? region.startTick : 0;
  const at = (tick) => tickToSeconds(doc, tick + base) - tickToSeconds(doc, base);

  let lengthS;
  if (region) {
    lengthS = at(region.endTick - region.startTick);
  } else {
    let maxRelease = 0.01;
    for (const inst of doc.instruments) maxRelease = Math.max(maxRelease, inst.adsr.r);
    let endS = 0.5;
    for (const ev of events) {
      endS = Math.max(endS, at(ev.startTick + ev.durationTicks));
    }
    lengthS = endS + maxRelease + 0.3;
  }

  // Stereo ONLY when something is actually panned, so an unpanned project
  // renders the same mono file it always did - same size, same bytes, half
  // the disk of a stereo file carrying two identical channels.
  const channels = opts.stereo || needsStereo(doc) ? 2 : 1;
  const ctx = new OfflineAudioContext(channels, Math.ceil(SAMPLE_RATE * lengthS), SAMPLE_RATE);
  // Same output stage as playback, but rendered UNSHAPED: the clipper is
  // applied to the finished buffer instead, which is the only way to read the
  // true pre-limiter peak (an intermediate node can't be tapped offline).
  const graph = buildGraph(ctx, doc, { limiter: false });
  for (const ev of events) {
    if (ev.durationTicks <= 0) continue;
    scheduleNote(ctx, graph.nodeFor(ev.trackId), getInstrument(doc, ev.instrumentId), {
      pitch: ev.pitch,
      startTime: at(ev.startTick),
      stopTime: at(ev.startTick + ev.durationTicks),
      velocity: ev.velocity,
      gainMul: ev.gainMul ?? 1,
      gainCurve: ev.gainCurve ?? null,
      duty: ev.duty ?? null,
      adsr: ev.adsr ?? null,
      detune: ev.detune ?? 0,
      lfo: ev.lfo ?? null,
      pan: ev.pan ?? null,
    });
  }
  const buffer = await ctx.startRendering();
  const level = applyLimiter(buffer, doc);
  return { blob: encodeWav(buffer), level, channels };
}

export function encodeWav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const data = [];
  for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));
  const frames = data[0].length;
  const dataSize = frames * channels * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleaved frames: L R L R ... - what every player expects.
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++, offset += 2) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
