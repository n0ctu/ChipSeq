// Persists adoptions across a restart, so a deploy does not cost every paired
// badge a re-pair.
//
// `node:sqlite` is a Node builtin, so this stays a repository with no
// dependencies. It prints an experimental warning on import; the API used here
// is four calls wide and the file it writes is ordinary SQLite either way.
//
// ---- what is persisted, and what deliberately is not ----
//
// Adoptions and sessions: those are what a badge loses on a restart, and what
// made deploying during an event expensive.
//
// NOT pairing codes or offers. They expire in 120 seconds and an offer is bound
// to a live connection, so restoring them would resurrect codes whose sockets
// are gone - a pairing token that outlives the thing it names is worse than no
// token. NOT the rate-limit table either: a restart forgiving one address is
// not worth writing to disk.
//
// NOT `conn`, obviously: a socket cannot be serialised, and a badge record read
// from disk describes an adoption, not a connection. Anything loaded starts
// offline until the badge reconnects, which is exactly what `online` in
// /health already means.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS badges   (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
`;

// One JSON document per row rather than a column per field. The badge record
// has grown caps, lib and userNamed over three releases, and each of those
// would have been a migration; the project file solved the same problem the
// same way. What is in a row is small enough to read with the sqlite3 CLI when
// something needs explaining.
export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const clearSessions = db.prepare('DELETE FROM sessions');
  const clearBadges = db.prepare('DELETE FROM badges');
  const putSession = db.prepare('INSERT INTO sessions (id, doc) VALUES (?, ?)');
  const putBadge = db.prepare('INSERT INTO badges (id, doc) VALUES (?, ?)');
  const allSessions = db.prepare('SELECT id, doc FROM sessions');
  const allBadges = db.prepare('SELECT id, doc FROM badges');

  return {
    load() {
      const sessions = new Map();
      const badges = new Map();
      for (const row of allSessions.all()) {
        try {
          sessions.set(row.id, JSON.parse(row.doc));
        } catch {
          /* a corrupt row reads as absent rather than taking the relay down */
        }
      }
      for (const row of allBadges.all()) {
        try {
          // Loaded adoptions are offline until their badge reconnects.
          badges.set(row.id, { ...JSON.parse(row.doc), conn: null });
        } catch {
          /* same */
        }
      }
      return { sessions, badges };
    },

    // Rewrites both tables in one transaction. Eight badges make anything
    // cleverer a false economy, and it removes the failure this would otherwise
    // have: a mutation whose write was forgotten. There is one way to save, and
    // it saves everything.
    save(sessions, badges) {
      db.exec('BEGIN');
      try {
        clearSessions.run();
        clearBadges.run();
        for (const [id, s] of sessions) putSession.run(id, JSON.stringify(s));
        for (const [id, b] of badges) {
          const { conn, ...rest } = b; // a socket is not state
          void conn;
          putBadge.run(id, JSON.stringify(rest));
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    close() {
      db.close();
    },
  };
}
