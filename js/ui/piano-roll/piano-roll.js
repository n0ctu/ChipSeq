// Piano roll orchestrator: canvas layers, DPR sizing, dirty-flag rAF loop,
// scroll/zoom, scrollbars. Mouse handling lives in interactions.js.

import { readTheme, drawGrid, drawNotes, drawOverlay, drawRuler, drawKeys, drawChordLane } from './render.js';
import { clampScroll, effectiveSnap, followScroll, tickToX, PITCH_MIN, PITCH_MAX } from './coords.js';
import { flattenNote, buildChordEvents } from '../../core/flatten.js';
import { songEndTick, soloActive } from '../../core/doc.js';
import { chordName } from '../../core/music.js';
import { attachInteractions } from './interactions.js';
import { initAutomationLane } from './automation-lane.js';

export function initPianoRoll(store, uiStore, engine, conflicts) {
  const viewport = document.getElementById('roll-viewport');
  const canvases = {
    grid: document.getElementById('grid-canvas'),
    notes: document.getElementById('notes-canvas'),
    overlay: document.getElementById('overlay-canvas'),
    ruler: document.getElementById('ruler-canvas'),
    keys: document.getElementById('keys-canvas'),
    chords: document.getElementById('chords-canvas'),
    auto: document.getElementById('auto-canvas'),
  };
  const ctxs = Object.fromEntries(Object.entries(canvases).map(([k, c]) => [k, c.getContext('2d')]));

  let theme = readTheme();
  let W = 0;
  let H = 0;
  const dirty = { grid: true, notes: true, overlay: true, ruler: true, keys: true, chords: true, auto: true };

  // Chord events are rebuilt lazily on data changes, not per frame.
  let chordCache = null;
  function chordEvents() {
    if (!chordCache) {
      chordCache = buildChordEvents(store.getDoc()).map((ev) => ({ ...ev, name: chordName(ev.pcs) }));
    }
    return chordCache;
  }
  store.subscribe(['notes', 'tracks', 'song', 'doc'], () => {
    chordCache = null;
    markDirty('chords');
  });

  function markDirty(...layers) {
    for (const l of layers) dirty[l] = true;
  }
  function markAll() {
    markDirty('grid', 'notes', 'overlay', 'ruler', 'keys', 'chords', 'auto');
  }

  // ---- following the playhead ----
  //
  // The playhead is anchored a third of the way across the viewport and the
  // grid scrolls under it. The three phases that implies are NOT three cases in
  // the code: put the anchor where it belongs and clamp, and they fall out.
  //
  //   at the start   the ideal scroll is negative, so the clamp holds it at 0
  //                  and the playhead travels across to the anchor
  //   in the middle  the scroll tracks the playhead, which stays put
  //   at the end     the ideal scroll exceeds the last page, so the clamp
  //                  holds it there and the playhead travels on to the end
  //
  // Written as three branches this would need to know which phase it is in, and
  // the boundaries would be two more numbers to get wrong. followScroll() is
  // pure and lives in coords.js, so tests/unit.mjs can pin all three.
  let follow = true;
  let wasPlaying = false;

  // Scrolling by hand during playback means you want to look somewhere else, so
  // following stands down rather than yanking the view back a frame later.
  // Starting playback again re-engages it, which is the only way back - and the
  // only one worth having, since it needs no control of its own.
  function stopFollowing() {
    follow = false;
  }

  function sizeCanvas(canvas, ctx) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resizeAll() {
    for (const key of Object.keys(canvases)) sizeCanvas(canvases[key], ctxs[key]);
    W = canvases.overlay.clientWidth;
    H = canvases.overlay.clientHeight;
    clampScroll(uiStore.state, W, H, songEndTick(store.getDoc()));
    markAll();
  }
  new ResizeObserver(resizeAll).observe(viewport);

  // ---- visible items (notes + ghost events) ----
  function visibleItems() {
    const doc = store.getDoc();
    const ui = uiStore.state;
    const startTick = ui.scrollTick - 4 * doc.ppq;
    const endTick = ui.scrollTick + W / ui.pxPerTick + doc.ppq;
    const items = [];
    const erased = ui.dragErasedIds;

    const tracks =
      doc.mode === 'mono'
        ? doc.tracks.filter((t) => t.id === doc.activeTrackId)
        : [...doc.tracks.filter((t) => t.role !== 'muted' && t.id !== doc.activeTrackId),
           ...doc.tracks.filter((t) => t.id === doc.activeTrackId)];

    // Solo silences without hiding: those notes stay on the grid so the piece
    // is still readable while you listen to one part of it. Mute is the one
    // that removes them (the filter above), because a muted track is not part
    // of the piece right now.
    const solo = soloActive(doc);
    for (const track of tracks) {
      const silenced = solo && !track.solo;
      for (const note of track.notes) {
        if (note.startTick > endTick) break;
        if (note.startTick + note.durationTicks < startTick && !note.harmonics) continue;
        if (erased && erased.has(note.id)) continue;
        const item = { track, note, ghost: null, silenced };
        if (note.harmonics) {
          const events = flattenNote(doc, track.id, note.id);
          if (!(events.length === 1 && events[0].pitch === note.pitch && events[0].startTick === note.startTick && events[0].durationTicks === note.durationTicks)) {
            item.ghost = events;
          }
        }
        items.push(item);
      }
    }
    return items;
  }

  // ---- rAF loop ----
  function frame() {
    applyPendingCenter();
    const doc = store.getDoc();
    const ui = uiStore.state;
    const playing = engine.isPlaying();
    const playheadTick = playing ? engine.getPlayheadTick() : store.session.cursorTick;

    if (playing) {
      dirty.overlay = true;
      dirty.ruler = true;
      dirty.auto = true;
      if (!wasPlaying) follow = true; // a fresh start always re-engages
      if (follow) {
        const before = ui.scrollTick;
        ui.scrollTick = followScroll(ui, playheadTick, W);
        clampScroll(ui, W, H, songEndTick(doc));
        // While the clamp is holding the scroll still - the first third, and
        // the last page - nothing behind the playhead moved, so only the
        // overlay needs repainting.
        if (ui.scrollTick !== before) markAll();
      }
    }
    wasPlaying = playing;

    if (dirty.grid) {
      drawGrid(ctxs.grid, ui, doc, W, H, theme, effectiveSnap(ui));
      dirty.grid = false;
    }
    if (dirty.notes) {
      drawNotes(ctxs.notes, ui, doc, W, H, theme, visibleItems(), ui.selection, conflicts.ids());
      dirty.notes = false;
    }
    if (dirty.overlay) {
      drawOverlay(ctxs.overlay, ui, doc, W, H, theme, {
        playheadTick,
        originTick: store.session.originTick,
        playing,
        loop: (() => { const l = store.getLoop(); return l && l.enabled ? l : null; })(),
        gridCursor: ui.gridCursor,
        snapTicks: effectiveSnap(ui),
        marquee: ui.marquee,
        dragPreview: ui.dragPreview,
      });
      dirty.overlay = false;
    }
    if (dirty.ruler) {
      drawRuler(ctxs.ruler, ui, doc, canvases.ruler.clientWidth, canvases.ruler.clientHeight, theme, {
        playheadTick,
        originTick: store.session.originTick,
        loop: (() => { const l = store.getLoop(); return l && l.enabled ? l : null; })(),
        conflictTicks: conflicts.ticks(),
      });
      dirty.ruler = false;
    }
    if (dirty.keys) {
      drawKeys(ctxs.keys, ui, doc, canvases.keys.clientWidth, canvases.keys.clientHeight, theme);
      dirty.keys = false;
    }
    if (dirty.chords) {
      drawChordLane(ctxs.chords, ui, doc, canvases.chords.clientWidth, canvases.chords.clientHeight, theme, chordEvents());
      dirty.chords = false;
    }
    if (dirty.auto) {
      autoLane.draw(ctxs.auto, canvases.auto.clientWidth, canvases.auto.clientHeight, theme, playheadTick, playing);
      dirty.auto = false;
    }
    updateScrollbars();
    requestAnimationFrame(frame);
  }

  // ---- scrollbars ----
  const hbar = document.getElementById('hscroll');
  const vbar = document.getElementById('vscroll');

  function updateScrollbars() {
    const ui = uiStore.state;
    const doc = store.getDoc();
    const total = Math.max(songEndTick(doc) + 16 * doc.ppq, W / ui.pxPerTick + 1);
    const hThumb = hbar.firstElementChild;
    const frac = W / ui.pxPerTick / total;
    hThumb.style.width = Math.max(6, frac * 100) + '%';
    hThumb.style.left = Math.min(100, (ui.scrollTick / total) * 100) + '%';

    const totalRows = PITCH_MAX - PITCH_MIN + 1;
    const visRows = H / ui.rowHeight;
    const vThumb = vbar.firstElementChild;
    vThumb.style.height = Math.max(6, (visRows / totalRows) * 100) + '%';
    vThumb.style.top = Math.max(0, ((PITCH_MAX - ui.scrollPitch) / totalRows) * 100) + '%';
  }

  function dragScrollbar(bar, horizontal) {
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const ui = uiStore.state;
      const doc = store.getDoc();
      const rect = bar.getBoundingClientRect();
      const move = (ev) => {
        if (horizontal) {
          stopFollowing();
          const total = Math.max(songEndTick(doc) + 16 * doc.ppq, W / ui.pxPerTick + 1);
          const frac = (ev.clientX - rect.left) / rect.width;
          uiStore.update('view', (s) => {
            s.scrollTick = frac * total - W / ui.pxPerTick / 2;
            clampScroll(s, W, H, songEndTick(doc));
          });
        } else {
          const totalRows = PITCH_MAX - PITCH_MIN + 1;
          const frac = (ev.clientY - rect.top) / rect.height;
          uiStore.update('view', (s) => {
            s.scrollPitch = PITCH_MAX - frac * totalRows + (H / s.rowHeight) / 2;
            clampScroll(s, W, H, songEndTick(doc));
          });
        }
      };
      move(e);
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }
  dragScrollbar(hbar, true);
  dragScrollbar(vbar, false);

  // ---- wheel: scroll + zoom ----
  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const ui = uiStore.state;
      const doc = store.getDoc();
      if (e.ctrlKey) {
        const rect = canvases.overlay.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const tickAtMouse = ui.scrollTick + mx / ui.pxPerTick;
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        uiStore.update('view', (s) => {
          s.pxPerTick = Math.min(8, Math.max(0.04, s.pxPerTick * factor));
          s.scrollTick = tickAtMouse - mx / s.pxPerTick;
          clampScroll(s, W, H, songEndTick(doc));
        });
      } else if (e.shiftKey) {
        // Shift+wheel: vertical. Browsers may report the delta as deltaX when
        // shift is held, so accept either axis.
        uiStore.update('view', (s) => {
          s.scrollPitch += (e.deltaY || e.deltaX) > 0 ? -2 : 2;
          clampScroll(s, W, H, songEndTick(doc));
        });
      } else {
        // plain wheel: horizontal (time axis). Zoom above deliberately does not
        // stand following down - it changes how much you see, not where you
        // are looking, and it re-anchors on the next frame anyway.
        stopFollowing();
        uiStore.update('view', (s) => {
          s.scrollTick += ((e.deltaY + e.deltaX) * 1.2) / s.pxPerTick / 2;
          clampScroll(s, W, H, songEndTick(doc));
        });
      }
    },
    { passive: false }
  );

  // middle-drag pan
  viewport.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const ui = uiStore.state;
    const doc = store.getDoc();
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev) => {
      stopFollowing();
      uiStore.update('view', (s) => {
        s.scrollTick -= (ev.clientX - lastX) / s.pxPerTick;
        s.scrollPitch += Math.round((ev.clientY - lastY) / s.rowHeight);
        clampScroll(s, W, H, songEndTick(doc));
      });
      lastX = ev.clientX;
      lastY = ev.clientY;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  void ctxs;

  // ---- subscriptions ----
  store.subscribe(['notes', 'tracks', 'harmonics'], () => markDirty('notes', 'ruler'));
  store.subscribe(['automation', 'tracks', 'doc'], () => markDirty('auto'));
  uiStore.subscribe(['autolane'], () => markDirty('auto'));
  store.subscribe(['loop'], () => markDirty('overlay', 'ruler'));
  store.subscribe(['song', 'doc'], () => markAll());
  uiStore.subscribe(['view'], () => markAll());
  uiStore.subscribe(['selection', 'cursor'], () => markDirty('notes', 'overlay'));
  uiStore.subscribe(['overlay'], () => markDirty('overlay'));
  uiStore.subscribe(['transport'], () => markDirty('overlay', 'ruler'));

  // Centring may be requested before the editor screen has laid out (H = 0),
  // so it is applied on the first frame that has a real height.
  let pendingCenterPitch = null;
  // Mirror the viewport into the document so it travels with the project.
  // Throttled and non-undoable: scrolling is not an edit, and it must not
  // push undo snapshots or trigger a save on its own - it rides along with
  // whatever save happens next (or the flush on tab-hide).
  let viewTimer = null;
  function rememberView() {
    if (viewTimer) return;
    viewTimer = setTimeout(() => {
      viewTimer = null;
      const st = uiStore.state;
      store.setView({
        scrollTick: st.scrollTick,
        scrollPitch: st.scrollPitch,
        pxPerTick: st.pxPerTick,
        cursorTick: store.session.originTick,
        cursorPitch: st.gridCursor.pitch,
      });
    }, 300);
  }
  uiStore.subscribe(['view', 'cursor', 'transport'], rememberView);

  function applyPendingCenter() {
    if (pendingCenterPitch == null || H <= 0) return;
    const pitch = pendingCenterPitch;
    pendingCenterPitch = null;
    uiStore.update('view', (s) => {
      s.scrollPitch = Math.round(pitch + H / s.rowHeight / 2);
      clampScroll(s, W, H, songEndTick(store.getDoc()));
    });
  }

  const api = {
    markDirty,
    markAll,
    getSize: () => ({ W, H }),
    // Put `pitch` in the vertical middle of the roll.
    centerOnPitch(pitch) {
      if (pitch == null) return;
      pendingCenterPitch = pitch;
      applyPendingCenter();
    },
    // Put the viewport back where the project was left. Beats centerOnPitch,
    // which is only the fallback for a project that has never been viewed.
    restoreView(view) {
      if (!view) return false;
      pendingCenterPitch = null;
      uiStore.update('view', (st) => {
        st.scrollTick = view.scrollTick ?? st.scrollTick;
        st.scrollPitch = view.scrollPitch ?? st.scrollPitch;
        st.pxPerTick = view.pxPerTick ?? st.pxPerTick;
      });
      uiStore.update('cursor', (st) => {
        st.gridCursor.tick = view.cursorTick ?? st.gridCursor.tick;
        st.gridCursor.pitch = view.cursorPitch ?? st.gridCursor.pitch;
      });
      store.session.cursorTick = view.cursorTick ?? 0;
      store.session.originTick = view.cursorTick ?? 0;
      return true;
    },
    // Keep a tick visible (used by keyboard nav + conflict jump).
    scrollTickIntoView(tick) {
      const ui = uiStore.state;
      const x = tickToX(ui, tick);
      if (x < 0 || x > W - 40) {
        uiStore.update('view', (s) => {
          s.scrollTick = Math.max(0, tick - W / s.pxPerTick / 3);
          clampScroll(s, W, H, songEndTick(store.getDoc()));
        });
      }
    },
    scrollPitchIntoView(pitch) {
      const ui = uiStore.state;
      const visRows = H / ui.rowHeight;
      if (pitch > ui.scrollPitch - 1 || pitch < ui.scrollPitch - visRows + 1) {
        uiStore.update('view', (s) => {
          s.scrollPitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN + Math.floor(visRows) - 1, pitch + Math.floor(visRows / 2)));
          clampScroll(s, W, H, songEndTick(store.getDoc()));
        });
      }
    },
  };

  api.interactions = attachInteractions({ store, uiStore, engine, canvases, roll: api });
  const autoLane = initAutomationLane({ store, uiStore, canvas: canvases.auto });

  resizeAll();
  requestAnimationFrame(frame);
  return api;
}
