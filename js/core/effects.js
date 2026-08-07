// Effect builders. One entry per kind, one builder each.
//
// Every builder takes (ctx, spec, env) and returns { input, output } - two
// nodes and nothing else. That signature is the whole extensibility story:
// buses chain builders in order without knowing what any of them are, and
// adding an effect is one entry in EFFECTS plus one function.
//
// Both an AudioContext and an OfflineAudioContext go through here, so nothing
// may depend on wall-clock time, on Math.random, or on anything that differs
// between the two - otherwise preview and export drift apart, which is the
// invariant the app rests on. The reverb impulse is generated from a seeded
// PRNG for exactly this reason.
//
// There is deliberately no per-effect dry/wet. These live on SENDS: the dry
// path is the track's own output, and how much of it arrives is the send
// level. A mix knob on top would be a second control for one thing.

// Specs are nested and self-versioned (format rule 1), so an effect can grow
// its params without touching SCHEMA_VERSION.
export const DEFAULT_EFFECTS = {
  delay: { kind: 'delay', v: 1, params: { timeTicks: 48, feedback: 0.35 } },
  filter: { kind: 'filter', v: 1, params: { type: 'lowpass', freq: 1200, q: 0.7 } },
  reverb: { kind: 'reverb', v: 1, params: { seconds: 1.6, decay: 2.5 } },
};

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

// Deterministic noise. A ConvolverNode needs an impulse and we refuse to fetch
// one (no external requests, ever), so it is synthesised - but Math.random()
// would give the live and offline renders different reverbs, so the sequence
// is seeded and therefore identical everywhere.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Exponentially decaying noise burst: the cheapest impulse that sounds like a
// room rather than a delay line. Pure in (sampleRate, seconds, decay), so two
// contexts at the same rate get bit-identical reverbs.
export function impulseResponse(sampleRate, seconds, decay) {
  const len = Math.max(1, Math.floor(sampleRate * seconds));
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  const rand = mulberry32(0x9e3779b9);
  for (let i = 0; i < len; i++) {
    const env = Math.pow(1 - i / len, decay);
    left[i] = (rand() * 2 - 1) * env;
    right[i] = (rand() * 2 - 1) * env;
  }
  return { left, right, length: len };
}

export const EFFECTS = {
  delay: {
    name: 'Delay',
    // env.tickSeconds converts the grid-synced time, so a delay stays in
    // step with the song rather than drifting when the tempo changes.
    build(ctx, spec, env = {}) {
      const p = { ...DEFAULT_EFFECTS.delay.params, ...(spec && spec.params) };
      const seconds = env.tickSeconds
        ? env.tickSeconds(clamp(p.timeTicks, 1, 96 * 32, 48))
        : clamp(p.timeTicks, 1, 96 * 32, 48) / 96 * 0.5;
      const input = ctx.createGain();
      const delay = ctx.createDelay(Math.max(1, seconds + 1));
      delay.delayTime.value = Math.max(0.001, seconds);
      const fb = ctx.createGain();
      // Below 1 by construction: at 1 the loop never decays and the render
      // grows without bound, which is a hang rather than a sound.
      fb.gain.value = clamp(p.feedback, 0, 0.95, 0.35);
      const output = ctx.createGain();
      input.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(output);
      return { input, output };
    },
  },

  filter: {
    name: 'Filter',
    build(ctx, spec) {
      const p = { ...DEFAULT_EFFECTS.filter.params, ...(spec && spec.params) };
      const node = ctx.createBiquadFilter();
      const types = ['lowpass', 'highpass', 'bandpass', 'notch'];
      node.type = types.includes(p.type) ? p.type : 'lowpass';
      node.frequency.value = clamp(p.freq, 20, 20000, 1200);
      node.Q.value = clamp(p.q, 0.0001, 20, 0.7);
      // One node is both ends of the chain link - nothing says input and
      // output have to be different nodes.
      return { input: node, output: node };
    },
  },

  reverb: {
    name: 'Reverb',
    build(ctx, spec) {
      const p = { ...DEFAULT_EFFECTS.reverb.params, ...(spec && spec.params) };
      const seconds = clamp(p.seconds, 0.05, 8, 1.6);
      const decay = clamp(p.decay, 0.1, 10, 2.5);
      const conv = ctx.createConvolver();
      const ir = impulseResponse(ctx.sampleRate, seconds, decay);
      const buf = ctx.createBuffer(2, ir.length, ctx.sampleRate);
      buf.copyToChannel(ir.left, 0);
      buf.copyToChannel(ir.right, 1);
      conv.buffer = buf;
      conv.normalize = true; // keeps a long tail from swamping the mix
      return { input: conv, output: conv };
    },
  },
};

export const EFFECT_KINDS = Object.keys(EFFECTS);

// Build a chain of specs into one input/output pair. An unknown kind is
// SKIPPED rather than failing the graph: a project from a newer build should
// lose that effect, not its whole sound.
export function buildChain(ctx, chain, env = {}) {
  const specs = Array.isArray(chain) ? chain : [];
  const input = ctx.createGain();
  let tail = input;
  const skipped = [];
  for (const spec of specs) {
    const def = spec && EFFECTS[spec.kind];
    if (!def) {
      if (spec && spec.kind) skipped.push(spec.kind);
      continue;
    }
    const built = def.build(ctx, spec, env);
    tail.connect(built.input);
    tail = built.output;
  }
  return { input, output: tail, skipped };
}
