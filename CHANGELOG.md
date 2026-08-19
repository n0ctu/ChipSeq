# Changelog

Notable changes per release. Versions match the `v*` tags that publish the
site, and the tag, `APP_VERSION` in `js/core/version.js` and the heading here
must agree - the release workflow fails if they do not.

Dates are release dates. Unreleased work sits under **Unreleased** until it is
tagged.

## [Unreleased]

### Added

- **A tune on a badge can be fetched back and edited.** The protocol gains its
  read path (§6.5, capability `fetch`): the mirror of upload, without the
  window and acks that exist only because flash writes stall. The sequencer
  reverses the fetched milliseconds onto the tick grid via the tempo hint in
  the file header, which is exact for anything this app built - held in tests
  as import-then-re-export being byte-identical for every demo - and
  best-effort for anything else: off-grid notes are quantized to the nearest
  tick and the app says by how much. A `.cbt` file can also simply be dropped
  on the app. Both paths warn that the result is a conversion, not the
  original project: arpeggios arrive as plain notes, and instruments and
  automation were never in the format.

## [0.7.5] - 2026-08-19

### Fixed

- **Arp-heavy songs no longer freeze playback.** A demoscene-scale project - 7
  tracks, 3291 notes, 71 song-chord arpeggios against a 774-note chord track -
  stuttered at 4 fps once the grid started scrolling under the playhead, while
  the badge played the same song fine. Three defects multiplied: the roll
  re-rendered every arpeggiated note's events on every frame; each render built
  a fresh chord-lookup context, so every autoSong arp rebuilt the whole chord
  track (~4 ms per note per frame); and the left-edge cull exempted exactly the
  arp notes, so the working set grew as the song advanced. Ghost events are now
  cached like chord events already were - computed when the document changes,
  never per frame - and the cull treats every note the same, which is safe
  because an arpeggio can never sound outside its own note (now pinned by a
  test). Measured on the real song: 259 ms per frame became 0.5 ms.
- **A loop wrap no longer re-flattens the whole song.** It cost 16-28 ms inside
  the 25 ms scheduler tick on every pass of a loop, which is how a tight loop
  could starve the scheduler and drop notes. A wrap now only seeks; flattening
  stays owed to document changes, which already restart playback.

### Tests

- The fps regression test failed its own audition first: with the ghost cache
  deliberately bypassed it still passed, because the synthetic chord track was
  block chords on bar lines - 5x cheaper to look up than the real song's. The
  fixture now costs what a real chord track costs (verified: 1.9 fps broken vs
  60 fixed, split at 20), and the suite gained deterministic guards too:
  cache-path ghosts must equal the reference path for every arp note in every
  demo, no ghost may outrun its note, and a shared context must resolve chords
  once - proven by emptying the chord track behind its back.
- A boot that never finishes now reports which of the suite's five boots it
  was, what the page looked like, and **every network request still pending
  with its age** - which immediately identified a 7-minute renderer stall on
  one machine as a single cache-served SVG request that Chromium itself never
  answered (426 s and 442 s across two runs: a deterministic internal timeout,
  environment-level, not the app). The boot check also fails at its own 20 s
  deadline now instead of waiting out a wedged renderer, because a probe into
  a blocked page held the old check hostage for the full 442 s.
- Both browser harnesses put Chrome profiles under `os.tmpdir()` (honouring
  `$TMPDIR`) and accept `CHROME_CDP=host:port` to attach to a browser started
  elsewhere - for sandboxes that allow TCP but not the AF_UNIX socket Chromium
  requires for its process-singleton lock.

## [0.7.4] - 2026-08-11

### Added

- **Sending an edited song replaces it on the badge - after asking.** A tune's
  id is the checksum of its content - load-bearing for the mesh, so it rightly
  changes on every edit - but the person pressing Send thinks in names, and two
  entries called "Tetris" is a bug from where they stand. Send now offers to
  replace: "already on the badge - send the current version in its place?
  Rename the project to keep both." It asks rather than assuming, because a
  shared name is not proof of an update - every fresh project is called
  "Untitled", and two unrelated songs with that name would otherwise silently
  destroy each other. Confirming drops every same-named tune with a different
  id once the new version commits, which also cleans up duplicates that
  accumulated before this existed; cancelling costs nothing. The badge's own
  reported library is the ground truth, so it works from any browser and any
  session. Upload happens before the drop so a failed transfer costs nothing
  stored; only when the badge cannot hold both versions at once is the stale
  copy dropped first. No firmware or protocol change - the existing put and
  drop verbs, in the right order.
