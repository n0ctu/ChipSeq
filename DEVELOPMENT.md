# Developing ChipSeq

Everything that matters to someone changing the code. For what the app does,
see [README.md](README.md).

No build step and no dependencies: the repository *is* the site, served
verbatim. Plain HTML, CSS and JavaScript with native ES modules, and plain Node
scripts for the tests.

## Run it

```sh
node dev-server.mjs           # from this directory
# open http://localhost:8000
```

Any static file server works (the app uses ES modules, so `file://` will not),
but prefer this one while developing, because it sends `Cache-Control:
no-store`.

That matters more than it sounds. The tool cards load lazily, so
`import('./instrument.js')` runs when a card is first expanded, *after* the
page has finished loading. A hard reload bypasses the cache for the navigation
and everything fetched during it, but a later runtime import is an ordinary
fetch obeying the ordinary cache. `python3 -m http.server` sends no
`Cache-Control` at all, so the browser falls back to heuristic caching from
`Last-Modified` and can hand you a stale tool card while the statically
imported core around it is already up to date. The app then looks broken rather
than stale, which is a genuinely nasty thing to debug.

The same shape exists in production with a shorter fuse, since a host may serve
JS with a short `max-age`. Every `load()` in the tool manifest therefore
carries `?v=${APP_VERSION}`, and `main.js` supplies that version string, so the
moment it is fresh every module it lazily asks for is too.

## Architecture

- `js/core/` is the engine and touches no DOM: document model (`doc.js`),
  delta-based undo (`store.js`, over the neighbouring-state deltas in
  `history.js`), the harmonics and arp renderer (`harmonics.js`), the single
  flatten pipeline (`flatten.js`, shared by playback, wav, `.h` and ghosts),
  the Web Audio engine, the MIDI parser and the exporters.
- `js/ui/` is screens, the canvas piano roll and the panels. UI talks to core
  only through the store; core never touches the DOM.
- `js/ui/tools/` is one file per sidebar tool, each exporting
  `mount(host, ctx)`, plus `manifest.js` which declares them.
- Theme: the custom properties in `css/base.css`, which the canvases read too.
  The app icons are drawn from the same two colours by `tools/gen-icons.mjs`
  (a PNG is a signature, three chunks and a CRC, and Node ships the deflate);
  change the mark, re-run it, commit the PNGs.
- Console handle: `window.__chipseq` exposes `{store, uiStore, engine,
  conflicts, openProject, roll}` plus `offline` for the service worker
  (`update()`, `activate()`, `unregister()`).

### Adding a tool

One file plus one manifest entry. `js/ui/tools/manifest.js` declares each tool
with four things:

| | |
|---|---|
| `when(ctx)` | is it applicable at all? `false` hides the card |
| `status(ctx)` | `{on, label}` for the indicator, **cheap and pure** |
| `load()` | the only dynamic `import()`, run on first expand |
| `id`, `name` | identity; ids are asserted unique at load |

`status()` lives in the manifest rather than the tool module because it runs
for *collapsed* cards, and answering it must not require loading anything.
`js/ui/tools-panel.js` imports no tool at all: it builds every card from the
manifest and calls `tool.load()` the first time a card opens, so a tool you
never touch is never fetched, parsed or wired up.

Nothing looks a tool up by string, so a typo is a missing card at load time
rather than a card that silently renders nothing, and `tests/check.mjs` imports
every `load()` target so a broken tool fails CI instead of at runtime.

A tool whose status depends on something outside the document (the badge
roster, for instance) declares `subscribe(fn)` and the panel wires it up
without needing to know what it is.

