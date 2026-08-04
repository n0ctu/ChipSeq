// Playback engine: lookahead scheduler ("A Tale of Two Clocks"), transport,
// loop, metronome, note audition.

import { flattenSong } from './flatten.js';
import { scheduleNote, getInstrument } from './instruments.js';
import { ticksPerBeat, ticksPerBar, songEndTick } from './doc.js';
import { createEmitter } from './store.js';

const SCHEDULE_INTERVAL_MS = 25;
const LOOKAHEAD_S = 0.12;

export function createEngine(store) {
  const emitter = createEmitter();
  let audioCtx = null;
  let masterGain = null;
  let metroGain = null;

  let playing = false;
  let timer = null;
  let events = [];
  let eventIndex = 0;
  let passStartTick = 0; // tick corresponding to passStartTime
  let passStartTime = 0; // AudioContext time of current (loop) pass start
  let secondsPerTick = 0;
  let nextBeatTick = 0;
  let liveNodes = new Set();

  function ensureCtx() {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.9;
      masterGain.connect(audioCtx.destination);
      metroGain = audioCtx.createGain();
      metroGain.gain.value = 0.25;
      metroGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function tickToTime(tick) {
    return passStartTime + (tick - passStartTick) * secondsPerTick;
  }

  function currentLoop() {
    const loop = store.getLoop();
    if (!loop || !loop.enabled || loop.endTick <= loop.startTick) return null;
    return loop;
  }

  function refreshEvents(fromTick) {
    const doc = store.getDoc();
    secondsPerTick = 60 / (doc.song.bpm * doc.ppq);
    events = flattenSong(doc).events;
    eventIndex = events.findIndex((e) => e.startTick + e.durationTicks > fromTick);
    if (eventIndex < 0) eventIndex = events.length;
  }

  function scheduleWindow() {
    const doc = store.getDoc();
    const horizon = audioCtx.currentTime + LOOKAHEAD_S;
    const loop = currentLoop();
    const tpb = ticksPerBeat(doc);
    const tpBar = ticksPerBar(doc);
    const endTick = loop ? loop.endTick : Math.max(songEndTick(doc), 1);

    let guard = 0;
    while (guard++ < 10000) {
      // Metronome beats
      if (store.session.metronome) {
        while (nextBeatTick < endTick && tickToTime(nextBeatTick) < horizon) {
          const isDownbeat = nextBeatTick % tpBar === 0;
          scheduleMetroTick(tickToTime(nextBeatTick), isDownbeat);
          nextBeatTick += tpb;
        }
      }

      // Note events
      let scheduledAll = true;
      while (eventIndex < events.length) {
        const ev = events[eventIndex];
        if (ev.startTick >= endTick) break;
        const start = tickToTime(Math.max(ev.startTick, passStartTick));
        if (start >= horizon) {
          scheduledAll = false;
          break;
        }
        const stop = Math.min(tickToTime(ev.startTick + ev.durationTicks), tickToTime(endTick));
        if (stop > start) {
          const node = scheduleNote(audioCtx, masterGain, getInstrument(doc, ev.instrumentId), {
            pitch: ev.pitch,
            startTime: start,
            stopTime: stop,
            velocity: ev.velocity,
            gainMul: ev.gainMul ?? 1,
            gainCurve: ev.gainCurve ?? null,
            duty: ev.duty ?? null,
            adsr: ev.adsr ?? null,
          });
          liveNodes.add(node);
          node.onended = () => liveNodes.delete(node);
        }
        eventIndex++;
      }
      if (!scheduledAll) break;

      // Reached endTick within the window: loop or stop.
      const endTime = tickToTime(endTick);
      if (endTime >= horizon) break;
      if (loop) {
        passStartTime = endTime;
        passStartTick = loop.startTick;
        refreshEvents(loop.startTick);
        nextBeatTick = Math.ceil(loop.startTick / tpb) * tpb;
      } else {
        if (audioCtx.currentTime >= endTime) stop();
        break;
      }
    }
  }

  function scheduleMetroTick(time, downbeat) {
    const osc = audioCtx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = downbeat ? 1760 : 880;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(1, time);
    g.gain.linearRampToValueAtTime(0, time + 0.03);
    osc.connect(g).connect(metroGain);
    osc.start(time);
    osc.stop(time + 0.035);
  }

  function play(fromTick) {
    ensureCtx();
    if (playing) stop();
    const doc = store.getDoc();
    const loop = currentLoop();
    let startTick = fromTick;
    if (loop && (startTick < loop.startTick || startTick >= loop.endTick)) {
      startTick = loop.startTick;
    }
    playing = true;
    passStartTick = startTick;
    passStartTime = audioCtx.currentTime + 0.06;
    refreshEvents(startTick);
    const tpb = ticksPerBeat(doc);
    nextBeatTick = Math.ceil(startTick / tpb) * tpb;
    scheduleWindow();
    timer = setInterval(() => {
      try {
        scheduleWindow();
      } catch (err) {
        console.error(err);
        stop();
      }
    }, SCHEDULE_INTERVAL_MS);
    emitter.emit('playstate', { playing: true, fromTick: startTick });
  }

  function stop() {
    if (!playing) return;
    playing = false;
    if (timer) clearInterval(timer);
    timer = null;
    for (const node of liveNodes) {
      try {
        node.stop();
      } catch {}
    }
    liveNodes.clear();
    emitter.emit('playstate', { playing: false });
  }

  // Re-flatten mid-playback when the document changes (edit while playing).
  store.subscribe(['notes', 'tracks', 'song', 'harmonics', 'automation', 'doc'], () => {
    if (!playing) return;
    const tickNow = getPlayheadTick();
    stop();
    play(tickNow);
  });

  function getPlayheadTick() {
    if (!playing || !audioCtx) return store.session.cursorTick;
    const t = Math.max(audioCtx.currentTime, passStartTime);
    return passStartTick + (t - passStartTime) / secondsPerTick;
  }

  function previewNote(pitch, instrumentId) {
    ensureCtx();
    const doc = store.getDoc();
    const id = doc.mode === 'mono' ? 'badge' : instrumentId || 'badge';
    const now = audioCtx.currentTime + 0.01;
    scheduleNote(audioCtx, masterGain, getInstrument(doc, id), {
      pitch,
      startTime: now,
      stopTime: now + 0.18,
      velocity: 100,
    });
  }

  // Continuous audition loop: repeats a reference note, re-resolving the
  // instrument each cycle so parameter edits are heard live. Pass a getter
  // returning an instrument object (or null to stop / auto-stop).
  let auditionTimer = null;
  function setAudition(getInstrumentFn) {
    if (auditionTimer) {
      clearInterval(auditionTimer);
      auditionTimer = null;
    }
    if (!getInstrumentFn) return;
    ensureCtx();
    const tickFn = () => {
      const inst = getInstrumentFn();
      if (!inst) {
        setAudition(null);
        return;
      }
      const now = audioCtx.currentTime + 0.02;
      scheduleNote(audioCtx, masterGain, inst, {
        pitch: 69,
        startTime: now,
        stopTime: now + 0.35,
        velocity: 100,
      });
    };
    tickFn();
    auditionTimer = setInterval(tickFn, 600);
  }

  // Audition a list of {pitch,startTick,durationTicks,velocity} events
  // (e.g. one note's rendered arpeggio) relative to now.
  function previewEvents(events, instrumentId) {
    if (!events || !events.length) return;
    ensureCtx();
    const doc = store.getDoc();
    const id = doc.mode === 'mono' ? 'badge' : instrumentId || 'badge';
    const spt = 60 / (doc.song.bpm * doc.ppq);
    const t0 = audioCtx.currentTime + 0.03;
    const baseTick = Math.min(...events.map((e) => e.startTick));
    for (const ev of events) {
      scheduleNote(audioCtx, masterGain, getInstrument(doc, id), {
        pitch: ev.pitch,
        startTime: t0 + (ev.startTick - baseTick) * spt,
        stopTime: t0 + (ev.startTick - baseTick + ev.durationTicks) * spt,
        velocity: ev.velocity ?? 100,
      });
    }
  }

  return {
    play,
    stop,
    isPlaying: () => playing,
    getPlayheadTick,
    previewNote,
    previewEvents,
    setAudition,
    isAuditioning: () => !!auditionTimer,
    ensureCtx,
    on: emitter.on,
  };
}
