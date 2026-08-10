# ChipSeq

**n0ctus chiptune sequencer for Arduino, Flipper Zero, MCUs and more**

A browser-based chiptune sequencer with badge-accurate square-wave preview and
a non-destructive arpeggiator. Born for an ESP-driven event badge, it exports
Arduino-style `.h` note arrays, Flipper Zero `.fmf` files and `.wav`.

**[chipseq.app](https://chipseq.app/)**

Your browser will offer to install it as an app. Once installed it works with
the network off: editing, playback, rendering and every exporter run from a
local copy, so a rebooted laptop in a field with no signal still works.
Projects live in your browser, never on a server.

![ChipSeq editor](assets/screenshot.png)

## Mono and poly

**Mono** is one voice with a badge-accurate square-wave preview. It exports a
`.h` header (`{NOTE_E4, 80}` entries, rests as `{NOTE_REST, ms}`) or a Flipper
Zero `.fmf` file. Overlapping notes are flagged red; press `N` to cycle through
them, or use Auto-fix in the status bar. Mono exports stay blocked until the
overlaps are resolved, because a single-voice device cannot play them.

**Poly** is multiple tracks with their own instruments, exported as `.wav`.
Everything below marked *(poly)* applies only here; mono deliberately ignores
mixing, effects and automation so that what you hear is exactly what the badge
will play.

## Writing notes

Click the ruler to place the cursor (the green marker, where `Space` starts
from); drag on it for a loop region, right-click it for loop and trim options.

In the grid, a plain drag marquee-selects and a plain click moves the cursor.
`Shift+drag` draws a note from start to release, `Alt` for freeform;
`Shift+click` adds one at the last-used length. Right-click deletes, and drags
to sweep-erase. `Alt+drag` duplicates. The wheel scrolls through time,
`Shift+wheel` scrolls pitch, `Ctrl+wheel` zooms and middle-drag pans.

The panels are resizable by dragging their inner edge; double-click resets.

During playback the view follows along. The playhead travels until it reaches a
third of the way across, then holds there while the grid scrolls underneath it,
and when the grid runs out it moves on again to the end. Scrolling by hand
while playing stands the following down so you can look elsewhere; pressing
play again re-engages it.

## Arpeggios

Select a note and use the right panel. The arpeggio is stored **on** the note,
so it is never destructive: tweak or remove it at any time and the original
note is still there. You get steps per beat, pattern (up, down, up-down,
random), octave range, per-step gap, and chord (auto song-chords, auto
diatonic, major, minor, power, sus4, octaves). Configurations can be saved as
presets.

The panel always shows which chord the arp resolved to and why, such as
"Am - song chords", or a yellow warning when a fallback kicked in. The ▶ button
auditions the selected note's arp.

Chords are stacked upward from the note by default, like FamiTracker's `0xy`
effect. If the note is not a chord tone the sweep uses only the chord tones
above it, so you never get semitone clusters. **Voicing** flips the chord below
the note, making the note the top tone, which is the classic shape for bass
accompaniment. **Octave shift** moves the whole sweep by up to three octaves.

"Auto (song chords)" follows the track marked as *chords*, but that mark is
only a recommendation. Every arp has a "Chord source" menu ordered by
familiarity: the recommended track first, then the chord any other track
implies at that position, then quality chords, and finally "Pick notes…" for
arbitrary ones. Track sources stay live, so editing the track updates the arps.

## Tracks

Drag a row from anywhere to reorder it. A plain click still selects and a
double-click still opens the Track dialog, where name and colour are set
together. Track colour is either a palette index that follows the theme, or a
literal hex value you type in.

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
| **mute** | no | hidden | no, it is not part of the piece |
| **solo** | only soloed tracks | others stay visible, drawn faint | yes, unchanged |

Solo not touching Levels is the point of it: a soloed track previews at the
level it has *in the mix*, which is the only level worth judging it at. Mute is
the opposite, since a muted track leaves the piece and the others get its
headroom back.

Several tracks can be soloed at once. Mute beats solo, and the track you are
editing stays visible even when muted so that muting never makes it
uneditable.

## Instruments (poly)

The **Instrument** card edits the active track: wave (square, sine, sawtooth,
triangle, and PWM with a duty cycle), a full ADSR envelope, and gain. Edits
make the track "Custom" until you save them as a named preset, which then
appears in every track's picker and travels inside the project file.

Editing an instrument never modifies a shared preset, so a preset used by three
tracks stays put when one of them is changed.

**Spectrum** shapes the wave's own harmonics. A base wave *is* its harmonic
series, so picking a wave and tuning its harmonics is one idea rather than two.
**Tilt** is the main control, in dB per octave across the whole series, so one
knob darkens or brightens. Eight **drawbars** are the detail layer, scaling the
lowest partials where the ear is most sensitive.

Multipliers scale what the wave already has and cannot invent a partial that is
not there, so a sine offers no spectrum at all. Start from Saw to sculpt
freely, since it is the one wave carrying every harmonic. 100% everywhere with
zero tilt is the raw wave.

The **envelope** is one shape with two editors. The four ADSR sliders drive it
while it stays ADSR-shaped; drag a point on the canvas into something they
cannot express and the sliders grey out rather than rounding your curve back
into four numbers. "Reset to ADSR" brings them back exactly as they were. A
note shorter than its own attack releases from wherever it actually got to,
not from a sustain level it never reached.

## Automation lanes (poly)

Below the piano roll, every control of the active track's instrument gets an
expandable lane: Gain, Attack, Decay, Sustain, Release, plus Duty for PWM
instruments. Gain starts expanded; the rest sit collapsed as slim read-only
previews and expand on click, so clicking a collapsed lane never edits
anything.

In an expanded lane, click adds a keyframe, drag moves it, double-click cycles
the curve (step, linear, ease) and right-click deletes. Levels read as
percentages where 100% is unity. The gain lane goes to 150%, with a dashed
"100%" line marking unity and anything above it drawn in the warning colour,
because that is where the master limiter starts working.

Values are sampled per note event, so every arp step reads the curve
independently and fast arps become smooth sweeps. Held notes get true
intra-note ramps.

## Mixing (poly)

The **Mixer** card sets per-track **gain** and **pan**, plus solo.

There are two gain stages and it is worth knowing which to reach for. The
Instrument card's gain is part of the sound's design, and changing it makes the
track Custom. The Mixer's gain is where a track is balanced against the others,
so reach for the Mixer to mix.

**Pan** also exists as an automation lane, so a voice can sweep across the
field over time. **Spread** fans the tracks out in one click, melody centred
and the rest alternating outward, as a starting point you then adjust. A MIDI
import of more than two tracks gets the same treatment, so a multi-track file
arrives sounding like an arrangement rather than a mush stacked dead centre.

Exports go stereo only when something is actually panned; an unpanned project
renders the same mono file it always did. The export dialog says which it will
be and why, with a **Force stereo** checkbox for when you want two channels
regardless.

## Effects (poly)

A **bus** is a shared effect. Tracks send part of their signal to it and the
result is mixed back in, so one reverb serving six tracks is one reverb rather
than six. Three kinds ship: **delay** (synced to the grid, so it follows the
tempo), **filter**, and **reverb**.

There is deliberately no per-effect dry/wet control. The dry path is the
track's own output and the send level decides how much arrives, so a mix knob
would be a second control for one thing.

## Levels (poly)

Voices sum together, so with the default instrument gain three simultaneous
notes already reach the limiter. The **Levels** card fixes that by scaling
voices according to how many are sounding, in two stages:

- **track**: how many voices does *this* track have right now? Balances a
  chord against a single note within one instrument.
- **song**: how many are sounding anywhere right now? Balances the whole
  arrangement against a solo passage.

`k` is the dial. `0` is off, `0.5` is equal power (four voices are twice one
voice, not four times), and `1` is constant sum (a chord is exactly as loud as
one note). Because the factor follows what is actually sounding, a solo passage
is left alone entirely.

**Smoothing** matters more than it looks: the factor changes in steps, and a
step in gain is a click, but too much smoothing lets short dense hits through.
The card shows the predicted peak with and without normalization, so a setting
can be judged by number as well as by ear.

Individual tracks can be **excluded**, which is usually what you want for a
lead. An excluded voice plays at exactly the level it was written at while the
rest of the arrangement still normalizes around it.

**Analyse** (make-up) renders the song once, reads the peak, and sets a single
master gain so that peak lands just below full scale. Levels only ever turns
things down, so without it a mostly polyphonic song sits permanently quiet.
Nothing changes until you press it, and the result is stored in the project so
preview and export apply the same gain.

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

Press `Ctrl+E`. The formats available depend on the mode:

| Format | Mode | What it is |
|---|---|---|
| `.h` | mono | Arduino-style note array for a badge or MCU |
| `.fmf` | mono | Flipper Zero Music Format |
| `.wav` | poly | 44.1 kHz 16-bit render, using the playback engine |
| `.chipseq.json` | both | the full project, nothing lost |

`.h` and `.wav` can be restricted to the **loop region** with a checkbox that
shows its bar range. Region exports keep leading and trailing rests and are cut
to the exact region length, so they loop seamlessly on the badge and in
samplers.

`.fmf` quantizes note lengths to the durations that format allows, and anything
that had to be rounded is listed in the export warnings.

## Projects, demos and storage

Projects autosave to your browser's local storage on every change, and the
start screen lists the recent ones. Opening the app resumes the project you
last had open, with the piano roll centred on the active track's notes.

Everything is saved with the project, so reopening puts you exactly where you
left off: the loop region, snap and grid preference, active track, scroll
position, zoom level and cursor position.

`Export → .chipseq.json` gives a portable project file in which everything
stays editable, including applied arpeggios. The compound extension is
deliberate: it keeps the `.json` suffix so editors, `jq` and GitHub all still
understand the file. Older `.tune.json` files still open.

**Demos** have their own section on the start page and load fresh on every
visit, so they are never copied into your storage. Open one to explore it; the
moment you edit, a personal copy with the same name is created and the demo
itself stays pristine. Shipped: Demo Mono (arpeggios), Demo Poly (automation
lanes), Rickroll, Tetris and Bad Apple.

If local storage is unavailable, as in some private browsing modes, or full,
the editor keeps working for the rest of the session and the status bar says
`not saving` rather than losing your work silently.

## Playing on badges

The **LuxCamp Badge 2026** card pairs ESP32 badges over the internet and plays
a track live on them, uploads tunes for standalone playback, and lets badges
form their own offline mesh. That needs the relay server, which has its own
guide in [`server/README.md`](server/README.md).

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

`Ctrl+K` lists every command that has a shortcut, filtered as you type, and
shows only the ones that would actually do something right now.

## More

- [DEVELOPMENT.md](DEVELOPMENT.md) covers running it locally, the
  architecture, the file format, testing, releasing and deployment.
- [`server/README.md`](server/README.md) is the badge relay server.
- [CHANGELOG.md](CHANGELOG.md) is the release history.

No build step, no dependencies: plain HTML, CSS and JavaScript with native ES
modules. MIT licensed.