- **A release now carries its own deployment.** `deploy-chipseq` fetches
  `compose.yaml` and its own next version from the tag it is deploying, each
  validated before it can replace a working file, and rolled back with the
  image if the health gate fails. This closes the gap 0.7.3 shipped with:
  `--db` lives in compose's `command:`, so a new image on an old `compose.yaml`
  ran happily in memory, passed its gate, and silently had no persistence. One
  manual install of the script remains, unavoidably - a copy cannot teach the
  copy already on the box to fetch it - and it is the last one.
- Three corrections found by exercising the sync in a rig before shipping it:
  a rollback could restore a `compose.yaml.previous` left by an *earlier*
  deploy, reverting the file two releases while the image went back one, to a
  pairing that never existed; a successful deploy left that stale `.previous`
  behind; and a failing `compose up` aborted the script under `set -e` with
  the new state recorded and nothing running, instead of rolling back.

### Fixed

- **The systemd deploy units described an idle guard that no longer exists**,
  promising deploys would defer while badges are online. Nothing defers any
  more - stopping the timer went from backstop to the only protection, and a
  comment that overstates the safety net misleads precisely whoever reads it
  at a venue at 2am. Both files now say what a mid-set deploy actually costs:
  a few seconds of live playback, with adoptions surviving.

## [0.7.3] - 2026-08-10

### Added

- **Adoptions survive a restart.** The relay can keep sessions and adoptions in
  SQLite (`--db`, using the `node:sqlite` builtin, so still no dependencies),
  and the deployed compose file does. Before this, every deploy cost every
  paired badge a re-pair, which is why the deploy script had an idle guard -
  and that guard made things worse, because a relay with badges connected is
  the normal state at an event, so "wait until nobody is online" meant "never
  update". Verified end to end rather than in principle: a badge adopted and
  renamed through the real socket was still adopted, still named and still
  owned by the same session after the container was destroyed and recreated.
  Pairing codes and offers are deliberately not persisted, since they expire in
  120 seconds and an offer names a socket the restart already closed.

### Removed

- **The deploy idle guard.** It blocked deploys rather than postponing them.
  `--force` is still accepted so existing timers keep working, and now does
  nothing.

### Fixed

- **A release could hang for hours instead of failing.** The FTPS scope
  preflight omitted the `net:max-retries` and `net:timeout` settings the mirror
  beside it already had, and lftp defaults to retrying forever - so a run sat
  reconnecting for over an hour after cyon's edge started refusing a runner
  that had been hammering it. Both lftp calls now agree, and every job in all
  three workflows has a `timeout-minutes` ceiling, because the default is six
  hours.
- **Two deploys could interleave their writes to `.env`.** systemd will not
  overlap a oneshot service with itself, so the timer alone was safe, but a
  manual run alongside a timer-fired one was not. It matters because `.env` is
  what the rollback path reads: interleaved writes could leave `RELAY_IMAGE`
  naming one image, the container running another, and `RELAY_IMAGE_PREVIOUS`
  pointing at something never live, so a later rollback would restore the wrong
  thing. A `flock` serialises them, and a waiter gives up after ten minutes
  rather than hanging.
- **The relay image was missing a source file it needed.** `server/Dockerfile`
  lists its files explicitly and a new one was not added, so the container
  crash-looped on `ERR_MODULE_NOT_FOUND`. The workflow's image check could not
  have caught it: it ran `node -e` with the entrypoint overridden, which never
  imported the app. It now starts the container as it really runs and asks it
  for `/health`, an answer that requires every module to have loaded.
- **The cyon deploy failed a release on one bad response.** v0.7.2 went red on a
  single 415 for a file serving 200 seconds later; the deploy had succeeded and
  only the check was wrong. Verification now retries with backoff and sends a
  browser User-Agent.

## [0.7.2] - 2026-08-10

### Fixed

- **The Badges card prefilled the wrong relay on chipseq.app.** It offered
  `wss://chipseq.app/ws`, an origin that serves the app and no socket at all.
  The rule asked "is this a known static host?" and named `github.io`, so it was
  an open-ended list, and moving the site to its own domain left the list a
  release out of date. It now asks the bounded question instead: guess the
  origin only where the relay could plausibly be serving the page, meaning
  localhost, a private LAN address or a tailnet host, and use the relay we ship
  everywhere else. A host nobody has thought of yet gets the right answer,
  which the previous shape could not manage by construction.
