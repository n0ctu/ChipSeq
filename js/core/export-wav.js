// Offline render to a mono 16-bit PCM WAV file, via the same flatten +
// scheduleNote path as live playback.

import { flattenSong, clipEventsToRegion } from './flatten.js';
import { scheduleNote, getInstrument } from './instruments.js';

const SAMPLE_RATE = 44100;

// opts.region: {startTick, endTick} - render exactly that slice, rebased to
// 0 and cut to the exact region length so the file loops seamlessly.
export async function renderWav(doc, opts = {}) {
  let { events } = flattenSong(doc);
  const region = opts.region && opts.region.endTick > opts.region.startTick ? opts.region : null;
  if (region) events = clipEventsToRegion(events, region.startTick, region.endTick);
  const secondsPerTick = 60 / (doc.song.bpm * doc.ppq);

  let lengthS;
  if (region) {
    lengthS = (region.endTick - region.startTick) * secondsPerTick;
  } else {
    let maxRelease = 0.01;
    for (const inst of doc.instruments) maxRelease = Math.max(maxRelease, inst.adsr.r);
    let endS = 0.5;
    for (const ev of events) {
      endS = Math.max(endS, (ev.startTick + ev.durationTicks) * secondsPerTick);
    }
    lengthS = endS + maxRelease + 0.3;
  }

  const ctx = new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * lengthS), SAMPLE_RATE);
  for (const ev of events) {
    if (ev.durationTicks <= 0) continue;
    scheduleNote(ctx, ctx.destination, getInstrument(doc, ev.instrumentId), {
      pitch: ev.pitch,
      startTime: ev.startTick * secondsPerTick,
      stopTime: (ev.startTick + ev.durationTicks) * secondsPerTick,
      velocity: ev.velocity,
      gainMul: ev.gainMul ?? 1,
      gainCurve: ev.gainCurve ?? null,
      duty: ev.duty ?? null,
      adsr: ev.adsr ?? null,
    });
  }
  const buffer = await ctx.startRendering();
  return encodeWav(buffer);
}

export function encodeWav(audioBuffer) {
  const samples = audioBuffer.getChannelData(0);
  const dataSize = samples.length * 2;
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
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
