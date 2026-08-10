// Pushing a .cbt tune into a badge's flash, over the WebSocket.
//
// The protocol is docs/badge-protocol.md §6; this is the sequencer's half of
// it. Kept out of the card so the state machine can be tested without a DOM,
// and out of core because it is I/O - what the music IS comes from
// js/core/badge-tune.js.
//
// Two numbers shape it, and both come from the badge rather than from us:
//
//   WINDOW        an ESP32 blocks for tens of milliseconds writing flash. A
//                 sequencer that waited for each ack before sending the next
//                 chunk would upload at the speed of those writes; one that
//                 sent everything at once would have chunks arrive while the
//                 badge was mid-write, with nowhere to put them.
//   ACK_TIMEOUT   the public path is relayed, and a relay drops things. A
//                 chunk nobody acknowledged is re-sent rather than assumed.
//
// Resending is safe: the badge treats a repeated `seq` as idempotent, which is
// specified rather than incidental.

export const CHUNK_BYTES = 1024; // raw, before base64 (~1368 characters)
export const WINDOW = 4;
export const ACK_TIMEOUT_MS = 3000;
export const TICK_MS = 250;

// Chunk-wise base64. Doing it in one call would mean spreading a 39 kB array
// into String.fromCharCode's arguments, which overflows the argument limit on
// exactly the large tunes this most needs to work for.
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function splitChunks(bytes, size = CHUNK_BYTES) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(toBase64(bytes.subarray(i, i + size)));
  return out;
}

// Start an upload. Returns { promise, cancel, state } - `promise` settles when
// the badge commits or refuses, so a caller can await one upload and start the
// next without tracking frames itself.
//
// `send` and `now` are injectable so the whole machine can be driven in a test
// with no socket and no clock.
// What sending a tune should do to the tunes already on the badge.
//
// A tune's id IS its content - the CRC-32 of the bytes - and that is
// load-bearing for the mesh, so editing a song and sending it again produces a
// different id and the badge rightly stores both. But the person pressing Send
// is thinking in names, not checksums: to them the second copy is not a new
// tune, it is the same one improved, and two entries called "Tetris" is a bug.
// So Send REPLACES: same name, different id means the stale copies go.
//
// The badge's reported library is the ground truth here, deliberately - not
// something remembered in localStorage - so it works from any browser, any
// session, and also cleans up duplicates that accumulated before this existed.
//
// Order is the point of returning a plan rather than doing it:
//
//   dropAfter  the normal case. Upload first, drop the stale copies only once
//              the new one has committed - a failed upload then costs nothing.
//   dropFirst  only when both versions cannot coexist (space, or the tune
//              count is at maxTunes). The old copy is briefly the only thing
//              at risk, but the alternative was refusing entirely, and the
//              project in the browser remains the source of truth throughout.
//
// upload:false means the exact bytes are already stored - same id implies same
// name, since the name is inside the checksummed region - so there is nothing
// to send and nothing to drop.
export function replacePlan(lib, tune) {
  if (!lib) return { upload: true, dropFirst: [], dropAfter: [] };
  if (lib.tunes.some((t) => t.id === tune.id)) {
    return { upload: false, dropFirst: [], dropAfter: [] };
  }
  const stale = lib.tunes.filter((t) => t.name === tune.name && t.id !== tune.id);
  const fitsBeside =
    tune.bytes <= lib.freeBytes && (!lib.maxTunes || lib.tunes.length < lib.maxTunes);
  if (!stale.length || fitsBeside) {
    return { upload: true, dropFirst: [], dropAfter: stale.map((t) => t.id) };
  }
  return { upload: true, dropFirst: stale.map((t) => t.id), dropAfter: [] };
}

export function createUpload({
  send,
  badgeId,
  tune, // { bytes, id, name, tracks }
  onProgress = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (t) => clearInterval(t),
}) {
  const chunks = splitChunks(tune.bytes);
  const sentAt = new Map(); // seq -> when it went out, absent once acked
  const acked = new Set();
  let next = 0;
  let timer = null;
  let settled = false;
  let ended = false;
  let resolve, reject;

  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

  const progress = () => onProgress({
    badgeId,
    id: tune.id,
    acked: acked.size,
    chunks: chunks.length,
    bytes: tune.bytes.length,
    done: settled,
  });

  function pump() {
    // Fill the window with chunks never sent.
    while (next < chunks.length && sentAt.size < WINDOW) {
      send({ t: 'put_data', badge: badgeId, id: tune.id, seq: next, d: chunks[next] });
      sentAt.set(next, now());
      next++;
    }
    // Re-send anything that has gone unacknowledged too long. The badge is
    // required to treat a repeat as idempotent, so this cannot corrupt.
    for (const [seq, at] of sentAt) {
      if (now() - at > ACK_TIMEOUT_MS) {
        send({ t: 'put_data', badge: badgeId, id: tune.id, seq, d: chunks[seq] });
        sentAt.set(seq, now());
      }
    }
    // Commit only once every chunk is safe on the badge.
    if (!ended && acked.size === chunks.length) {
      ended = true;
      send({ t: 'put_end', badge: badgeId, id: tune.id });
    }
  }

  function finish(result) {
    if (settled) return;
    settled = true;
    clearTimer(timer);
    timer = null;
    progress();
    if (result.ok) resolve(result);
    else reject(Object.assign(new Error(result.reason || 'upload failed'), result));
  }

  // Frames arriving from this badge. Anything for another badge or another
  // tune is ignored rather than treated as an error: two uploads can be in
  // flight to two badges at once.
  function handle(msg) {
    if (settled) return;
    if (msg.badge && msg.badge !== badgeId) return;
    if (msg.t === 'put_ack') {
      if (msg.id !== tune.id) return;
      sentAt.delete(msg.seq);
      acked.add(msg.seq);
      progress();
      pump();
      return;
    }
    if (msg.t === 'put_done') {
      finish(msg.ok ? { ok: true, id: msg.id, crc: msg.crc, bytes: msg.bytes } : { ok: false, reason: msg.reason });
    }
  }

  function start() {
    send({
      t: 'put',
      badge: badgeId,
      id: tune.id,
      name: tune.name,
      bytes: tune.bytes.length,
      chunks: chunks.length,
      tracks: tune.tracks,
    });
    progress();
    pump();
    timer = setTimer(pump, TICK_MS);
    return promise;
  }

  return {
    start,
    handle,
    // Cancelling stops sending; the badge discards an incomplete transfer on
    // its own, so there is nothing to clean up remotely.
    cancel: () => finish({ ok: false, reason: 'cancelled' }),
    get chunkCount() { return chunks.length; },
    state: () => ({ acked: acked.size, inflight: sentAt.size, next, ended, settled }),
  };
}
