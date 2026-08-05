# ChipSeq

**n0ctus chiptune sequencer for Arduino, Flipper Zero, MCUs and more**

A purely browser-based chiptune sequencer with badge-accurate square-wave
preview and a non-destructive arpeggiator. Born for an ESP-driven event badge,
it exports to Arduino-style `.h` note arrays, Flipper Zero `.fmf` files, and
`.wav`. No build step, no dependencies - plain HTML/CSS/JS with native ES
modules.

![ChipSeq editor](assets/screenshot.png)

## Run it

```sh
python3 -m http.server        # from this directory
# open http://localhost:8000
```

Any static file server works (the app uses ES modules, so `file://` won't).
It's a fully static site - GitHub Pages serves it as-is (Settings → Pages →
deploy from the repository root).

## Modes

- **Mono** - one voice, badge-accurate square-wave preview, exports a `.h`
  header (`{NOTE_E4, 80}` entries, rests as `{NOTE_REST, ms}`) or a Flipper
  Zero `.fmf` file (RTTTL-style: note lengths quantized to 1/1…1/128 incl.
  dotted, rests as `P`; anything rounded is listed in the export warnings).
  Overlapping notes are flagged red (press `N` to cycle, status bar offers
  Auto-fix); mono exports are blocked until they're resolved.
- **Poly** - multiple tracks with instruments, exports `.wav`. Besides the
  square / sine / sawtooth presets, the **Instrument** tool (opens in the
  sidebar when you use a track's instrument picker) edits wave (incl.
  triangle and PWM with duty cycle), full ADSR envelope and gain. Edits make
  the track "Custom" until saved as a named preset, which then appears in
  every track's picker and travels in the project file.

## Automation lanes (poly)

Below the piano roll, every control of the active track's instrument gets its
own expandable **Automation** lane: Gain, Attack, Decay, Sustain, Release -
plus Duty for PWM instruments. Gain starts expanded (baseline 100%); the rest
sit collapsed as slim read-only previews and expand on click (clicking a
collapsed lane never edits anything). In an expanded lane: click adds a
keyframe, drag moves it, double-click cycles the curve (step / linear /
ease), right-click deletes. Levels read as percentages, where 0% is silence
and 100% is unity - the gain lane goes to 150%, with a dashed "100%" line
marking unity and any keyframe above it drawn in the warning colour, because
that is where the master limiter starts working. ADSR/duty values are
absolute overrides of the instrument's setting (dashed baseline = the
current value); values are
sampled per note event - every arp step reads the curve independently, so
fast arps become smooth sweeps - and held notes get true intra-note gain
ramps. Poly-only; mono and the `.h`/`.fmf` exports ignore automation
entirely.

## Output level

Playback and the `.wav` exporter share one output stage (`js/core/graph.js`),
so what you hear is what you get - they used to differ, with exports rendering
about 1 dB hotter than the preview because only the engine applied the master
gain.

That stage ends in a soft clipper, so the downmix can never leave the master
above 0 dBFS: below -3 dBFS it is exactly transparent, above that it bends
smoothly toward a -0.1 dBFS ceiling. A stateless `WaveShaper` is used rather
than a compressor precisely because it behaves identically in realtime and
offline rendering.

Because a limited mix still *sounds* clean, the level is also reported: the
export dialog shows the peak and warns when the mix only fit because it was
shaped ("Mix peaks at +3.2 dB…"), and the status bar flags playback that goes
over. Both read the peak *before* the clipper, which is the number you need to
act on. The limiter is stored per project as
`master.limiter = {kind, v, enabled, ceilingDb, kneeDb}`; there is no UI switch
yet, but the data supports one.

## The tools sidebar

The right sidebar is context-sensitive: with notes selected it offers
**Harmonics** (below) and **Transpose**; with no selection, Transpose targets
the whole active track. Transpose moves notes in bulk - ±1 octave, ±1
semitone, ±1 *scale degree* (stays in the song key), and "snap chromatic
notes to key" for cleanup after imports or key changes. Sections fold and
remember their state.

