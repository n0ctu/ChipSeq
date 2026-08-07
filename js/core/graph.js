// The output stage, shared by live playback and offline rendering.
//
// Before this module the two disagreed: the engine ran everything through a
// 0.9 master gain while the WAV exporter connected voices straight to the
// destination, so exports rendered ~1 dB hotter than the preview and could
// clip where playback did not. One builder now defines the chain for both.
//
// The chain ends in a soft clipper so the downmix can never leave the master
// above 0 dBFS. A stateless WaveShaper was chosen over DynamicsCompressorNode
// deliberately: a lookahead compressor's behaviour depends on its internal
// state, which would let realtime and offline renders drift apart, and
// preview === export is the invariant the whole app rests on.

import { trackGain, trackPan, needsStereo, hasPanLane, buses, trackSends, tickToSeconds } from './doc.js';
import { buildChain } from './effects.js';

// Level of the summed mix before the clipper. Unchanged from the engine's
// original master so existing projects keep their balance.
export const MASTER_GAIN = 0.9;
export const METRO_GAIN = 0.25;

// The WaveShaper curve always spans an input of [-1, +1], so the signal is
// scaled down by HEADROOM on the way in and the curve maps it back. Without
// this, anything above 0 dBFS - exactly the case we exist to handle - would
// be hard-clamped by the node before our curve ever saw it. 4x covers +12 dB.
const HEADROOM = 4;

export const DEFAULT_LIMITER = {
  kind: 'limiter',
  v: 1,
  enabled: true,
  ceilingDb: -0.1, // absolute maximum the output may reach
  kneeDb: -3, // below this the response is exactly unity - untouched
};

// ---- make-up ----
//
// Levels only ever attenuates: N^-k is <= 1 by definition, so a mostly
// polyphonic song sits permanently below unity and nothing brings it back.
// Measured on Bad Apple that left 6.8 dB of headroom unused - quiet for a
// finished piece.
//
// Make-up is the missing half, and it is deliberately NOT automatic: it is
// set by pressing Analyse, which renders once and measures the true
// pre-limiter peak. A stored number means preview and export apply exactly
// the same gain, which a value recomputed per render could not promise.
export const MAKEUP_TARGET_DB = -1; // where Analyse aims the peak
export const MAKEUP_MIN_DB = -24;
export const MAKEUP_MAX_DB = 24;
export const DEFAULT_MAKEUP = { kind: 'makeup', v: 1, db: 0 };

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

// Projects carry their own limiter block (schema rule: nested, self-versioned,
// so it can evolve without a document version bump). There is deliberately no
// UI switch yet - the data supports one when we want it.
export function makeupConfig(doc) {
  const cfg = doc && doc.master && doc.master.makeup;
  if (!cfg) return DEFAULT_MAKEUP;
  const db = Number(cfg.db);
  return {
    ...DEFAULT_MAKEUP,
    ...cfg,
    db: Number.isFinite(db) ? Math.max(MAKEUP_MIN_DB, Math.min(MAKEUP_MAX_DB, db)) : 0,
  };
}

export function makeupGain(doc) {
  return dbToLin(makeupConfig(doc).db);
}

export function limiterConfig(doc) {
  const cfg = doc && doc.master && doc.master.limiter;
  return cfg ? { ...DEFAULT_LIMITER, ...cfg } : DEFAULT_LIMITER;
}

// The shaping function, and the single source of truth for the curve.
//
// Unity up to the knee, then a tanh bend that approaches the ceiling without
// ever reaching it. The scale factor (C - T) makes the bend's initial slope
// exactly 1, so the transition into the knee is smooth rather than a corner.
export function softClip(x, cfg = DEFAULT_LIMITER) {
  const T = dbToLin(cfg.kneeDb);
  const C = dbToLin(cfg.ceilingDb);
  const a = Math.abs(x);
  if (a <= T) return x;
  const y = T + (C - T) * Math.tanh((a - T) / (C - T));
  return x < 0 ? -y : y;
}

// Sampled form of softClip() for a WaveShaper. Table index spans the scaled
// input domain [-HEADROOM, +HEADROOM]; 4097 points keep the interpolation
// error far below a 16-bit sample step.
export function softClipCurve(cfg = DEFAULT_LIMITER, n = 4097) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * HEADROOM;
    curve[i] = softClip(x, cfg);
  }
  return curve;
}

// Build the output chain into `ctx` (an AudioContext or an OfflineAudioContext).
//
// Returns { master, metro, limited }. Voices connect to `master`. The
// metronome connects to `metro`, which deliberately bypasses the clipper: it
// is a click track, so it must neither duck when the mix is hot nor influence
// the limiting of the music itself.
//
// opts.limiter=false renders the mix unshaped, which the WAV exporter uses so
// it can measure the true pre-limiter peak before applying the same softClip()
// to the rendered samples. That keeps one shaping function for both paths.
export function buildOutputGraph(ctx, doc, { metronome = false, limiter = true } = {}) {
  const cfg = limiterConfig(doc);
  const master = ctx.createGain();
  // The one place make-up is applied, so live and offline cannot differ.
  master.gain.value = MASTER_GAIN * makeupGain(doc);

  let tail = master;
  if (limiter && cfg.enabled) {
    const pre = ctx.createGain();
    pre.gain.value = 1 / HEADROOM;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(cfg);
    shaper.oversample = 'none'; // no resampling - keeps renders reproducible
    master.connect(pre);
    pre.connect(shaper);
    tail = shaper;
  }
  tail.connect(ctx.destination);

  let metro = null;
  if (metronome) {
    metro = ctx.createGain();
    metro.gain.value = METRO_GAIN;
    metro.connect(ctx.destination);
  }
  return { master, metro, limited: tail !== master };
}