- The "Guessed from this page's address" hint no longer appears under
  `wss://ws.chipseq.app/ws`. That address is the relay we ship, not an
  inference, and the warning was sitting under the one value that is usually
  right.

### Added

- Tests for which relay the card prefills. There were none, which is why the
  domain move broke it silently; they were confirmed to fail against the old
  rule before the new one went in.

## [0.7.1] - 2026-08-10

### Added

- **The app points at a dedicated relay.** `wss://ws.chipseq.app/ws` replaces
  the Tailscale Funnel address as the default in the Badges card. Funnel relays
  every public client through Tailscale's own infrastructure, which is fine for
  scheduled playback and poor for live note-by-note; the new host answers in
  about 20 ms of round trip. Anyone running their own relay still only changes
  the field once, and it is remembered.
- **The badge relay ships as a container image, and tagging releases it.** A new
  workflow builds `server/Dockerfile` on every `v*` tag and pushes
  `ghcr.io/n0ctu/chipseq-relay`, which the server polls and deploys itself. It
  replaces a deploy that was `git pull` and a rebuild on the live box, where a
  bad commit was only discoverable once it was already serving. An image tagged
  with its version is an artifact that either exists or does not, so rolling
  back is a tag rather than a git operation on a running service.
- **Deploys are health-gated and roll themselves back.** `server/deploy-chipseq`
  pins the image in `.env`, brings it up, and requires it to report healthy
  *and* answer `/health` through the proxy before recording it. If it does not,
  the previous tag goes back automatically. Exercised against a deliberately
  broken image before shipping: the deploy failed its gate after the deadline,
  restored the previous tag, and the relay was answering again, because a
  rollback that has never run is a rollback nobody should be relying on.
- **Deploys defer while adopted badges are connected.** The relay holds
  sessions, pairings and adoptions in memory by design, so any deploy costs
  every paired badge a re-pair. An unattended deploy now waits rather than
  interrupting a set. It gates on `online`, the one `/health` counter that falls
  again on its own; a badge still mid-pairing is not adopted yet and so does not
  hold a deploy off, which the test confirmed rather than assumed.
- **A pull that fails no longer takes the relay with it.** Found by testing: a
  registry blip aborted the script before it had touched anything, with nothing
  in the log to say why. It now falls back to a local copy of the image if there
  is one, and otherwise gives up before editing `.env`, leaving the running
  version exactly where it was.

### Documented

- **Which `/health` counters can be trusted.** `sweep()` runs only from
  `issueCode()`, and `stats()` reports `codes.size` and `offers.size` unfiltered,
  so a badge that connects once and leaves keeps `offers` above zero
  indefinitely. `sessions` is never deleted at all, and an adoption outlives its
  badge disconnecting. `online` is the only field derived live on every request,
  and so the only one anything should gate a decision on - a guard built on any
  of the others latches on after the first badge of an event and never clears.

### Fixed

- **Native scrollbars were bright white inside a dark app**, which is most
  obvious in the installed PWA when the tool list grows past the sidebar.
  Nothing in the stylesheet could reach them: scrollbars, checkboxes, number
  spinners and the popup a `<select>` opens are painted by the browser, and
  without `color-scheme` it paints them from the light theme. The root now
  declares `color-scheme: dark`, with a matching `<meta>` so the very first
  paint is dark too. `scrollbar-color` puts the native ones on the same two
  palette colours the piano roll already draws its own with, so the two kinds
  do not look like they belong to different apps.

## [0.7.0] - 2026-08-10

### Added

- **The grid scrolls with playback.** The playhead travels until it reaches a
  third of the way across the viewport, then holds there while the grid scrolls
  under it, and once the grid runs out it moves on again to reach the end. It
  replaces a jump that shunted the view a page at a time whenever the playhead
  fell off the right edge. The three phases are not three cases in the code:
  anchoring the playhead and clamping the result produces all of them, so there
  is no mode to track and no boundary to get wrong. Scrolling by hand during
  playback stands the following down, and pressing play again re-engages it.
- **The view eases into place instead of snapping.** Starting playback part-way
  through a song asks the view to move somewhere else, and arriving in one
  frame reads as a glitch rather than a scroll. The difference between where
  the view is and where it belongs is carried as an offset and decayed over
  about a third of a second. Decaying the error rather than smoothing the
  position is what keeps the anchor exact: once the offset reaches zero the
  scroll *is* the anchored position, with no lag trailing a moving target.
  Seeking while playing eases the same way, and the transport already announces
  it, so nothing has to guess at it from a jump in the playhead.
