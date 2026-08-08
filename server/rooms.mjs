// Who is connected, who owns whom, and who may pair.
//
// Kept separate from the socket plumbing and given injectable time and
// randomness, so expiry and rate limiting can be tested by advancing a number
// rather than by sleeping. A test that sleeps for two minutes to check a code
// expired is a test nobody runs.

import { randomBytes } from 'node:crypto';

// The badge's six buttons, in the order the spec names them.
export const CODE_ALPHABET = 'URDLAB';
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 120_000; // §3 of the protocol
export const PAIR_MAX_ATTEMPTS = 10;
export const PAIR_WINDOW_MS = 60_000;

// 6^6 = 46,656. Enough that guessing is pointless once rate-limited, short
// enough to enter on a d-pad without losing your place.
export function makeCode(rand = randomBytes) {
  const bytes = rand(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// The code a badge DISPLAYS for you to type into the sequencer. Different
// alphabet from the button code because the constraint is different: this one
// is read off a screen and typed on a keyboard, so it drops the characters
// people confuse (I/1/L, O/0) rather than being limited to six buttons.
export const DISPLAY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const DISPLAY_LENGTH = 6;

export function makeDisplayCode(rand = randomBytes) {
  const bytes = rand(DISPLAY_LENGTH);
  let out = '';
  for (let i = 0; i < DISPLAY_LENGTH; i++) out += DISPLAY_ALPHABET[bytes[i] % DISPLAY_ALPHABET.length];
  return out;
}

export function normalizeDisplayCode(code) {
  return String(code || '').trim().toUpperCase();
}

export function isValidCodeShape(code) {
  return typeof code === 'string'
    && code.length === CODE_LENGTH
    && [...code].every((c) => CODE_ALPHABET.includes(c));
}

export class Hub {
  constructor({ now = () => Date.now(), rand = randomBytes } = {}) {
    this.now = now;
    this.rand = rand;
    this.sessions = new Map(); // sessionId -> { id, created }
    this.badges = new Map(); // badgeId -> { id, name, fw, sessionId, trackId, lastSeen, conn }
    this.codes = new Map(); // code -> { sessionId, expires }        (button flow)
    this.offers = new Map(); // code -> { badgeId, expires }          (display flow)
    this.rate = new Map(); // ip -> { count, resets }
  }

  // ---- sessions ----

  createSession() {
    const id = randomBytes(16).toString('hex');
    this.sessions.set(id, { id, created: this.now() });
    return id;
  }

  // A controller reconnecting presents the session it already holds. An
  // unknown one is not an error - it just gets a fresh session, because the
  // alternative is a browser that can never recover from a server restart.
  resumeSession(sessionId) {
    if (sessionId && this.sessions.has(sessionId)) return sessionId;
    return this.createSession();
  }

  badgesOf(sessionId) {
    return [...this.badges.values()]
      .filter((b) => b.sessionId === sessionId)
      .map((b) => this.describe(b));
  }

  describe(b) {
    return {
      id: b.id,
      name: b.name,
      fw: b.fw,
      trackId: b.trackId ?? null,
      online: !!(b.conn && b.conn.open),
      lastSeen: b.lastSeen,
    };
  }

  // ---- pairing ----

  issueCode(sessionId) {
    this.sweep();
    let code = makeCode(this.rand);
    // Collisions are vanishingly unlikely, but a live one would hand someone
    // else's badge to the wrong session - so retry rather than hope.
    let guard = 0;
    while (this.codes.has(code) && guard++ < 20) code = makeCode(this.rand);
    const expires = this.now() + CODE_TTL_MS;
    this.codes.set(code, { sessionId, expires });
    return { code, expires };
  }

  rateLimited(ip) {
    const entry = this.rate.get(ip);
    if (!entry || this.now() > entry.resets) {
      this.rate.set(ip, { count: 1, resets: this.now() + PAIR_WINDOW_MS });
      return false;
    }
    entry.count++;
    return entry.count > PAIR_MAX_ATTEMPTS;
  }

  // Returns { ok, name } or { error: 'unknown' | 'expired' | 'rate' }.
  //
  // Codes are single-use: consumed on success AND on a failed attempt against
  // a real code, because a code that survives a wrong guess is a code being
  // brute-forced.
  redeem(code, badgeId, fw, ip) {
    if (this.rateLimited(ip)) return { error: 'rate' };
    if (!isValidCodeShape(code)) return { error: 'unknown' };
    const entry = this.codes.get(code);
    if (!entry) return { error: 'unknown' };
    this.codes.delete(code);
    if (this.now() > entry.expires) return { error: 'expired' };

    const existing = this.badges.get(badgeId);
    const name = existing ? existing.name : `Badge ${this.badgesOf(entry.sessionId).length + 1}`;
    this.badges.set(badgeId, {
      ...(existing || {}),
      id: badgeId,
      name,
      fw: fw || (existing && existing.fw) || '',
      sessionId: entry.sessionId,
      trackId: existing ? existing.trackId ?? null : null,
      lastSeen: this.now(),
      conn: existing ? existing.conn : null,
    });
    return { ok: true, name, sessionId: entry.sessionId };
  }

  // ---- the display flow ----
  //
  // Minted when an unadopted badge connects, and bound to THAT badge rather
  // than to a session. That is the security difference: the button-flow code
  // is a bearer token anyone can redeem, while this one is useless unless you
  // are also the badge it names - and it dies with the connection.

  offerCode(badgeId) {
    // Reuse an unexpired offer rather than minting a fresh one. A badge that
    // reconnects is still SHOWING the old code on its screen, and handing it
    // a new one every time the link blips means the thing in front of the
    // user is wrong more often than it is right.
    for (const [code, entry] of this.offers) {
      if (entry.badgeId === badgeId && this.now() <= entry.expires) return code;
    }
    this.revokeOffer(badgeId);
    let code = makeDisplayCode(this.rand);
    let guard = 0;
    while (this.offers.has(code) && guard++ < 20) code = makeDisplayCode(this.rand);
    this.offers.set(code, { badgeId, expires: this.now() + CODE_TTL_MS });
    return code;
  }

  revokeOffer(badgeId) {
    for (const [code, entry] of this.offers) if (entry.badgeId === badgeId) this.offers.delete(code);
  }

  // The controller's half: adopt whatever badge is showing this code.
  adopt(code, sessionId, ip) {
    if (this.rateLimited(ip)) return { error: 'rate' };
    const entry = this.offers.get(normalizeDisplayCode(code));
    if (!entry) return { error: 'unknown' };
    this.offers.delete(normalizeDisplayCode(code));
    if (this.now() > entry.expires) return { error: 'expired' };

    const existing = this.badges.get(entry.badgeId);
    const name = existing && existing.name ? existing.name : `Badge ${this.badgesOf(sessionId).length + 1}`;
    this.badges.set(entry.badgeId, {
      ...(existing || {}),
      id: entry.badgeId,
      name,
      fw: (existing && existing.fw) || '',
      sessionId,
      trackId: existing ? existing.trackId ?? null : null,
      lastSeen: this.now(),
      conn: existing ? existing.conn : null,
    });
    return { ok: true, badgeId: entry.badgeId, name };
  }

  // ---- badges ----

  attach(badgeId, fw, conn) {
    const known = this.badges.get(badgeId);
    if (known) {
      known.conn = conn;
      known.fw = fw || known.fw;
      known.lastSeen = this.now();
      return known;
    }
    return null; // unknown badge: must pair before it exists here
  }

  detach(badgeId) {
    const b = this.badges.get(badgeId);
    if (!b) return;
    b.conn = null;
    b.lastSeen = this.now();
  }

  rename(sessionId, badgeId, name) {
    const b = this.badges.get(badgeId);
    if (!b || b.sessionId !== sessionId) return false;
    b.name = String(name || '').slice(0, 40) || b.name;
    return true;
  }

  // trackId null unmaps. One track can drive several badges - two playing the
  // same part is a stated goal - so this is deliberately not exclusive.
  map(sessionId, badgeId, trackId) {
    const b = this.badges.get(badgeId);
    if (!b || b.sessionId !== sessionId) return false;
    b.trackId = trackId || null;
    return true;
  }

  forget(sessionId, badgeId) {
    const b = this.badges.get(badgeId);
    if (!b || b.sessionId !== sessionId) return false;
    if (b.conn) b.conn.close(1000, 'unadopted');
    this.badges.delete(badgeId);
    return true;
  }

  // Badges a controller may address, by id.
  owned(sessionId, badgeId) {
    const b = this.badges.get(badgeId);
    return b && b.sessionId === sessionId ? b : null;
  }

  // Everything mapped to a track, for fan-out. Two badges on one track both
  // appear here and both get the identical stream.
  forTrack(sessionId, trackId) {
    return [...this.badges.values()].filter(
      (b) => b.sessionId === sessionId && b.trackId === trackId && b.conn && b.conn.open
    );
  }

  // Expired codes and stale rate windows. Cheap, and called on code issue so
  // there is no timer to leak.
  sweep() {
    const t = this.now();
    for (const [code, entry] of this.codes) if (t > entry.expires) this.codes.delete(code);
    for (const [ip, entry] of this.rate) if (t > entry.resets) this.rate.delete(ip);
    for (const [code, entry] of this.offers) if (t > entry.expires) this.offers.delete(code);
  }

  stats() {
    return {
      sessions: this.sessions.size,
      badges: this.badges.size,
      online: [...this.badges.values()].filter((b) => b.conn && b.conn.open).length,
      codes: this.codes.size,
      offers: this.offers.size,
    };
  }
}
