// Undo history as deltas between neighbouring serialized states.
//
// The store used to keep a FULL serialized document per undo step; at 420 KB
// a step (the largest shipped demo, measured), the 8 MB byte cap held
// nineteen steps. A step is now the difference between two neighbouring
// serializations, so it costs what actually changed - a couple of bytes for
// a pitch edit - and the cap holds hundreds to thousands of steps.
//
// Why STRING deltas and not a structural JSON diff: reconstruction here is a
// string splice, so "applying the delta yields the exact original,
// byte-for-byte" falls out of the construction instead of resting on the
// correctness of a differ and a patch grammar. The whole mechanism is a few
// dozen lines, and one property test can hammer it with random documents.
//
// A delta comes in two shapes:
//
//   { pos, del, insLen }     the changed middle, after stripping the common
//                            prefix and suffix. `del` is the older side's
//                            bytes; of the newer side only the LENGTH is
//                            kept, because restore() only ever rebuilds the
//                            older neighbour - the newer bytes are already
//                            in the string it starts from. An import that
//                            adds ten tracks therefore costs an undo entry
//                            of a few dozen bytes; deleting ten tracks costs
//                            their JSON, which is irreducible - it IS the
//                            information undo has to preserve.
//   { pos, len, runs }       the same span when both sides have EQUAL length
//                            (transpose, quantize, velocity edits - digits
//                            changing in place): only the bytes that differ,
//                            as [offset, olderBytes] runs. This is the
//                            sparse/XOR idea - the unchanged bytes between
//                            the runs cost nothing - kept synchronous, which
//                            CompressionStream could not be.
//
// Both are exact. The sparse shape is used only when it is smaller, so the
// dense one is always a correct fallback.
//
// restore() only ever goes ONE direction: from the string a delta was
// computed against, back to its older neighbour. The stack below is built so
// that is the only direction ever needed - which is why runs carry only the
// older bytes.

// Rough per-entry bookkeeping overhead, for the byte cap.
const ENTRY_OVERHEAD = 32;

export function computeDelta(next, prev) {
  // Common prefix.
  const max = Math.min(next.length, prev.length);
  let p = 0;
  while (p < max && next[p] === prev[p]) p++;
  // Common suffix - capped so it cannot overlap the prefix ("aa" -> "a").
  let s = 0;
  while (s < max - p && next[next.length - 1 - s] === prev[prev.length - 1 - s]) s++;

  const del = prev.slice(p, prev.length - s);
  const insLen = next.length - s - p;

  if (del.length === insLen && del.length > 64) {
    const runs = [];
    let cost = 0;
    for (let i = 0; i < del.length; ) {
      if (del[i] === next[p + i]) { i++; continue; }
      const start = i;
      while (i < del.length && del[i] !== next[p + i]) i++;
      runs.push([start, del.slice(start, i)]);
      cost += (i - start) + 16;
    }
    if (cost < del.length) return { pos: p, len: del.length, runs };
  }
  return { pos: p, del, insLen };
}

// The older string, reconstructed from the string the delta was computed
// against. Exact by construction: everything outside the span is copied
// through, and inside it either `del` replaces `ins` wholesale or the runs
// overwrite only the bytes that differed.
export function restore(next, entry) {
  if (entry.runs) {
    const mid = next.slice(entry.pos, entry.pos + entry.len);
    const parts = [];
    let at = 0;
    for (const [off, older] of entry.runs) {
      parts.push(mid.slice(at, off), older);
      at = off + older.length;
    }
    parts.push(mid.slice(at));
    return next.slice(0, entry.pos) + parts.join('') + next.slice(entry.pos + entry.len);
  }
  return next.slice(0, entry.pos) + entry.del + next.slice(entry.pos + entry.insLen);
}

export function deltaSize(entry) {
  if (entry.runs) {
    let n = ENTRY_OVERHEAD;
    for (const [, older] of entry.runs) n += older.length + 16;
    return n;
  }
  return ENTRY_OVERHEAD + entry.del.length;
}

// A stack of serialized states that stores the newest one whole and every
// older one as a delta against its newer neighbour. pop() returns the newest
// state and re-materializes the one beneath it, so the top is ALWAYS a full
// string - no chain of patches is ever replayed, and evicting the oldest
// entry (to hold the caps) just drops the far end of the chain.
export function deltaStack({ maxEntries, maxBytes }) {
  let top = null; // full serialized state, most recently pushed
  let deltas = []; // deltas[i] restores the state under deltas[i+1] (/ top)
  let bytes = 0; // of the deltas only; top is counted separately

  function evict() {
    while (deltas.length + 1 > maxEntries || (top ? top.length : 0) + bytes > maxBytes) {
      if (!deltas.length) break; // never evict the only state
      bytes -= deltaSize(deltas[0]);
      deltas.shift();
    }
  }

  return {
    get size() {
      return top === null ? 0 : deltas.length + 1;
    },
    push(s) {
      if (top !== null) {
        const d = computeDelta(s, top);
        deltas.push(d);
        bytes += deltaSize(d);
      }
      top = s;
      evict();
    },
    pop() {
      if (top === null) return null;
      const out = top;
      if (deltas.length) {
        const d = deltas.pop();
        bytes -= deltaSize(d);
        top = restore(out, d);
      } else {
        top = null;
      }
      return out;
    },
    clear() {
      top = null;
      deltas = [];
      bytes = 0;
    },
  };
}