- **A second deployment target: chipseq.app on cyon**, published over FTPS by
  `.github/workflows/cyon.yml` on the same tag that publishes to Pages. Both
  hosts run in parallel until the domain is proven; dropping Pages later is one
  file deleted.
- `.htaccess`, carrying the one thing a default server gets wrong: without
  `AddType application/manifest+json .webmanifest` the manifest is served as
  `application/octet-stream`, the browser ignores it, and the app stops being
  installable with nothing in the console to explain why. cyon runs LiteSpeed,
  which reads `.htaccess` but ignores directives it does not recognise
  *silently* - so the deploy asserts the headers this file should produce
  rather than assuming that shipping it was the same as it working.

### Changed

- **The README is now something a user can read in full.** Everything that only
  matters to someone changing the code moved to
  [DEVELOPMENT.md](DEVELOPMENT.md): architecture, the file format rules, audio
  internals, the service worker, testing, releasing and deployment. What stayed
  was then cut again against a sharper rule: no design rationale, and nothing a
  user learns in the first minute of clicking around. What is left is what the
  app will not tell you itself, such as which gestures exist, what the M and C
  markers actually govern, and which guarantees hold when you edit a shared
  preset. 878 lines became 265, plus a 520-line developer guide.

### Fixed

- **The automation lanes kept a playhead where playback stopped.** They drew
  one only while the transport was running, so the last painted position stayed
  put while the roll's cursor went back to where playback began: two cursors
  disagreeing about the same number. The lanes now draw the cursor whether or
  not anything is playing, and the roll repaints everything that draws a
  playhead whenever the playhead moves, rather than only while playing. The
  invalidation compares the number instead of working out which of the cursor,
  the transport or a seek was responsible, so it cannot miss one.
- **The playhead was 2px wide while playing and 1px while stopped**, so the
  line visibly changed weight on every start and stop. It is always 1px now, in
  the roll and in the automation lanes.
- **`tests/live-check.mjs` had the same fixed-debugging-port flaw as
  `tests/smoke.mjs`** - it hardcoded 9339, so it could silently attach to a
  leaked browser and check a stale profile while reporting a pass. It now takes
  a random port, reads the one Chrome chose from `DevToolsActivePort`, waits for
  Chrome to exit and removes its profile. It had also left 48 profile
  directories in `/tmp`.
- **`tests/live-check.mjs` slept three seconds through its navigation.** A
  `Runtime.evaluate` sent while the previous document is being torn down is
  dropped and its reply never arrives, so the run hangs instead of failing. It
  now waits for the load event and then for the app to boot - and three seconds
  was a guess about someone else's network besides.
- `tests/live-check.mjs` now defaults to `https://chipseq.app/`.

### Notes on the deploy

- **FTPS rather than SSH, and that is the host's constraint.** cyon's SSH is
  main-user only and additional FTP users get none, so a key in CI would reach
  every other site on the account. A scoped FTP account is confined to
  `public_html/chipseq.app`; such accounts cannot use SFTP (it rides on SSH)
  but can use FTPS, so the transfer is still TLS end to end.
- `lftp` does the mirroring rather than a marketplace action, which would
  receive the FTP password on every run.
- `.git` is deleted before the mirror rather than merely excluded - uploading
  it would republish the entire history over HTTP.
- **A preflight refuses to run if the FTP account is not actually scoped.**
  `mirror --delete` is safe only because the account cannot reach past this one
  site, and that is a setting in my.cyon that nothing here can enforce; if
  `public_html` is visible at the FTP root the deploy stops before deleting
  anything rather than after.
- **`sw.js` uploads last, alone, and the ordering is load-bearing.** An FTP
  mirror is not atomic, and the service worker reinstalls when `sw.js` changes
  - so if the new worker landed first, a visitor in that window would precache
  a mixture of two builds and cache it as coherent, since every file still
  returns 200.

## [0.6.0] - 2026-08-10

### Added

- **ChipSeq installs as an app and works with no internet.** Your browser will
  offer to install it; once installed it opens from the dock and keeps working
  on a machine that rebooted somewhere with no signal - editing, playback,
  rendering, `.h`/`.fmf`/`.wav`/`.cbt` export, MIDI import and the demos, all
  from a local copy. Nothing in the app had to change for this: it has no CDN,
  no fonts and no API, and projects were already in `localStorage`. The only
  thing missing was the browser having the files. Badge features still need the
  relay, and say so.
