# Changelog

Notable changes per release. Versions match the `v*` tags that publish the
site, and the tag, `APP_VERSION` in `js/core/version.js` and the heading here
must agree - the release workflow fails if they do not.

Dates are release dates. Unreleased work sits under **Unreleased** until it is
tagged.

## Unreleased

_Nothing yet._

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