## Arpeggios (the fun part)

Select a note → right panel. The arpeggio is stored **on** the note
(non-destructive): tweak or remove it anytime, the original note stays.
Configure steps/beat, pattern (up / down / up-down / random), octave range,
per-step gap and chord (Auto song-chords / Auto diatonic / major / minor /
power / sus4 / octaves). Save configs as presets to reapply quickly.

The panel always shows **which chord the arp resolved to and why** (e.g.
"Am - song chords", or a yellow warning when a fallback kicked in), and the
▶ button auditions the selected note's arp. By default chords are stacked
upward from the note like FamiTracker's `0xy` effect - if the note isn't a
chord tone, the sweep uses only the chord's tones above it (no semitone
clusters). The **Voicing** control flips the chord below the note (the note
becomes the top tone - the classic shape for bass accompaniment), and
**Octave shift** transposes the whole sweep ±3 octaves, e.g. to imitate a
bass chords part without moving the note out of the melody register.

"Auto (song chords)" follows the track marked as *chords* - but that mark is
only a **recommendation**, not a lock-in. Every arp gets a "Chord source"
menu, ordered by familiarity: the recommended track first, then the chord
any *other* track implies at that position, then quality chords (major,
minor, power, 7ths … the more exotic, the further down), and finally "Pick
notes…" - a 12-key picker for arbitrary chords. Track sources stay live
(edit the track and the arps follow); presets never store source info.

