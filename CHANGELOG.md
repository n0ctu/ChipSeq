# Changelog

Notable changes per release. Versions match the `v*` tags that publish the
site, and the tag, `APP_VERSION` in `js/core/version.js` and the heading here
must agree - the release workflow fails if they do not.

Dates are release dates. Unreleased work sits under **Unreleased** until it is
tagged.

## [0.5.0] - 2026-08-09

### Added

- **A badge can end its own adoption.** Adoption used to be a one-way door:
  only the controller that made it could end it, and a controller loses its
  session routinely — a closed browser, cleared storage, a different laptop.
  A badge in that state reconnected as `known`, was offered no pairing code,
  and could be adopted by nobody; restarting the server was the only way out.
  `{t:"release"}` now frees it, on the badge's own authority, and a fresh
  pairing code comes straight back on the same socket. `docs/badge-unadopt.md`
  is the handover for the firmware side.
- **Auditioning plays on the badges.** A note played by hand in the piano roll
  now sounds on every connected badge, mapped or not — clicking a note is "let
  me hear this", and it doubles as a check that the whole rig is alive. Hooked
  to the engine, so the ten audition call sites across the roll, the keymap and
  three tool cards are all covered. Suppressed while the transport runs,
  rate-limited to one every 60 ms, and a decorated note goes as a scheduled
  chunk so its arpeggio keeps its shape across the relay.

### Fixed

- **`sched` chunks arrived with no lead time.** The badge team measured 30 of
  96 notes dropped over the Funnel, with chunks due on arrival where §5.2
  promises 2–4 seconds. Three causes: the steady-state lead was
  `CHUNK_MS - REFRESH_MS` = 1500 ms, under our own documented window; the
  badges were anchored to *now* while the engine starts its audio 60 ms later,
  so they ran ahead of the speakers by about the length of the relay hop; and
  an edit while playing restarted the engine, which flushed every badge's queue
  and re-anchored with zero lead. Measured before: first chunk 0 ms, steady
  1500–2350 ms. After: 60 ms and 2623–3913 ms. Notes already past due are no
  longer sent at all — they cannot arrive in time, and sending them moves the
  decision somewhere we cannot see it.
- **A badge that un-adopted on the device stayed in the sequencer.** A factory
  reset, a reflash, or "forget pairing" from the badge's own menu while offline
  left the server insisting it was still adopted, so it sat in the list
  unusable. `hello` now carries an optional `adopted`, and `false` frees it —
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
