// Playback engine: lookahead scheduler ("A Tale of Two Clocks"), transport,
// loop, metronome, note audition.

import { flattenSong } from './flatten.js';
import { scheduleNote, getInstrument } from './instruments.js';
import { ticksPerBeat, ticksPerBar, songEndTick, tickToSeconds, secondsToTick } from './doc.js';
import { createEmitter } from './store.js';
import { buildGraph, buildRouting } from './graph.js';

const SCHEDULE_INTERVAL_MS = 25;
const LOOKAHEAD_S = 0.12;
// Background tabs throttle timers (and remote sessions can stall the machine
// entirely). Anything whose start time already passed is dropped instead of
// being fired retroactively - otherwise the wake-up schedules a burst of
// overdue notes that all sound at once.
const STALE_S = 0.05;

export function createEngine(store) {
  const emitter = createEmitter();
  let audioCtx = null;
  let masterGain = null;
  let metroGain = null;
  let peakTap = null;
  let peakBuf = null;
  let graph = null;

  let playing = false;
  let timer = null;
  let events = [];
  let eventIndex = 0;
  let passStartTick = 0; // tick corresponding to passStartTime
  let passStartTime = 0; // AudioContext time of current (loop) pass start
  let nextBeatTick = 0;
  let liveNodes = new Set();

  function ensureCtx() {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      // The same builder the WAV exporter uses, so preview and export share
      // one output stage - including the clipper that keeps the mix under
      // 0 dBFS. The pre-limiter tap feeds the status-bar clip indicator.
      //
      // The graph is built once and outlives project switches. That is fine
      // today because the limiter block has no UI and every project resolves
      // to the same defaults - but whoever exposes it must rebuild (or retune)
      // this chain when the document changes, or a per-project ceiling would
      // silently keep whatever the first-opened project had.
      graph = buildGraph(audioCtx, store.getDoc(), { metronome: true });
      masterGain = graph.master;
      metroGain = graph.metro;
      peakTap = audioCtx.createAnalyser();
      peakTap.fftSize = 2048;
      masterGain.connect(peakTap); // tap only - peakTap has no output
      peakBuf = new Float32Array(peakTap.fftSize);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // Highest absolute sample seen in the analyser's most recent window, taken
  // BEFORE the clipper so the UI can say the mix is too hot rather than just
  // showing a level that the limiter has already flattened to the ceiling.
  function getPeak() {
    if (!peakTap) return 0;
    peakTap.getFloatTimeDomainData(peakBuf);
    let peak = 0;
    for (let i = 0; i < peakBuf.length; i++) {
      const a = Math.abs(peakBuf[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }

  // Anchored at the current pass start, but the span itself is integrated
  // across the tempo map - a constant secondsPerTick would silently be wrong
  // the moment a song carries a second tempo entry.
  function tickToTime(tick) {
    const doc = store.getDoc();
    return passStartTime + (tickToSeconds(doc, tick) - tickToSeconds(doc, passStartTick));
  }

  function currentLoop() {
    const loop = store.getLoop();
    if (!loop || !loop.enabled || loop.endTick <= loop.startTick) return null;
    return loop;
  }

  function refreshEvents(fromTick) {
    const doc = store.getDoc();
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
          const beatTime = tickToTime(nextBeatTick);
          if (beatTime >= audioCtx.currentTime - STALE_S) {
            scheduleMetroTick(beatTime, nextBeatTick % tpBar === 0);
          }
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
        if (start < audioCtx.currentTime - STALE_S) {
          eventIndex++; // overdue (tab was throttled/asleep) - never retro-play
          continue;
        }
        if (stop > start) {
          const node = scheduleNote(audioCtx, graph.nodeFor(ev.trackId), getInstrument(doc, ev.instrumentId), {
            pitch: ev.pitch,
            startTime: start,
            stopTime: stop,
            velocity: ev.velocity,
            gainMul: ev.gainMul ?? 1,
            gainCurve: ev.gainCurve ?? null,
            duty: ev.duty ?? null,
            adsr: ev.adsr ?? null,
            detune: ev.detune ?? 0,
            lfo: ev.lfo ?? null,
            pan: ev.pan ?? null,
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

  // Returning to a throttled tab: jump the event cursor to the real playhead
  // so the scheduler doesn't grind through (and drop) a backlog. The audition
  // loop is silenced while hidden - it must never beep in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      setAudition(null);
      return;
    }
    if (playing) refreshEvents(getPlayheadTick());
  });

  // The per-track layer follows the document: a new track needs a node, a
  // deleted one must stop being fed, and pan can only be applied by a node
  // that exists. Rebuilt rather than patched - it is a handful of nodes, and
  // inserting or removing a panner means rewiring anyway.
  store.subscribe(['tracks', 'doc'], () => {
    if (!audioCtx || !graph) return;
    graph.disconnect();
    // Routing, not just the track layer: a bus added or an effect retuned has
    // to be rebuilt too, and a send needs its bus to exist first.
    Object.assign(graph, buildRouting(audioCtx, store.getDoc(), graph.master));
  });

  // Re-flatten mid-playback when the document changes (edit while playing).
  store.subscribe(['notes', 'tracks', 'song', 'harmonics', 'automation', 'doc'], () => {
    if (!playing) return;
    const tickNow = getPlayheadTick();
    stop();
    play(tickNow);
  });

  function getPlayheadTick() {
    if (!playing || !audioCtx) return store.session.cursorTick;
    const doc = store.getDoc();
    const t = Math.max(audioCtx.currentTime, passStartTime);
    return secondsToTick(doc, tickToSeconds(doc, passStartTick) + (t - passStartTime));
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
    const t0 = audioCtx.currentTime + 0.03;
    const baseTick = Math.min(...events.map((e) => e.startTick));
    const at = (tick) => tickToSeconds(doc, tick) - tickToSeconds(doc, baseTick);
    for (const ev of events) {
      scheduleNote(audioCtx, masterGain, getInstrument(doc, id), {
        pitch: ev.pitch,
        startTime: t0 + at(ev.startTick),
        stopTime: t0 + at(ev.startTick + ev.durationTicks),
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
    // The live node for a track, so a mixer drag is audible before it commits.
    trackNode: (trackId) => (graph ? graph.trackNodes.get(trackId) : null),
    setAudition,
    getPeak,
    isAuditioning: () => !!auditionTimer,
    ensureCtx,
    on: emitter.on,
  };
}