Use the **M**/**C** buttons in the track list to pick the melody and chords
tracks in any mode (right-clicking a track also toggles chords). The M marker
is independent of the highlighted row: clicking a row only changes which
track you're viewing/editing - what plays in mono moves only when you click
M. The panels
are resizable by dragging their inner edge (double-click resets). Chord
tracks are analyzed like a DAW chord track: each chord **holds until the
next one**, staccato hits and broken/arpeggiated figures resolve to their
full chord per bar. With no chords track (or before the first chord) it
falls back to the song key; chromatic notes get the key mode's triad
quality - every fallback is spelled out in the panel.

## MIDI import

Drop a `.mid` file anywhere to start a **new project** from it. To pull tracks
**into the project you're working on**, use the music-note button next to "+"
in the tracks panel: the same assignment dialog appears, but the chosen tracks
are appended - song settings, existing tracks and the melody marker stay put,
and colliding names get a numbered suffix. Notes keep their musical positions,
so a file with a different tempo simply plays at the project's BPM (the dialog
warns when they differ).

Drop a `.mid` file anywhere. Every MIDI instrument (each channel in each
chunk) becomes its own track, labeled with its General MIDI program name.
You then assign each one a role (melody / chords / muted / skip) - the app
pre-suggests them: lead-like instruments become the melody, piano/organ/guitar
comping is preferred over pads and ambience for the chords role, and drums are
skipped. BPM, time signature and key are taken from the file; if the file has
no key-signature event, the key is guessed from the notes (and marked as a
guess). The ♪? button next to the Key selector re-runs that detection on the
current song at any time.

## Files

- Projects autosave to localStorage on every change (recent list on the start
  screen). `Export → .tune.json` gives a portable project file; everything in
  it stays editable, including applied arpeggios.
- Opening the app resumes the project you last had open, with the piano roll
  centred on the active track's notes (mono badge tunes sit high, so the
  default view would cut them off).
- **Demos** get their own section on the start page and are loaded fresh from
  `demos/` on every visit, so updates always reach everyone - they are never
  copied into your storage. Open one to explore it; the moment you edit, a
  personal copy with the same name is created and the demo stays pristine.
  Add your own by dropping a `.tune.json` into `demos/` and listing it in
  `demos/index.json` - that list is also the display order. Shipped: "Demo Mono" (arpeggios), "Demo Poly"
  (automation lanes: PWM duty sweep, intra-note gain swell, stepped-gain
  echoes, release change), "Rickroll", "Tetris" and "Bad Apple".
- The export dialog can restrict `.h`/`.wav` output to the **loop region**
  (checkbox, shown with its bar range). Region exports keep leading/trailing
  rests and are cut to the exact region length, so they loop seamlessly on
  the badge and in samplers.

## Keyboard (excerpt)

| Keys | Action |
|---|---|
| `Space` / `Shift+Space` | play/stop (always from the placed cursor) - pause/resume in place |
| Arrows / `Shift+Arrows` | move cursor - move/transpose selection |
| `Alt+←/→` | resize selection |
| `Enter` / `Delete` | add-or-select note - delete selection |
| `Tab` | next note, `Ctrl+A` select all |
| `Ctrl+Z/Y` `Ctrl+C/X/V/D` | undo/redo, clipboard, duplicate |
| `1`-`6`, `7`, `0` | snap 1/1…1/32 - triplet - off |
| `Q` | quantize selection |
| `L` `M` `N` | loop - metronome - next conflict |
| `Ctrl+Shift+[` / `]` | trim before / after cursor |
| `Ctrl+E` | export |

Click the ruler to place the cursor (green marker - `Space` always starts
there; right-click offers "Reset cursor to start"); drag on it for a loop
region, right-click for loop/trim options. The loop region is part of the
project - it survives reloads and travels in `.tune.json` files, as does
the snap/grid preference.
In the grid: plain drag marquee-selects, a plain click just moves the cursor.
`Shift+drag` draws a note from start to release (snapped; `Alt` for freeform),
`Shift+click` adds one at the last-used length. Right-click deletes notes
(drag to sweep-erase); `Alt+drag` duplicates. Wheel scrolls through time,
`Shift+wheel` scrolls pitch, `Ctrl+wheel` zooms, middle-drag pans.

## Tests

No frameworks here either - plain Node scripts in `tests/` (Node 22+):

```sh
node tests/unit.mjs        # core-logic tests (arps, chords, exporters, MIDI, migrations, limiter)
node tests/check.mjs       # imports every ES module to catch syntax errors
node tests/golden.mjs      # byte-compares exporter + pipeline output against fixtures
node tests/smoke.mjs       # browser tests driving the real UI headlessly
node tests/live-check.mjs  # verifies a deployed instance (defaults to the GitHub Pages URL)
```

The browser suites need a Chromium binary - they auto-detect Playwright's
cache and common system paths, or set `CHROME_BIN=/path/to/chrome`.

`golden.mjs` is the regression net for "preview = export = badge": it pins the
migrated document, the flattened event stream and the `.h`/`.fmf` text for
every shipped demo, plus a determinism check (the same document must always
flatten identically) and a forward-compatibility check (unknown blocks in a
`.tune.json` survive a load/save round-trip untouched). Artifacts over 32 kB
are stored as a hash with head/tail context instead of in full. After a
*deliberate* output change, regenerate with `node tests/golden.mjs --update`
and review the diff in its own commit - never inside a feature commit, or an
unintended change can hide in the noise.

Rendered audio is deliberately not byte-compared: `WaveShaper` behaviour
varies between Chromium builds, so the browser suite asserts peak, RMS,
duration and RIFF structure instead.

## Hacking

- `js/core/` - engine, no DOM: document model (`doc.js`), snapshot undo
  (`store.js`), the harmonics/arp renderer (`harmonics.js`), the single flatten pipeline
  (`flatten.js`, shared by playback/wav/h/ghosts), Web Audio engine, MIDI
  parser, exporters.
- `js/ui/` - screens, canvas piano roll, panels. UI talks to core only via
  the store; core never touches the DOM.
- Theme: edit the custom properties in `css/base.css` - the canvases read
  them too.
- Console handle: `window.__chipseq` exposes `{store, uiStore, engine}`.