// The full graph: one node per track, feeding the shared output stage.
//
//   voices -> track gain [-> pan] -> master -> limiter -> destination
//
// Giving every track its own node is the step that makes pan possible at all,
// turns per-track level into an audio operation rather than a number baked
// into each voice, and leaves the seam a stems export would need.
//
// Both the engine and the WAV renderer call this, so a track's level cannot
// mean one thing live and another in the file.
export function buildGraph(ctx, doc, opts = {}) {
  const out = buildOutputGraph(ctx, doc, opts);
  return { ...out, ...buildRouting(ctx, doc, out.master) };
}

// Buses first, then tracks - a send needs somewhere to arrive.
//
//   voices -> track gain [-> pan] -> master
//                        \-> send gain -> bus chain -> master
//
// The send tap comes off the track node, so a track's fader moves its sends
// with it. That is what "send" means on every desk ever built, and it is why
// pulling a track down does not leave its reverb hanging there.
export function buildRouting(ctx, doc, master) {
  const busNodes = buildBuses(ctx, doc, master);
  const tracks = buildTrackNodes(ctx, doc, master, busNodes);
  return {
    ...tracks,
    busNodes,
    disconnect: () => {
      tracks.disconnect();
      busNodes.disconnect();
    },
  };
}

// One chain per bus, each landing on the master so bus output is limited
// along with everything else.
export function buildBuses(ctx, doc, master) {
  const byId = new Map();
  const nodes = [];
  const skipped = [];
  const env = { tickSeconds: (ticks) => tickToSeconds(doc, ticks) };
  for (const bus of buses(doc)) {
    const built = buildChain(ctx, bus.chain, env);
    built.output.connect(master);
    byId.set(bus.id, built);
    nodes.push(built.input, built.output);
    skipped.push(...built.skipped);
  }
  byId.skipped = skipped;
  byId.disconnect = () => nodes.forEach((n) => n.disconnect());
  return byId;
}

// Just the per-track layer, so the engine can rebuild it when tracks are
// added, removed or panned without tearing down the output stage (and with
// it the limiter and the peak tap the UI reads).
export function buildTrackNodes(ctx, doc, master, busNodes = null) {
  const trackNodes = new Map();
  const nodes = []; // everything to disconnect on rebuild, panners included
  const stereo = ctx.destination.channelCount > 1 && needsStereo(doc);

  for (const track of doc.tracks) {
    const node = ctx.createGain();
    node.gain.value = trackGain(track);
    // A pan LANE overrides the static value, so the track node must not pan
    // as well - the voices do it themselves, per event.
    const pan = hasPanLane(track) ? 0 : trackPan(track);
    // A StereoPannerNode is inserted ONLY when it will do something. At
    // pan 0 it still applies the -3 dB centre law and, downmixed into a mono
    // render, that would quietly make every unpanned export 3 dB quieter.
    if (stereo && pan !== 0 && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      node.connect(panner);
      panner.connect(master);
      nodes.push(panner);
    } else {
      node.connect(master);
    }
    // Sends tap the track node - post-fader, pre-pan. Post-fader so the send
    // follows the fader; pre-pan because a bus is mono-in by construction and
    // panning the send would only halve it.
    if (busNodes) {
      for (const send of trackSends(doc, track)) {
        const bus = busNodes.get(send.busId);
        if (!bus) continue;
        const tap = ctx.createGain();
        tap.gain.value = send.level;
        node.connect(tap);
        tap.connect(bus.input);
        nodes.push(tap);
      }
    }
    nodes.push(node);
    trackNodes.set(track.id, node);
  }

  // Anything whose track we cannot resolve still has to be heard, not
  // silently dropped - a missing node would turn a routing bug into silence.
  const nodeFor = (trackId) => trackNodes.get(trackId) || master;

  return { trackNodes, nodeFor, stereo, disconnect: () => nodes.forEach((n) => n.disconnect()) };
}

// Measure a rendered buffer and apply the clipper to it in place.
//
// The offline path shapes samples here rather than through the WaveShaper so
// the peak can be read *before* limiting - a warning saying "your mix is
// 3.2 dB over" is far more useful than one saying "something was limited".
// Both paths share softClip(), so the only difference is table interpolation,
// which sits well below the 16-bit quantization that follows.
export function applyLimiter(buffer, doc) {
  const cfg = limiterConfig(doc);
  const ceiling = dbToLin(cfg.ceilingDb);
  let peak = 0;
  let shaped = 0;
  let total = 0;

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    total += data.length;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
      if (!cfg.enabled) continue;
      if (a > ceiling) shaped++;
      data[i] = softClip(data[i], cfg);
    }
  }
  return {
    peak, // linear, pre-limiter
    peakDb: linToDb(peak),
    over: peak > 1, // would have clipped without the limiter
    shapedRatio: total ? shaped / total : 0,
    limited: cfg.enabled,
  };
}
