# ChipSeq

**n0ctus chiptune sequencer for Arduino, Flipper Zero, MCUs and more**

A browser-based chiptune sequencer with badge-accurate square-wave preview and
a non-destructive arpeggiator. It exports Arduino-style `.h` note arrays,
Flipper Zero `.fmf` files and `.wav`.

**[chipseq.app](https://chipseq.app/)**

Your browser will offer to install it as an app. Once installed it works with
the network off. Projects live in your browser, never on a server.

![ChipSeq editor](assets/screenshot.png)

## Mono and poly

**Mono** is one voice, previewed as the square wave a badge actually produces,
and exports `.h` or `.fmf`. Overlapping notes are flagged red and block a mono
export until they are resolved: press `N` to cycle through them, or use
Auto-fix in the status bar.

**Poly** is multiple tracks with their own instruments, exported as `.wav`.
Everything marked *(poly)* below applies only there. Mono ignores mixing,
effects and automation entirely, so the preview stays exactly what the badge
will play.

## Writing notes

`Space` always plays from the cursor, which you place by clicking the ruler.
Drag on the ruler for a loop region, right-click it for loop and trim options.

In the grid, a plain drag marquee-selects and a plain click moves the cursor.
`Shift+drag` draws a note from start to release, `Alt` for freeform;
`Shift+click` adds one at the last-used length. Right-click deletes, and drags
to sweep-erase. `Alt+drag` duplicates. The wheel scrolls through time,
`Shift+wheel` scrolls pitch, `Ctrl+wheel` zooms and middle-drag pans.

Double-clicking a panel edge resets its width.

## Arpeggios

Select a note and use the right panel. The arpeggio is stored **on** the note,
so it is never destructive: tweak or remove it at any time and the original
note is still there. You get steps per beat, pattern (up, down, up-down,
random), octave range, per-step gap, and chord (auto song-chords, auto
diatonic, major, minor, power, sus4, octaves). Configurations can be saved as
presets.

Chords are stacked upward from the note, like FamiTracker's `0xy` effect. If
the note is not a chord tone the sweep uses only the chord tones above it, so
you never get semitone clusters. **Voicing** flips the chord below the note,
making the note the top tone, which is the classic shape for bass
accompaniment. **Octave shift** moves the whole sweep by up to three octaves.

"Auto (song chords)" follows the track marked as *chords*, but that mark is
only a recommendation. Every arp has a "Chord source" menu: the recommended
track, the chord any other track implies at that position, quality chords, and
"Pick notes…" for arbitrary ones. Track sources stay live, so editing the track
updates the arps that follow it. Presets never store a source.

## Tracks

A track's colour is either a palette index that follows the theme, or a literal
hex value you type into the Track dialog.

Use the **M** and **C** buttons in the track list to mark the melody and chords
tracks. The M marker is independent of which row is highlighted: clicking a row
only changes what you are viewing and editing, while what plays in mono moves
only when you click M.

Chord tracks are analysed like a DAW chord track. Each chord holds until the
next one, and staccato hits or broken figures resolve to their full chord per
bar. With no chords track, or before the first chord, it falls back to the song
key.

### Mute and solo

|  | sounds | in the grid | counted by Levels |
|---|---|---|---|
| **mute** | no | hidden | no |
| **solo** | only soloed tracks | others stay visible, drawn faint | yes, unchanged |

A soloed track therefore previews at the level it has in the mix, while muting
a track gives the others its headroom back.

Several tracks can be soloed at once. Mute beats solo, and the track you are
editing stays visible even when muted.

## Instruments (poly)

The **Instrument** card edits the active track: wave (square, sine, sawtooth,
triangle, and PWM with a duty cycle), a full ADSR envelope, and gain. Edits
make the track "Custom" until you save them as a named preset, which then
appears in every track's picker and travels inside the project file.

Editing an instrument never modifies a shared preset, so a preset used by three
tracks stays put when one of them is changed.

**Spectrum** scales the harmonics the wave already has. **Tilt** is the main
control, in dB per octave across the whole series; eight **drawbars** scale the
lowest partials individually. It cannot invent a partial that is not there, so
a sine offers no spectrum at all and Saw is the one to start from if you want
to sculpt freely. 100% everywhere with zero tilt is the raw wave.

The **envelope** is one shape with two editors. The four ADSR sliders drive it
while it stays ADSR-shaped; drag a point on the canvas into something they
cannot express and the sliders grey out rather than rounding your curve back
into four numbers. "Reset to ADSR" brings them back exactly as they were. A
note shorter than its own attack releases from wherever it actually got to, not
from a sustain level it never reached.

## Automation lanes (poly)

Every control of the active track's instrument gets a lane below the piano
roll: Gain, Attack, Decay, Sustain, Release, plus Duty for PWM instruments. A
collapsed lane is a read-only preview, so clicking one open never edits it.

Click adds a keyframe, drag moves it, double-click cycles the curve (step,
linear, ease) and right-click deletes. Levels read as percentages where 100% is
unity. The gain lane goes to 150%, and anything above the dashed unity line is
drawn in the warning colour, because that is where the master limiter starts
working.

Values are sampled per note event, so every arp step reads the curve
independently and fast arps become smooth sweeps. Held notes get true
intra-note ramps.

## Mixing (poly)

The **Mixer** card sets per-track gain and pan, plus solo. Reach for it to
balance tracks against each other; the Instrument card's gain is part of the
sound's design and changing it makes the track Custom.

**Pan** also exists as an automation lane, so a voice can sweep across the
field over time. **Spread** fans the tracks out in one click, melody centred
and the rest alternating outward. A MIDI import of more than two tracks arrives
already spread.

Exports go stereo only when something is actually panned. The export dialog
says which it will be, with a **Force stereo** checkbox for when you want two
channels regardless.

## Effects (poly)

A **bus** is a shared effect: tracks send part of their signal to it and the
result is mixed back in, so one reverb serving six tracks is one reverb. Three
kinds ship: **delay** (synced to the grid, so it follows the tempo),
**filter**, and **reverb**. The send level is the only mix control.

## Levels (poly)

Voices sum, so a handful of simultaneous notes reaches the limiter on their
own. **Levels** scales them by how many are sounding, in two stages:

- **track**: how many voices does *this* track have right now? Balances a
  chord against a single note within one instrument.
- **song**: how many are sounding anywhere right now? Balances the whole
  arrangement against a solo passage.

`k` is the dial. `0` is off, `0.5` is equal power (four voices are twice one
voice, not four times), and `1` is constant sum (a chord is exactly as loud as
one note). A passage with one voice sounding is left alone at any setting.

**Smoothing** is a trade-off rather than a "higher is better" dial: too little
and the gain steps click, too much and short dense hits get through.

Individual tracks can be **excluded**, which is usually what you want for a
lead. An excluded voice plays at exactly the level it was written at while the
rest of the arrangement still normalizes around it.

**Analyse** renders the song once and sets a single master gain so the peak
lands just below full scale, which is what brings a mostly polyphonic song back
up to a finished level. Nothing changes until you press it, and the result is
stored in the project, so preview and export apply the same gain.

Mono is never touched by any of this.

## MIDI import

Drop a `.mid` file anywhere to start a new project from it. To pull tracks into
the project you already have open, use the music-note button next to "+" in the
tracks panel: the same dialog appears, but the chosen tracks are appended and
your song settings, existing tracks and melody marker stay put.

Every MIDI instrument becomes its own track, labelled with its General MIDI
program name. You assign each one a role (melody, chords, muted, skip) and the
app pre-suggests them: lead-like instruments become the melody, comping
instruments are preferred for chords, and drums are skipped. BPM, time
signature and key come from the file; if there is no key signature the key is
guessed from the notes and marked as a guess. The ♪? button next to the Key
selector re-runs that detection at any time.

Notes keep their musical positions, so a file with a different tempo simply
plays at the project's BPM. The dialog warns when they differ.

## Exporting

`Ctrl+E`. Which formats are offered depends on the mode:

| Format | Mode | What it is |
|---|---|---|
| `.h` | mono | Arduino-style note array for a badge or MCU |
| `.fmf` | mono | Flipper Zero Music Format |
| `.wav` | poly | 44.1 kHz 16-bit render, using the playback engine |
| `.chipseq.json` | both | the full project, nothing lost |

`.h` and `.wav` can be restricted to the **loop region**. Region exports keep
leading and trailing rests and are cut to the exact region length, so they loop
seamlessly on the badge and in samplers.

`.fmf` quantizes note lengths to the durations that format allows, and anything
that had to be rounded is listed in the export warnings.

## Projects, demos and storage

Projects autosave to your browser's local storage on every change, and opening
the app resumes the one you last had open. The loop region, snap and grid
preference, active track, scroll position, zoom and cursor are all saved with
it, so reopening puts you exactly where you left off.

`.chipseq.json` is the portable project file, and everything in it stays
editable, including applied arpeggios. Older `.tune.json` files still open.

**Demos** load fresh on every visit and are never copied into your storage.
Open one to explore it; the moment you edit, a personal copy with the same name
is created and the demo itself stays pristine. Shipped: Demo Mono (arpeggios),
Demo Poly (automation lanes), Rickroll, Tetris and Bad Apple.

If local storage is unavailable, as in some private browsing modes, or full,
the editor keeps working for the rest of the session and the status bar says
`not saving` rather than losing your work silently.

## Playing on badges

The **LuxCamp Badge 2026** card pairs ESP32 badges over the internet and plays
a track live on them, uploads tunes for standalone playback, and lets badges
form their own offline mesh. That needs the relay server, which has its own
guide in [`server/README.md`](server/README.md).

A tune stored on a badge can be fetched back and opened for editing (on
firmware that supports it), and a `.cbt` file can be dropped on the app like
any other import. Either way what comes back is a conversion, not the original
project: arpeggios arrive as plain notes, and instruments and automation are
not stored in the badge format. The app says so when it happens.

## Keyboard

| Keys | Action |
|---|---|
| `Space` / `Shift+Space` | play/stop from the cursor, pause/resume in place |
| Arrows / `Shift+Arrows` | move cursor, move or transpose selection |
| `Alt+←/→` | resize selection |
| `Enter` / `Delete` | add-or-select note, delete selection |
| `Tab` / `Ctrl+A` | next note, select all |
| `Ctrl+Z/Y`, `Ctrl+C/X/V/D` | undo/redo, clipboard, duplicate |
| `1`-`6`, `7`, `0` | snap 1/1 to 1/32, triplet, off |
| `Q` | quantize selection |
| `L` `M` `N` | loop, metronome, next conflict |
| `Ctrl+Shift+[` / `]` | trim before / after cursor |
| `Ctrl+E` | export |
| `Ctrl+K` | command palette |

## More

- [DEVELOPMENT.md](DEVELOPMENT.md) covers running it locally, the
  architecture, the file format, testing, releasing and deployment.
- [`server/README.md`](server/README.md) is the badge relay server.
- [CHANGELOG.md](CHANGELOG.md) is the release history.

MIT licensed.