Fold state is tri-state: absent means auto (follow the tool's own status), and
an explicit click is sticky from then on, because a card someone deliberately
closed must not spring back open every time the selection changes.

### Tables: commands and exporters

Two things the app used to say twice now live in one array each.

`js/ui/commands.js` holds every action that has both a shortcut and a button.
They were previously defined once in `toolbar.js` as a click handler and once
in `keymap.js` as a switch case, so a button and its key could drift apart and
nothing could enumerate what the app can do. Now the toolbar binds to the
table, the keymap dispatches through it, and `Ctrl+K` lists it. Two commands
claiming one chord used to be invisible, since whichever bound last simply won;
`duplicateChords()` is asserted empty by the unit suite.

Deliberately not everything: grid editing (arrows, delete, nudging, snap
digits) stays in `keymap.js`. Those are positional and contextual and
meaningless as palette entries, and a table you have to lie to is worse than
two honest handlers.

`js/core/exporters.js` holds the formats: id, extension, MIME type, which modes
they apply to, whether overlapping notes block them, and `render(doc, opts)`.
The export dialog derives its tabs, its disabled states and its download step
from that array, so adding `.mid` later is one builder plus one entry rather
than another branch in three places.

## The project file

Saved with every project is a self-versioned view block (scroll position, zoom,
cursor) that is deliberately *not* declared in `doc.uses`: a reader that
ignores it still plays the file correctly, which is the bar for belonging in
that list. Scrolling never pushes an undo entry and never triggers a save on
its own; it rides along with the next save, or with the flush when you leave
the tab.

### Growing the file format

Three rules keep `.chipseq.json` extensible without breaking files. The point
of all three: a build that meets a file it does not fully understand must still
open it, say what it cannot honour, and above all not quietly destroy the parts
it could not read.

1. **Extension blocks are namespaced and self-versioned.** Anything a feature
   owns lives in its own object carrying `kind` and `v`, e.g.
   `master.limiter = {kind:'limiter', v:1, ceilingDb:-0.1}`. A block evolves on
   its own `v`; `SCHEMA_VERSION` is bumped only for renames or changed meaning,
   never for additions, which default on load.
2. **Unknown keys are preserved verbatim.** `migrate()` mutates the parsed JSON
   instead of rebuilding a document from known fields, so a block this build
   has never heard of survives load-and-save untouched. Never reconstruct a
   document field by field: that is what silently drops a newer build's data.
3. **`doc.uses` declares what a reader must understand**, e.g.
   `['harmonics','automation','tempoMap']`. Meeting an entry it does not know,
   a build says so instead of playing the file wrong in silence. Entries this
   build cannot evaluate are carried over rather than recomputed away.

`tests/golden.mjs` pins all three.

One caveat about direction: a **v3 build refuses a v4 file outright**, because
its validator predates these rules and throws on any newer version. That is
fixed from v4 on, so the guarantee holds going forward, not backward.

### Tempo and meter are maps

`song.tempo` is `[{tick, bpm}]` and `song.meter` is `[{tick, num, den}]`, even
though the editing UI only ever writes one entry. Everything reads them through
`bpmAt` / `timeSigAt` / `tickToSeconds` / `secondsToTick`, and `tickToSeconds`
integrates across entries, so adding mid-song tempo changes is a UI job rather
than a rewrite of the engine and all four exporters. MIDI import already keeps
whole maps instead of discarding tempo changes with a warning.

`song.bpm` and `song.timeSig` remain as derived mirrors of the first map entry,
doing two jobs: a future build that restructures the maps can still find a
tempo in a file written here, and this build can still find one in that file.
`syncLegacyFields` recomputes them; the maps are always authoritative.

A multi-entry map is declared in `doc.uses` precisely because a reader that
falls back to the mirror plays one tempo throughout, which sounds fine and is
wrong, the worst kind of failure.

### Integrity and resilience

**Every id in the document names something that exists.** `enforceInvariants`
runs inside the store on every commit, project open, undo and redo, so
"well-formed" is a property of every snapshot rather than something each call
site has to remember. Deleting a track just deletes the track, and the active,
melody and chord markers are re-pointed for it. Orphaned instrument references
fall back to Square, a track-less or instrument-less project is given the
minimum back, and `chordTrackId` stays a soft reference that may be null. Only
*actual* repairs are reported, via `doc-repaired` in the status bar, so a
healthy project is never touched and the pass can run constantly without
becoming noise.

Deliberately not enforced: a muted melody track. It is a legitimate thing to
do, and moving the M marker in response would repeat an annoyance that was
already reported once. Markers do not wander on their own.

**Storage can fail at any moment and the editor does not care.** Every
localStorage access goes through wrappers in `js/core/persist.js` that never
throw. On failure the app degrades to an in-memory store, keeps the open
project fully editable for the rest of the session, and the status bar says so
persistently rather than in a flash, because every later edit is also not being
saved. It never deletes another project to make room, and a corrupt entry reads
as absent rather than throwing into the boot path.

## Audio internals

### Output level

Playback and the `.wav` exporter share one output stage (`js/core/graph.js`),
so what you hear is what you get. They used to differ, with exports rendering
about 1 dB hotter than the preview because only the engine applied the master
gain.

That stage ends in a soft clipper, so the downmix can never leave the master
above 0 dBFS: below -3 dBFS it is exactly transparent, above that it bends
smoothly toward a -0.1 dBFS ceiling. A stateless `WaveShaper` is used rather
than a compressor precisely because it behaves identically in realtime and
offline rendering.

Because a limited mix still *sounds* clean, the level is also reported. The
export dialog shows the peak and warns when the mix only fit because it was
shaped, and the status bar flags playback that goes over. Both read the peak
before the clipper, which is the number you need to act on.

### Spectrum

Stored as an optional `instrument.spectrum = {kind:'spectrum', v:1, tilt,
partials}` block, so an older build ignores it and plays the base wave: it
loses the shaping but sounds sensible, and no schema bump was needed. An
instrument with no spectrum block falls through to the browser's own
band-limited oscillator, so opening the editor and changing nothing changes
nothing.

The approach follows how additive engines actually work. In Harmor and Razor
the filter acts at the *generation* stage, scaling partial amplitudes inside
the oscillator rather than processing audio afterwards. The alternative, one
slider per partial, is how the Kawai K5000 reached a thousand parameters per
patch and a reputation for being unusable; the Hammond's nine drawbars are the
counter-example this copies.

One limit: the shaped wave is baked into a `PeriodicWave`, so it is static for
the note's duration. A moving filter sweep needs a real filter node, which is
what the effects layer adds.

### Levels

Measured on the shipped demos, Tetris and Bad Apple had been running about
+5 dB into the limiter since they were made, which is what prompted this.

A voice holds its final gain value through its release, so that value is taken
from the level the note actually had: sampled a whole grid cell inside the
note, and floored by the last few milliseconds rather than read at a single
instant. Both matter. 0.1 ms of backoff rounded into the same 5 ms cell as the
note's end, where simultaneous notes had already stopped being counted, and
smoothing eases the factor back toward 1 before a note is over. Together they
made a ducked chord release at 2.5x its own level.

Excluding a track means excluding it from *both* stages. It used to cancel only
the track stage, which for a monophonic lead was indistinguishable from doing
nothing, because the song stage kept riding it anyway. Setting a number instead
overrides just that track's own exponent and keeps the song stage.

Smoothing is a real trade-off: Bad Apple's notes run 18 to 109 ms, and 30 ms of
smoothing let a six-voice stack back over full scale where 10 ms held it under.

Make-up reads the *pre-limiter* peak, which is what makes the correction exact
even when the current setting is already driving the limiter. The result is a
stored number (`doc.master.makeup`) so preview and export apply exactly the
same gain; a value recomputed per render could not promise that. All of it is a
pure function of the flattened score, so it stays deterministic.

### Mixing

Every track gets its own node in the audio graph via `buildGraph` in
`js/core/graph.js`, called identically by playback and the WAV renderer, so
per-track gain and pan are audio operations rather than numbers baked into each
voice.

Editing any instrument parameter is copy-on-write: it writes an inline
`track.instrument` and never modifies the shared preset. The gain lane
multiplies on top of both, so a lane at 100% with the track at 80% is 80%.

A `StereoPannerNode` is only inserted when it will do something, because at pan
0 it still applies the -3 dB centre law; downmixed into a mono render that
would have made every unpanned export quietly 3 dB quieter.

Mute and solo stay *flatten-time* filters rather than becoming node gains.
Routing a muted track through a zero-gain node would mean scheduling and
rendering audio nobody can hear, 5650 notes of it in the Bad Apple demo, to
save a re-flatten that costs nothing.

### Effects

```jsonc
doc.buses   = [{ id, name, chain: [{ kind: 'delay', v: 1, params: {…} }] }]
track.sends = [{ busId, level }]
```

Routing is per-track node plus sends, chosen over an insert chain per track
because sends map 1:1 onto MIDI (CC91 reverb, CC93 chorus) while inserts map
onto nothing. `track.sends` is an array, so a full matrix is already
expressible even though the card edits one send at a time. The tap comes off
the track node, post-fader and pre-pan, so a track's fader moves its sends with
it.

Reverb is fed a *generated* impulse, decaying noise from a seeded PRNG, because
fetching an impulse would break the no-external-requests rule and `Math.random`
would give live and offline renders different reverbs.

Adding an effect is one entry in `EFFECTS` plus one
`build(ctx, spec, env) -> {input, output}`. An unknown kind is skipped rather
than fatal, so a project from a newer build loses that effect and not its whole
sound, which is the `doc.uses` rule applied at the audio layer.

### Envelopes and modulation

There used to be two systems for "a value that moves over time": ADSR
(note-relative, gain only, rendered as Web Audio ramps) and automation lanes
(song-absolute, sampled per event). Because ramps and `setValueCurveAtTime`
cannot share an `AudioParam`, gain automation needed a second gain node. That
node was the tell: two things were being combined in the node *graph* when they
should be combined in the *value* domain.

`js/core/modulation.js` does the multiplying, so a voice now uses one gain
node, with two paths chosen by whether anything actually varies:

- **ramps**, when only the envelope moves and it is ADSR-shaped. Scheduled as
  exact Web Audio ramps, so the badge's 2 ms attack lands on the sample it
  should. This is the common case and is bit-for-bit what it always was.
- **curve**, when a gain lane varies across the note or the envelope was drawn
  freehand. Instrument gain, envelope and lane are sampled together into one
  array covering the whole voice, release tail included. Sampling is by *time*
  (0.5 ms) rather than a fixed points-per-note budget, because the latter
  smears a 2 ms attack away on any note longer than a second.

The drawn envelope is stored as `instrument.env = {kind:'env', v:1, points,
sustainIndex, timeBase:'sec'}`, following the extension-block rule so there is
no migration. Points up to the sustain index are measured from note onset; the
rest from note off.

`note.detune` (cents) and `note.lfo` are live targets, which is what makes
vibrato and portamento data rather than deferred features; only the editing UI
is missing.

### Velocity is stored, not applied

Every note carries a `velocity` and MIDI import fills it in from the file:
Rickroll arrives with 48 distinct values spanning 2 to 100. It is preserved
through every edit, save and export, and it is deliberately not applied to the
sound.

Nothing in the UI shows or edits it, so a note sitting 3 dB below its
neighbours would look identical to them with nothing on screen to explain why,
which is indistinguishable from a bug. Until there is a velocity editor, every
note sounds at `NOMINAL_VELOCITY = 100`, the value notes written in the app
already carry, so ignoring velocity moves the notes that *deviate* rather than
shifting everything 2.1 dB.

Two places must agree on this and share one constant so they cannot drift: the
voice in `instruments.js` and the peak estimate in `normalize.js`. An estimate
that disagreed with what is rendered would warn about clipping that cannot
happen, or miss clipping that can. Re-enabling velocity is a one-line change in
each, plus a UI.

## Offline and the service worker

`sw.js` caches the app so an installed ChipSeq opens with no network. Three
things about it are worth knowing:

- **The file list is generated, never written.** `node tools/gen-precache.mjs`
  walks `index.html` and the real import graph (static imports, the tool cards'
  dynamic ones, the manifest's icons, the demos named by `demos/index.json`)
  and rewrites a marked block inside `sw.js`. A unit test fails if the
  committed block is stale, so a new module cannot ship missing from it. That
  matters more here than anywhere else in the repo: a file left out works
  perfectly until the one moment offline support is the point.
- **An update never activates by itself.** A new release installs in the
  background and waits; the status bar offers `update ready` and the switch
  happens when you click it. Activating unasked would reload away whatever is
  on screen, and would let a running page dynamic-import a tool card out of a
  different build's cache.
- **A release re-downloads only what changed.** Each entry carries a content
  hash, so installing copies untouched files across from the previous cache.
  The app is 2.4 MB, most of it demo songs, and a typical release changes two
  modules and moves a few KB.

Service workers require a **secure context**. That covers `chipseq.app`, GitHub
Pages, a Tailscale Funnel hostname and `localhost`, but *not* plain `http` to a
LAN address, where the browser will not register a worker at all and the app
stays online-only. Worth knowing before relying on it at a venue.

If a worker ever misbehaves, `__chipseq.offline.unregister()` in the console
removes it and drops its caches.

## Tests

No frameworks here either, just plain Node scripts in `tests/` (Node 22+):

```sh
node tests/unit.mjs        # core logic: arps, chords, exporters, MIDI, migrations, limiter, precache list
node tests/check.mjs       # imports every ES module to catch syntax errors
node tests/golden.mjs      # byte-compares exporter and pipeline output against fixtures
node tests/smoke.mjs       # browser tests driving the real UI headlessly
node tests/live-check.mjs  # verifies a deployed instance (defaults to https://chipseq.app/)
node server/test.mjs       # the badge relay server, no hardware needed
```

The browser suites need a Chromium binary; they auto-detect Playwright's cache
and common system paths, or set `CHROME_BIN=/path/to/chrome`.

`golden.mjs` is the regression net for "preview = export = badge". It pins the
migrated document, the flattened event stream and the `.h`/`.fmf` text for
every shipped demo, plus a determinism check and a forward-compatibility check.
Artifacts over 32 kB are stored as a hash with head and tail context instead of
in full. After a *deliberate* output change, regenerate with `node
tests/golden.mjs --update` and review the diff in its own commit, never inside
a feature commit, or an unintended change can hide in the noise.

Rendered audio is deliberately not byte-compared: `WaveShaper` behaviour varies
between Chromium builds, so the browser suite asserts peak, RMS, duration and
RIFF structure instead.

### What the browser suites learned the hard way

`smoke.mjs` finishes by **shutting its own web server down** and asserting the
app still boots, still loads demos and still resolves a lazily imported tool
card. Two things make that assertion mean anything:

- It first checks that a file *outside* the precache genuinely fails to load.
  Without that control the whole offline section passed while fully online,
  because CDP's network emulation applies to the page target and a service
  worker is a separate target, so its fetches went out over a live network.
- The static server sends `Cache-Control: no-store`. With no header at all,
  Chrome cached heuristically and the app booted offline from the *HTTP* cache
  with the worker doing nothing, verified by disabling the worker's cache
  lookup entirely and watching every test still pass.

Both browser suites take a **random debugging port** and read the one Chrome
actually chose from `DevToolsActivePort`, then wait for Chrome to exit before
deleting their profile. A fixed port silently attaches to whatever browser
already holds it: a leaked Chrome kept a profile alive for days, so runs were
driving a stale browser. Harmless until service workers, which persist, at
which point an edited `sw.js` installed as `waiting` while the old one kept
serving and a deliberately broken worker passed every test.

Neither suite sleeps through a navigation either. A `Runtime.evaluate` sent
while the previous document is being torn down is dropped and the reply never
arrives, so the run hangs rather than failing, which is a far worse way to be
wrong. They wait for the load event and then for the app to boot.

## Releasing

Pushes to `main` do **not** publish. Tags do:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

Before tagging, bump `APP_VERSION` in `js/core/version.js` and add the matching
`## [x.y.z]` section to `CHANGELOG.md`. Both workflows check that all three
agree and fail the release if they do not, because a site that announces a
version nobody can find in the history is worse than a late release.

If anything in the app changed, run `node tools/gen-precache.mjs` as well; the
unit suite fails if the committed block is stale, including when `APP_VERSION`
moved without it.

### chipseq.app (cyon)

`.github/workflows/cyon.yml` mirrors the repository to the webhosting over
FTPS. It is a separate workflow from the Pages one on purpose: both hosts
publish in parallel while the domain is proven, and dropping Pages later is one
file deleted.

The deploy is **FTPS rather than SSH**, and that is a constraint of the host
rather than a preference. cyon's SSH is main-user only and additional FTP users
get no SSH at all, so an SSH key in CI would hand the workflow every other site
on the hosting account. An additional FTP account *can* be confined to a single
directory (my.cyon, Webhosting, FTP), with system data and mail invisible to
it. Those accounts cannot use SFTP, since that rides on SSH, but they can use
FTPS, so the transfer is still TLS end to end. Scoped and encrypted, not one at
the cost of the other.

Setup, once:

| where | what |
|---|---|
| my.cyon, Webhosting, FTP | an FTP account whose directory is `public_html/chipseq.app` |
| environment secrets on `chipseq-app` | `CYON_FTP_HOST`, `CYON_FTP_USER`, `CYON_FTP_PASSWORD` |
| repo variable (optional) | `CYON_FTP_DIR`, default `/`, already the scoped account's root |

`CYON_FTP_HOST` must be the **server** hostname, such as `s079.cyon.net`, not
the domain. The FTP certificate is `*.cyon.net`, so `chipseq.app` can never
match it and verification fails. Putting the secrets on the environment rather
than the repository means only this workflow's deploy job can read them.

Four details in that workflow are load-bearing rather than tidy:

- `lftp` does the mirroring rather than a marketplace action, which would
  receive the FTP password on every run.
- `.git` is deleted before the mirror rather than merely excluded. Uploading it
  would republish the entire history over HTTP.
- A **preflight refuses to mirror if the FTP account is not actually scoped**.
  `--delete` is safe only because the account cannot reach past this one site,
  and that is a my.cyon setting nothing here can enforce, so if `public_html`
  is visible at the FTP root the deploy stops before deleting anything rather
  than after.
- **`sw.js` uploads last, alone.** An FTP mirror is not atomic, and the service
  worker reinstalls when `sw.js` changes, so if the new worker landed first a
  visitor in that window would precache a mixture of two builds and cache it as
  coherent, since every file still returns 200.

`.htaccess` carries the one thing a default server gets wrong: without
`AddType application/manifest+json .webmanifest` the manifest is served as
`application/octet-stream`, the browser ignores it, and the app stops being
installable with nothing in the console to explain why. cyon runs LiteSpeed,
which reads `.htaccess` but ignores directives it does not recognise
*silently*, so the deploy asserts the headers that file should produce rather
than assuming that shipping it was the same as it working.

`.app` is HSTS-preloaded at the TLD, so browsers refuse plain HTTP before a
request is made and the secure-context requirement is satisfied by
construction.

### GitHub Pages

`.github/workflows/pages.yml` runs the unit, module-import and golden suites,
checks the tag against `APP_VERSION` and the changelog, then deploys.

Branch-based publishing was dropped because Pages runs one deployment at a time
per repository: a burst of pushes queues up and each deploy step aborts itself
after about ten minutes of waiting. The workflow sets `cancel-in-progress`, so
a newer release supersedes an older one instead of both dying.
`workflow_dispatch` republishes without minting a tag.

One trap worth remembering if history is ever rewritten again: force-pushing
tags re-triggers this workflow once per tag, and an old tag winning the race
would republish an old build. Disable the workflow first.