- `sw.js` and `manifest.webmanifest`, plus app icons drawn by
  `tools/gen-icons.mjs` - a square wave, on a 32×32 grid, written as PNG with
  the CRC-32 the badge format already had and the deflate Node already ships.
  No image library, in keeping with the rest of the repository.

### Changed

- **The precache list is derived, not maintained.** `tools/gen-precache.mjs`
  walks `index.html` and the real import graph - including the tool cards'
  dynamic imports and the demos named by `demos/index.json` - and rewrites a
  marked block in `sw.js`; a unit test fails if the committed block is stale.
  A file left out of that list would work perfectly until the one moment
  offline support is the point, which is too late to find out.
- **An update installs in the background and then waits.** The status bar
  offers `↻ update ready`; nothing switches until it is clicked. Activating
  unasked would reload away unsaved work, and would let a running page
  dynamic-import a tool card - they carry `?v=APP_VERSION` - out of a
  different build's cache.
- **A release re-downloads only what changed.** Entries carry a content hash,
  so installing copies untouched files across from the previous cache. The app
  measures 2.4 MB, most of it demo songs; a typical release moves a few KB.
- `tests/check.mjs` now derives its module list from the same walk instead of
  keeping its own. The hand-written one had quietly lost `core/badge-tune.js`
  and `net/badge-upload.js`; it now covers 56 of 56 modules by construction.

### Fixed

- **`tests/smoke.mjs` had been driving a stale browser.** It asked for a fixed
  debugging port, which silently attaches to whatever Chromium already holds
  it - a leaked instance had kept one profile alive since 5 August, along with
  236 abandoned profile directories. It now takes a random port and reads the
  one Chrome actually chose from `DevToolsActivePort`, and removes its profile
  afterwards. This was invisible until service workers, which persist: an
  edited `sw.js` installed as `waiting` while the old one kept serving, so a
  deliberately broken worker passed every offline test.
- **`tests/smoke.mjs` slept through navigations instead of waiting for them.**
  The fixed delays had been tuned against a warm profile and were not enough
  on a genuinely fresh one; the suite now waits for the load event and then
  for the app to finish booting. Evaluating during a navigation also hangs the
  run rather than failing it, because the reply to a dropped `Runtime.evaluate`
  never arrives.
- **The smoke server sends `Cache-Control: no-store`.** With no header Chrome
  cached heuristically, and the offline test passed on the HTTP cache while
  the service worker did nothing - confirmed by disabling the worker's cache
  lookup entirely and watching every test still pass.
- `.webmanifest` is served as `application/manifest+json` by both
  `dev-server.mjs` and `server/index.mjs`. With the wrong type the manifest is
  ignored and the app is simply not installable, with nothing in the console
  to explain why.

## [0.5.2] - 2026-08-10

### Fixed

- **A tool card's header went stale when its status came from outside the
  document.** The Badges card kept saying "no badges" after one was adopted:
  the panel repaints on document and UI-store changes, and badge state is
  neither, so nothing it watched changed when the roster did. Not specific to
  that label - connecting, mapping and going offline were all stale the same
  way, and the card body was correct throughout, which is why it read as a
  wrong label rather than a missing repaint. A tool now declares such a
  dependency in the manifest with an optional `subscribe(fn)`, and the panel
  wires it up without knowing what it is.

## [0.5.1] - 2026-08-10

### Added

- **Badges announce their own names.** `hello` now carries an optional `name`,
  and the sequencer lists the badge under it instead of `Badge 1`, `Badge 2` -
  which is a guessing game once eight of them are on a table. The name follows
  the device: change it on the badge, reconnect, and the list follows. A name
  typed into the sequencer wins and stays, because typing one is a more
  deliberate act than a device reporting its label on every connect.

### Changed

- **The badge handover documents are no longer tracked.** The repository is
  served verbatim as the Pages site, so anything in it is public, and those
  documents are for the firmware team rather than for the world. They are
  distributed to that team directly and `docs/` is now ignored. Code comments
  still cite them by section - they remain the contract this server and
  `tools/fake-badge.mjs` are built against, and the fake badge is the
  executable version of the same thing. Note this stops future publication
  only: earlier tags and the git history still contain them.

## [0.5.0] - 2026-08-09

### Added

- **A badge can end its own adoption.** Adoption used to be a one-way door:
  only the controller that made it could end it, and a controller loses its
  session routinely - a closed browser, cleared storage, a different laptop.
  A badge in that state reconnected as `known`, was offered no pairing code,
  and could be adopted by nobody; restarting the server was the only way out.
  `{t:"release"}` now frees it, on the badge's own authority, and a fresh
  pairing code comes straight back on the same socket. `docs/badge-unadopt.md`
  is the handover for the firmware side.
