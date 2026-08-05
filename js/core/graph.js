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

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

// Projects carry their own limiter block (schema rule: nested, self-versioned,
// so it can evolve without a document version bump). There is deliberately no
// UI switch yet - the data supports one when we want it.
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
  master.gain.value = MASTER_GAIN;

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