- **Auditioning plays on the badges.** A note played by hand in the piano roll
  now sounds on every connected badge, mapped or not - clicking a note is "let
  me hear this", and it doubles as a check that the whole rig is alive. Hooked
  to the engine, so the ten audition call sites across the roll, the keymap and
  three tool cards are all covered. Suppressed while the transport runs,
  rate-limited to one every 60 ms, and a decorated note goes as a scheduled
  chunk so its arpeggio keeps its shape across the relay.

### Fixed

- **`sched` chunks arrived with no lead time.** The badge team measured 30 of
  96 notes dropped over the Funnel, with chunks due on arrival where §5.2
  promises 2-4 seconds. Three causes: the steady-state lead was
  `CHUNK_MS - REFRESH_MS` = 1500 ms, under our own documented window; the
  badges were anchored to *now* while the engine starts its audio 60 ms later,
  so they ran ahead of the speakers by about the length of the relay hop; and
  an edit while playing restarted the engine, which flushed every badge's queue
  and re-anchored with zero lead. Measured before: first chunk 0 ms, steady
  1500-2350 ms. After: 60 ms and 2623-3913 ms. Notes already past due are no
  longer sent at all - they cannot arrive in time, and sending them moves the
  decision somewhere we cannot see it.
- **A badge that un-adopted on the device stayed in the sequencer.** A factory
  reset, a reflash, or "forget pairing" from the badge's own menu while offline
  left the server insisting it was still adopted, so it sat in the list
  unusable. `hello` now carries an optional `adopted`, and `false` frees it -
  the badge is the authority on its own pairing. Absent still means *no claim*,
  so adoption survives an ordinary reconnect.
- The Badges card never re-read a badge's library after it was released and
  adopted again in the same session, showing it as empty while it held tunes.
- **Bad Apple:** a stray F#4 an eighth note before the Lead's entry, from a
  misclick. The melody now starts cleanly on bar 15 with the rest of the band.

## [0.4.1] - 2026-08-09

### Fixed

- **`sched` offsets went out as fractional milliseconds.** Song positions come
  from `tickToSeconds() * 1000` and the clock offset is a median, so both
  origins are routinely fractional and the subtraction carried that onto the
  wire - the badge team saw offsets like `108.78260869566293` where the
  protocol implies integers. `toSchedNotes` now rounds each note's ABSOLUTE
  server time once and subtracts `t0` from it, the same rule `badgeScore`
  already used for note boundaries, so values are integers and `t0 + offset`
  is exactly the intended instant. Previously `t0` was rounded while the
  offsets were not, leaving the two disagreeing by up to a millisecond.
- `docs/badge-protocol.md` §5.2 now **states** that `t0`, `offsetMs` and
  `durationMs` are integers, and that `offsetMs` may be negative. Both were
  only implied by the examples.

## [0.4.0] - 2026-08-09

### Added

- **Badge live playback, groundwork.** `docs/badge-protocol.md` specifies how a
  badge talks to a server so the sequencer can play a track on it live - the
  contract matters more than usual because the firmware is written by someone
  else and cannot be iterated on. `tools/fake-badge.mjs` is the executable
  version of that spec, and `server/` is a dependency-free Node server (WebSocket
  implementation included, since Node ships a client but not a server) that
  serves the sequencer and the badge socket from one origin, ready to publish
  with Tailscale Funnel.

- **Badge autonomy: stored tunes, standalone play, and an offline mesh.** A
  badge no longer needs the internet, a laptop or a server to perform.

  - **`.cbt`, the tune a badge stores** (`js/core/badge-tune.js`,
    `docs/badge-tune-format.md`). One binary file holding up to 16 monophonic
    tracks with the tempo map already resolved, so the badge does no tempo
    maths at all. Notes carry **absolute** start times in a fixed 8-byte,
    4-byte-aligned record, which is what lets a badge derive its playback
    position from a clock instead of accumulating durations. The difference is
    not cosmetic: with a 137 ms stall injected every second, a derived player
    stays within one stall of correct while the accumulating alternative ends
    **2.8 seconds** late. Also available as an export, so a tune can be
    side-loaded without a server.
  - **Uploading** (`js/net/badge-upload.js`, protocol v2 §6). Send a whole song
    or a single track to a badge's flash over the existing WebSocket, with a
    4-deep ack window, timeout resends and a CRC verified before anything is
    committed. The Badges card gains a library per badge: what is stored, free
    space, delete, and a progress bar. The server relays it while holding no
    tune bytes at any point.
  - **`docs/badge-mesh.md` + `tools/fake-mesh.mjs`.** ESP-NOW between badges:
    one hosts, the rest join, the tune is shared to whoever lacks it, clocks
    converge in an explicit ARM phase, and everyone starts on a shared instant.
    Simulated at 8 badges and 10% packet loss, the ensemble holds **0.78 ms**
    spread with no notes swallowed by resynchronisation.
  - **`docs/badge-handover.md` and `docs/badge-app.md`** orient the firmware
    team and recommend a device UI for the round 240×240 display.

- **Live/scheduled switch** in the Badges card. Scheduled remains the default
  (0.3 ms against live's 50 ms over a relay); the switch exists because the gap
  narrows on a LAN, and because a badge that has not implemented `sched` needs
  a way to be driven at all.

### Changed

- **Badge protocol is now v2, and it is a hard cut** - the server refuses any
  other version rather than half-supporting it. Badges declare what they can do
  in `hello` (`note`, `sched`, `store`, `mesh`) and the sequencer hides controls
  a badge cannot honour, instead of sending frames it will ignore.
- `.cbt` joins `.wav` and the project file as an exporter available in **poly**
  as well as mono: it holds every track and the badge picks a part, which is
  what polyphony means on single-voice hardware.

## [0.3.1] - 2026-08-07

### Added

- **Make-up gain, with an Analyse button.** Levels only ever attenuates, so a
  polyphonic song sat permanently below unity - Bad Apple left 6.8 dB of
  headroom unused. Analyse renders once, reads the pre-limiter peak, and sets a
  master gain so it lands at -1 dBFS. Never automatic, stored rather than
  recomputed (so preview and export match), shown in the card, overridable by
  hand and re-analysable.

### Fixed

- **Make-up did not reach the preview.** The master node is built once, on
  first play, and the routing rebuild reuses it - so a stored make-up moved the
  number and the exported file while playback carried on at the level the graph
  was built with. The engine now pushes the level onto that node, ramped so a
  change mid-playback does not click.
- **The peak estimate ignored the mixer.** `predictPeak` never applied
  `track.gain`, so it described a render nobody could produce - Bad Apple read
  +1.1 dB where the true bound is -3.3 dB. It drives the clip warning, so it was
  overstating danger in exactly the projects balanced most carefully.

### Changed

- **The Levels card speaks one unit system.** Peaks read in dBFS everywhere -
  the estimate used to show bare linear amplitudes (`1.24`, `0.67`) beside a
  make-up in dB and exponents printed as `0.50`. The two exponents are now
  percentages, matching the rest of the app, and the legend says what the
  number means rather than listing values.
- **The measurement leads, the estimate is a footnote.** The estimate had the
  bordered panel while the measured peak got a line of small print; they have
  swapped, and the estimate is labelled as "an upper bound, not a measurement".
- Levels measures once when the card is opened, then re-measures at most every
  five minutes and only when the cheap estimate has drifted by more than 1 dB -
  never while playing. Automatic measurements use a derived commit, so they
  push no undo snapshot, and dragging the slider marks the value manual so the
  app will not overwrite a number you chose.
- The Analyse button no longer overflows the card, and the make-up value no
  longer wraps onto two lines.
- **Tetris and Bad Apple revised**, both analysed to peak at -1 dBFS: Bad Apple
  gains a reverb bus with the Lead excluded from Levels, and both are panned
  rather than stacked dead centre.

### Fixed

- The Levels estimate panel rendered empty until something else changed - it
  was only filled from a subscription, never on open.

### Changed

- The Spectrum section moved below the envelope and became collapsible,
  following the tool cards' rule: open when the instrument is shaped, closed
  when neutral, sticky once you toggle it. The summary reports the state, so a
  closed section is still informative.

## [0.3.0] - 2026-08-07

### Added

- **Spectrum shaping.** A base wave is its harmonic series, so the new Spectrum
  section scales that series rather than replacing it: a **tilt** knob in dB per
  octave, plus eight drawbars as multipliers on the lowest partials. Neutral is
  the raw wave, and an unshaped instrument still uses the browser's own
  oscillator. Stored as an optional `instrument.spectrum` block, so an older
  build ignores it and plays the base wave.
- **Effects: buses and sends.** A bus is a shared chain that tracks send part of
  their signal to - delay (grid-synced), filter, and a reverb whose impulse is
  generated from a seeded PRNG rather than fetched. Sends tap the track node
  post-fader, so a fader move takes its sends with it. An effect kind this build
  does not know is skipped rather than fatal, and a document using any of it
  declares `effects@1` in `doc.uses`. Buses can be deleted, which takes every
  send to them along.
- **Command palette (Ctrl+K)** and a shared commands table. Actions that have
  both a shortcut and a button were defined twice - once in the toolbar, once
  in the keymap - and could drift apart. One array now feeds all three, and two
  commands claiming the same chord is a test failure rather than whichever
  handler bound last quietly winning.
- **`js/core/exporters.js`** describes the export formats as data. The dialog
  derives its tabs, disabled states and download step from it, so adding `.mid`
  becomes one builder plus one entry.

## [0.2.1] - 2026-08-07

### Fixed

- **Excluding a track from Levels now excludes it.** `track.normalize = false`
  cancelled only the per-track stage; the song-wide stage kept riding the
  voice, so excluding a lead - the case the control exists for - did almost
  nothing, because a monophonic lead had nothing for the track stage to do.
  Measured on Bad Apple's Lead: 9.5 dB of movement with 907 of 920 notes on a
  moving gain, now 0.0 dB and no curve at all. An exponent of `0` still means
  the old thing (own stage off, song stage kept).
- The Levels checkbox reads "is this track exempt" rather than deriving from
  the exponent, which showed every track unchecked whenever the track dial sat
  at 0.
- `deploy-pages` waits 30 minutes instead of 10. It only polls; on timeout it
  reported failure while the deployment carried on and published anyway, which
  is how v0.2.0 shipped from a run marked red.

### Added

- **`reset to default`** beside the instrument's gain, appearing only while the
  gain has drifted from the level its wave was calibrated at (square 35%, sine
  50%, sawtooth 35%). It reads the built-in presets, not the document, so a
  project whose stored gains have drifted still resets to the right number.
- A note under the gain slider pointing at the **Mixer** for balancing a track,
  since the instrument's gain is part of the sound's design and editing it
  makes the track Custom.
- **`dev-server.mjs`** - dependency-free static server sending
  `Cache-Control: no-store`. Tool cards load lazily, so `import()` runs after
  the page has loaded and a hard reload does not reach it; `python3 -m
  http.server` sends no cache headers, so a stale tool card could run against a
  freshly loaded core and look broken rather than stale.

### Changed

- Every lazy `load()` in the tool manifest carries `?v=${APP_VERSION}`. Pages
  serves JS with `max-age=600`, so without it a visitor could hold a fresh
  `main.js` beside a tool card from the previous release for ten minutes.

## [0.2.0] - 2026-08-06

### Added

- **Track colours accept a literal hex** (`"#ff8800"`) as well as a palette
  index, in one field so the two cannot drift apart. A hex box sits beside the
  swatches in the Track dialog; an unparseable value is refused rather than
  stored.
- Colours are generated at track creation and baked into the saved project, so
  they survive reordering and round-trip through localStorage and exports.

### Fixed

- **The Mixer and the tracks panel disagreed about colour.** The panel resolved
  a track by id before reading it, so two tracks sharing an id rendered the
  same colour twice. `trackColor()` takes the track itself now, and
  `enforceInvariants()` re-issues a duplicate id rather than leaving a document
  where selection, notes and colour all resolve to the wrong track.
- Muted tracks no longer show a faded colour dot in the Mixer - the dimming
  moved off the row and onto the label and controls, so identity stays legible.
- **Per-note velocity is stored but no longer applied.** MIDI import fills it
  in (Rickroll carries 48 distinct values) and nothing in the editor shows or
  edits it, so a note 3 dB below its neighbours looked identical to them. The
  data is untouched and re-enabling is a one-line change in each of the two
  places that consume it.

### Changed

- Demo files renamed to `mono`, `poly`, `rickroll`, `tetris`, `bad-apple`;
  `demos/index.json` defines display order, so the numeric prefixes were only
  noise.
- Tetris replaced with the version balanced against the Levels defaults.
- **Publishing moved from every push to tagged releases.** Pages runs one
  deployment at a time per repository, so a burst of pushes queued until each
  deploy step aborted itself; `concurrency: cancel-in-progress` means a newer
  release supersedes an older one instead of both dying.

## [0.1.0]

First tagged version - the app as it stood when releases began: mono and poly
modes, `.h` / `.fmf` / `.wav` export, the non-destructive arpeggiator,
automation lanes, drawable envelopes, the Levels normalizer, per-track mixing
with pan, and the collapsible tool cards.
