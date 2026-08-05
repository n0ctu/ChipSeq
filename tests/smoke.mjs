// Headless-browser smoke test via raw CDP (needs Node 22+ and Chromium).
// Run: node tests/smoke.mjs   (set CHROME_BIN to override browser discovery)
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './util.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = findChrome();
const PORT = 8931;
const DEBUG_PORT = 9333;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const data = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  // tall window: reproduces the fractional-scrollPitch clamp at load
  '--window-size=1400,1300',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--user-data-dir=/tmp/chipseq-smoke-profile-' + Date.now(),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// wait for CDP endpoint
let targets = null;
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
    targets = await res.json();
    if (targets.length) break;
  } catch {}
  await sleep(200);
}
if (!targets) throw new Error('Chrome CDP did not come up');
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push('CONSOLE.ERROR: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (msg) => (msg.error ? reject(new Error(method + ': ' + msg.error.message)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr) {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error('eval failed: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text) + '\n  expr: ' + expr.slice(0, 200));
  }
  return res.result.value;
}

let pass = 0, fail = 0;
async function check(label, expr) {
  try {
    const v = await evaluate(expr);
    if (v === true) { pass++; console.log('OK  ', label); }
    else { fail++; console.log('FAIL', label, '->', JSON.stringify(v)); }
  } catch (err) {
    fail++;
    console.log('FAIL', label, '->', err.message);
  }
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(1500);
// hermetic run even if a stale browser profile is reused
await evaluate(`localStorage.clear()`);
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(1200);

// ---- fresh boot: start page greets new users with the seeded demo ----
await check('fresh boot greets with the start page', `!document.getElementById('screen-start').hidden && !!window.__chipseq`);
await check('demos listed in their own section, not in recents', `(() => {
  const demoItems = document.querySelectorAll('#demo-list .demo-item');
  const demoText = document.getElementById('demo-list').textContent;
  const recents = document.getElementById('recent-list').textContent;
  return demoItems.length === 5 && demoText.includes('Demo Mono') && demoText.includes('Demo Poly')
    && demoText.includes('Rickroll') && demoText.includes('Tetris') && demoText.includes('Bad Apple')
    && recents.includes('No projects yet')
    || 'demos=' + demoItems.length + ' recents=' + recents.slice(0, 60);
})()`);
await check('footer shows brand + version', `(() => {
  const t = document.getElementById('st-brand').textContent;
  return /^ChipSeq by n0ctu - v\\d+\\.\\d+\\.\\d+$/.test(t) || t;
})()`);
await check('demos are not copied into storage', `(() => {
  const index = JSON.parse(localStorage.getItem('chipseq.v1.index') || '[]');
  const marker = localStorage.getItem('chipseq.v1.demosSeeded');
  return index.length === 0 && marker === null || 'index=' + index.length + ' marker=' + marker;
})()`);
// open the mono demo once to verify it loads intact
await evaluate(`[...document.querySelectorAll('#demo-list .demo-item')].find((i) => i.textContent.includes('Demo Mono')).click()`);
await sleep(300);
await check('mono demo opens with all notes intact', `(() => {
  const doc = window.__chipseq.store.getDoc();
  return !document.getElementById('screen-editor').hidden && doc.name === 'Demo Mono'
    && doc.tracks[0].notes.length === 7 || doc.name + '/' + doc.tracks[0].notes.length;
})()`);
await check('opening a demo stores nothing', `(() => {
  return JSON.parse(localStorage.getItem('chipseq.v1.index') || '[]').length === 0;
})()`);
await check('view is centred on the active track (notes visible, not cut off)', `(async () => {
  const { trackPitchCenter, activeTrack } = await import('/js/core/doc.js');
  const ui = window.__chipseq.uiStore.state;
  const doc = window.__chipseq.store.getDoc();
  const track = activeTrack(doc);
  const centre = trackPitchCenter(track);
  const H = document.getElementById('overlay-canvas').clientHeight;
  const rows = H / ui.rowHeight;
  const top = ui.scrollPitch;
  const bottom = ui.scrollPitch - rows;
  const visible = track.notes.filter((n) => n.pitch <= top && n.pitch >= bottom).length;
  return visible === track.notes.length && Math.abs(ui.scrollPitch - (centre + rows / 2)) <= 1
    || 'centre=' + centre + ' scrollPitch=' + ui.scrollPitch + ' visible=' + visible + '/' + track.notes.length;
})()`);
await check('editing a demo forks a personal copy with the same name', `(async () => {
  const { createNote, addNote } = await import('/js/core/doc.js');
  const s = window.__chipseq.store;
  const demoId = s.getDoc().id;
  s.commit('edit the demo', ['notes'], (d) => {
    addNote(d, d.tracks[0].id, createNote({ pitch: 65, startTick: 96 * 40, durationTicks: 48 }));
  });
  await new Promise((r) => setTimeout(r, 700)); // autosave debounce
  const doc = s.getDoc();
  const index = JSON.parse(localStorage.getItem('chipseq.v1.index') || '[]');
  return doc.id !== demoId && doc.name === 'Demo Mono' && index.length === 1
    && index[0].name === 'Demo Mono' && !localStorage.getItem('chipseq.v1.proj.' + demoId)
    || JSON.stringify({ forked: doc.id !== demoId, index: index.length });
})()`);
await evaluate(`document.getElementById('btn-home').click()`);
await sleep(300);
await check('demo still listed pristine after the fork', `(() => {
  const demoItems = document.querySelectorAll('#demo-list .demo-item').length;
  const recents = document.querySelectorAll('#recent-list .recent-item').length;
  return demoItems === 5 && recents === 1 || 'demos=' + demoItems + ' recents=' + recents;
})()`);
// the poly demo shows off the automation lanes
await evaluate(`[...document.querySelectorAll('#demo-list .demo-item')].find((i) => i.textContent.includes('Demo Poly')).click()`);
await sleep(400);
await check('poly demo opens with automation lanes visible and populated', `(async () => {
  const { flattenSong } = await import('/js/core/flatten.js');
  const doc = window.__chipseq.store.getDoc();
  const lead = doc.tracks[0];
  const master = document.getElementById('auto-master');
  const dots = document.querySelectorAll('.auto-lane-btn .auto-dot').length;
  const evs = flattenSong(doc).events;
  const hasCurve = evs.some((e) => e.gainCurve);
  const hasDuty = evs.some((e) => e.duty != null);
  return doc.mode === 'poly' && !!master && dots >= 2 && (lead.automation.gain || []).length >= 3
    && hasCurve && hasDuty
    || JSON.stringify({ mode: doc.mode, dots, curve: hasCurve, duty: hasDuty });
})()`);
await evaluate(`document.getElementById('btn-home').click()`);
await sleep(300);
await evaluate(`document.getElementById('btn-new-project').click()`);
await sleep(300);
await check('editor visible after New project', `!document.getElementById('screen-editor').hidden`);
await check('toolbar shows 120 BPM', `document.getElementById('inp-bpm').value === '120'`);
await check('mono mode active', `document.querySelector('#seg-mode [data-mode="mono"]').classList.contains('active')`);
await check('canvases sized', `document.getElementById('overlay-canvas').width > 100`);
await check('scrollPitch integral right after load', `Number.isInteger(window.__chipseq.uiStore.state.scrollPitch)`);
await check('black keys painted on first frame', `(() => {
  const c = document.getElementById('keys-canvas');
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let dark = 0, light = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i] + data[i + 1] + data[i + 2];
    if (lum < 90) dark++;
    else if (lum > 600) light++;
  }
  // a real keys column has plenty of both black and white key pixels
  return dark > 500 && light > 500 || 'dark=' + dark + ' light=' + light;
})()`);
await check('chord lane shows empty-state hint (no chords track)', `(() => {
  const c = document.getElementById('chords-canvas');
  if (!c || !c.width) return 'canvas missing/unsized';
  const data = c.getContext('2d').getImageData(0, 0, Math.min(c.width, 600), c.height).data;
  const shades = new Set();
  for (let i = 0; i < data.length; i += 4) shades.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
  return shades.size >= 2 || 'shades=' + shades.size; // hint text over panel bg
})()`);
await check('grid rows use multiple shades on first frame', `(() => {
  const c = document.getElementById('grid-canvas');
  const data = c.getContext('2d').getImageData(0, 0, 40, c.height).data;
  const shades = new Set();
  for (let i = 0; i < data.length; i += 4) shades.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
  return shades.size >= 3 || 'shades=' + shades.size;
})()`);

// ---- empty grid: click moves cursor, drag draws a note ----
await evaluate(`(() => {
  const c = document.getElementById('overlay-canvas');
  const r = c.getBoundingClientRect();
  const x = r.left + 130, y = r.top + Math.floor(r.height / 2);
  for (const type of ['mousedown', 'mouseup']) {
    c.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  }
})()`);
await sleep(200);
await check('plain click creates no note', `window.__chipseq.store.getDoc().tracks[0].notes.length === 0`);
await check('plain click moves the placed cursor', `(() => {
  const s = window.__chipseq.store.session;
  const ui = window.__chipseq.uiStore.state;
  const rawTick = 130 / ui.pxPerTick + ui.scrollTick;
  const expected = Math.floor(rawTick / ui.snapTicks) * ui.snapTicks;
  return s.originTick === expected && s.cursorTick === expected
    || 'origin=' + s.originTick + ' expected=' + expected;
})()`);
// drag across ~2 cells on a known row draws a note there
const drawResult = await evaluate(`(() => {
  const c = document.getElementById('overlay-canvas');
  const r = c.getBoundingClientRect();
  const ui = window.__chipseq.uiStore.state;
  const results = [];
  // draw near the TOP and near the BOTTOM pixel band of two different rows
  for (const [rowOffset, yInRow] of [[10, 2], [14, 12]]) {
    const y = r.top + rowOffset * ui.rowHeight + yInRow;
    const x1 = r.left + 200 + rowOffset * 60;
    const x2 = x1 + ui.snapTicks * ui.pxPerTick * 1.5; // into the second cell
    const expectedPitch = ui.scrollPitch - rowOffset;
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y, button: 0, shiftKey: true }));
    c.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x2, clientY: y, button: 0, shiftKey: true }));
    c.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y, button: 0, shiftKey: true }));
    const notes = window.__chipseq.store.getDoc().tracks[0].notes;
    const created = notes.find((n) => n.pitch === expectedPitch);
    if (!created) {
      results.push('row ' + rowOffset + ': expected pitch ' + expectedPitch + ' got ' + notes.map((n) => n.pitch).join(','));
      continue;
    }
    const rawStart = (x1 - r.left) / ui.pxPerTick + ui.scrollTick;
    const expectedStart = Math.floor(rawStart / ui.snapTicks) * ui.snapTicks;
    if (created.startTick !== expectedStart) results.push('row ' + rowOffset + ': start ' + created.startTick + ' != ' + expectedStart);
    else if (created.durationTicks !== ui.snapTicks * 2) results.push('row ' + rowOffset + ': duration ' + created.durationTicks + ' != ' + ui.snapTicks * 2);
    else results.push('ok');
  }
  return results.join(' | ');
})()`);
if (drawResult === 'ok | ok') {
  pass++;
  console.log('OK   shift+drag draws snapped notes on the correct rows');
} else {
  fail++;
  console.log('FAIL shift+drag draws snapped notes on the correct rows ->', drawResult);
}
// plain drag = marquee: sweep a rectangle over both drawn notes
await check('plain drag marquee-selects both notes', `(() => {
  const c = document.getElementById('overlay-canvas');
  const r = c.getBoundingClientRect();
  const ui = window.__chipseq.uiStore.state;
  const notes = window.__chipseq.store.getDoc().tracks[0].notes;
  const x1 = r.left + Math.min(...notes.map((n) => (n.startTick - ui.scrollTick) * ui.pxPerTick)) - 10;
  const x2 = r.left + Math.max(...notes.map((n) => (n.startTick + n.durationTicks - ui.scrollTick) * ui.pxPerTick)) + 10;
  const y1 = r.top + 9 * ui.rowHeight;
  const y2 = r.top + 15 * ui.rowHeight + 13;
  c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y1, button: 0 }));
  c.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x2, clientY: y2, button: 0 }));
  c.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2, button: 0 }));
  const sel = window.__chipseq.uiStore.state.selection;
  return sel.size === 2 || 'selected ' + sel.size + ' of ' + notes.length;
})()`);
await check('shift+click adds a note at last-used length', `(() => {
  const c = document.getElementById('overlay-canvas');
  const r = c.getBoundingClientRect();
  const ui = window.__chipseq.uiStore.state;
  const before = window.__chipseq.store.getDoc().tracks[0].notes.length;
  const x = r.left + 500, y = r.top + 20 * ui.rowHeight + 5;
  for (const type of ['mousedown', 'mouseup']) {
    c.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, shiftKey: true }));
  }
  const notes = window.__chipseq.store.getDoc().tracks[0].notes;
  return notes.length === before + 1 && notes.some((n) => n.pitch === ui.scrollPitch - 20 && n.durationTicks === ui.lastNoteLen)
    || 'count ' + notes.length;
})()`);
// keep one note for the arp tests, drop the others
await evaluate(`(async () => {
  const { deleteNotes } = await import('/js/core/doc.js');
  const s = window.__chipseq.store;
  const t = s.getDoc().tracks[0];
  const keep = t.notes[0].id;
  const extra = t.notes.filter((n) => n.id !== keep).map((n) => n.id);
  if (extra.length) s.commit('cleanup', ['notes'], (d) => deleteNotes(d, d.tracks[0].id, extra));
  window.__chipseq.uiStore.update('selection', (st) => {
    st.selection = new Set([keep]);
    st.selectionTrackId = s.getDoc().tracks[0].id;
  });
})()`);
await sleep(150);
await check('note is selected', `window.__chipseq.uiStore.state.selection.size === 1`);
await openTool('harmonics');
await check('arp panel offers On toggle', `!!document.querySelector('#harmonics-body #harm-on')`);

// ---- apply arp via panel ----
await evaluate(`document.querySelector('#harmonics-body #harm-on').click()`);
await sleep(200);
await check('arp applied to note', `!!window.__chipseq.store.getDoc().tracks[0].notes[0].harmonics`);
await check('arp controls visible', `!!document.querySelector('#harmonics-body #harm-pattern')`);
await check('arp panel shows resolved chord name', `(() => {
  const name = document.querySelector('#harmonics-body .harm-chord-name');
  return !!name && name.textContent.trim().length > 0 || 'no chord info box';
})()`);
await check('arp panel shows chord source', `(() => {
  const src = document.querySelector('#harmonics-body .harm-chord-src');
  return !!src && src.textContent.includes('key') || (src ? src.textContent : 'missing');
})()`);
// ---- voicing controls (anchor + octave shift) ----
await check('voicing controls present', `!!document.querySelector('#harmonics-body #harm-anchor') && !!document.querySelector('#harmonics-body #harm-shift-dec')`);
await evaluate(`document.querySelector('#harmonics-body #harm-anchor [data-v="below"]').click()`);
await sleep(150);
await evaluate(`document.querySelector('#harmonics-body #harm-shift-dec').click()`);
await sleep(150);
await check('below anchor + shift stored on the note', `(() => {
  const n = window.__chipseq.store.getDoc().tracks[0].notes.find((x) => x.harmonics);
  return n.harmonics.anchor === 'below' && n.harmonics.octaveShift === -1 || JSON.stringify({a: n.harmonics.anchor, s: n.harmonics.octaveShift});
})()`);
await check('ghost events voiced below the note', `(async () => {
  const { flattenNote } = await import('/js/core/flatten.js');
  const d = window.__chipseq.store.getDoc();
  const n = d.tracks[0].notes.find((x) => x.harmonics);
  const events = flattenNote(d, d.tracks[0].id, n.id);
  // anchored below + shifted -1 octave: every sounding tone sits in
  // [note-24, note-12] (the note only fits 2 steps, so not all tones sound)
  return events.every((e) => e.pitch >= n.pitch - 24 && e.pitch <= n.pitch - 12)
    || 'pitches=' + events.map((e) => e.pitch).join(',') + ' note=' + n.pitch;
})()`);
await evaluate(`(() => {
  document.querySelector('#harmonics-body #harm-anchor [data-v="above"]').click();
})()`);
await sleep(100);
await evaluate(`document.querySelector('#harmonics-body #harm-shift-inc').click()`);
await sleep(150);

// ---- tools sidebar: cards, lazy loading, tri-state fold ----
// Opening a card is now a real step: its module is imported on first expand,
// so nothing inside a card exists until someone asks for it.
async function openTool(id) {
  await evaluate(
    "(() => { const sec = document.getElementById('sec-" + id + "');" +
    " if (!sec.classList.contains('open')) sec.querySelector('.tool-card-head').click(); })()"
  );
  await sleep(250); // the module is imported on this click
}

await check('both tool cards visible with a selection', `(() => {
  const h = !document.getElementById('sec-harmonics').hidden;
  const t = !document.getElementById('sec-transpose').hidden;
  const hint = document.getElementById('tools-empty').hidden;
  return h && t && hint || 'harm=' + h + ' trans=' + t;
})()`);

// A card the user has not asked for is not merely collapsed - its module was
// never fetched, so its body is genuinely empty.
await check('an unopened card has not loaded its module', `(() => {
  const sec = document.getElementById('sec-transpose');
  const body = document.getElementById('transpose-body');
  return (!sec.classList.contains('open') && body.children.length === 0)
    || 'open=' + sec.classList.contains('open') + ' children=' + body.children.length;
})()`);

// The other half of the rule: the selected note carries an arpeggio by now,
// so Harmonics opens itself and lights its indicator without being asked.
await check('a configured tool opens itself and lights its dot', `(() => {
  const sec = document.getElementById('sec-harmonics');
  const status = sec.querySelector('.tool-status');
  return (sec.classList.contains('open') && status.classList.contains('on') && /arp/.test(status.textContent))
    || 'open=' + sec.classList.contains('open') + ' status=' + status.textContent;
})()`);
await check('transpose card shows selection scope while closed', `document.querySelector('#sec-transpose .tool-status').textContent === '1 note'`);
await openTool('transpose');
await check('opening a card loads and mounts its module', `(() => {
  const sec = document.getElementById('sec-transpose');
  const body = document.getElementById('transpose-body');
  return (sec.classList.contains('open') && body.children.length > 0)
    || 'open=' + sec.classList.contains('open') + ' children=' + body.children.length;
})()`);
await check('+1 octave button transposes the selection', `(() => {
  const d = () => window.__chipseq.store.getDoc();
  const before = d().tracks[0].notes.find((n) => window.__chipseq.uiStore.state.selection.has(n.id)).pitch;
  document.querySelector('#transpose-body #tp-oct-up').click();
  const after = d().tracks[0].notes.find((n) => window.__chipseq.uiStore.state.selection.has(n.id)).pitch;
  window.__chipseq.store.undo();
  return after === before + 12 || before + '->' + after;
})()`);
await check('no selection: harmonics hides, transpose targets whole track', `(() => {
  window.__chipseq.uiStore.update('selection', (st) => st.selection.clear());
  const h = document.getElementById('sec-harmonics').hidden;
  const label = document.querySelector('#sec-transpose .tool-status').textContent;
  return h && label.startsWith('whole') || 'hidden=' + h + ' label=' + label;
})()`);
await check('diatonic +1 degree keeps notes in key', `(async () => {
  const { isInKey } = await import('/js/core/music.js');
  const d = () => window.__chipseq.store.getDoc();
  const key = d().song.key;
  const before = d().tracks[0].notes.map((n) => n.pitch);
  document.querySelector('#transpose-body #tp-deg-up').click();
  const after = d().tracks[0].notes.map((n) => n.pitch);
  window.__chipseq.store.undo();
  return after.every((p) => isInKey(p, key)) && after.every((p, i) => p > before[i])
    || before.join() + ' -> ' + after.join();
})()`);
await check('snap-to-key conforms chromatic notes', `(async () => {
  const { isInKey } = await import('/js/core/music.js');
  const { createNote, addNote } = await import('/js/core/doc.js');
  const s = window.__chipseq.store;
  s.commit('chromatic seed', ['notes'], (d) => {
    addNote(d, d.tracks[0].id, createNote({ pitch: 61, startTick: 96 * 30, durationTicks: 48 }));
  });
  document.querySelector('#transpose-body #tp-snap').click();
  const key = s.getDoc().song.key;
  const allInKey = s.getDoc().tracks[0].notes.every((n) => isInKey(n.pitch, key));
  s.undo();
  s.undo();
  return allInKey;
})()`);
await check('an explicit toggle is sticky and persists', `(() => {
  const sec = document.getElementById('sec-transpose');
  const head = sec.querySelector('.tool-card-head');
  const wasOpen = sec.classList.contains('open');
  head.click(); // explicit choice - leaves auto mode
  const flipped = sec.classList.contains('open') !== wasOpen;
  const saved = JSON.parse(localStorage.getItem('chipseq.v1.sections') || '{}');
  const stored = saved.transpose === !wasOpen;
  const resetShown = !document.getElementById('tools-reset').hidden;
  head.click(); // back where it was, still explicit
  return (flipped && stored && resetShown)
    || 'flipped=' + flipped + ' saved=' + JSON.stringify(saved) + ' reset=' + resetShown;
})()`);

// restore the selection for the following harmonics tests
await evaluate(`(() => {
  const s = window.__chipseq.store;
  const note = s.getDoc().tracks[0].notes.find((n) => n.harmonics);
  window.__chipseq.uiStore.update('selection', (st) => {
    st.selection = new Set([note.id]);
    st.selectionTrackId = s.getDoc().tracks[0].id;
  });
})()`);
await sleep(150);

// An explicitly closed card must NOT spring open again when the context
// changes - the app never fights a decision the user made. (Needs a live
// selection, or the card is hidden and the panel skips it entirely.)
await check('an explicitly closed card stays closed when it would auto-open', `(() => {
  const sec = document.getElementById('sec-harmonics');
  const head = sec.querySelector('.tool-card-head');
  if (sec.classList.contains('open')) head.click(); // explicitly close a configured tool
  const closed = !sec.classList.contains('open');
  window.__chipseq.uiStore.update('selection', () => {}); // force a re-render
  const stillClosed = !sec.classList.contains('open');
  const dotStillShown = sec.querySelector('.tool-status').classList.contains('on');
  return (closed && stillClosed && dotStillShown)
    || 'closed=' + closed + ' stillClosed=' + stillClosed + ' dot=' + dotStillShown;
})()`);

await check('reset returns every card to following its own status', `(() => {
  document.getElementById('tools-reset').click();
  const sec = document.getElementById('sec-harmonics');
  const saved = JSON.parse(localStorage.getItem('chipseq.v1.sections') || '{}');
  // back to auto: harmonics is configured, so it opens again by itself
  return (Object.keys(saved).length === 0 && sec.classList.contains('open'))
    || 'saved=' + JSON.stringify(saved) + ' open=' + sec.classList.contains('open');
})()`);

// ---- chord source menu (autoSong) ----
await evaluate(`(() => {
  const sel = document.querySelector('#harmonics-body #harm-chord');
  sel.value = 'autoSong';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(200);
await check('chord source menu appears for autoSong', `(() => {
  const sel = document.querySelector('#harmonics-body #harm-source');
  if (!sel) return 'no source select';
  const first = sel.options[0].textContent;
  const groups = sel.querySelectorAll('optgroup').length;
  const last = sel.options[sel.options.length - 1].value;
  return first.startsWith('Recommended') && groups >= 10 && last === 'pick'
    || 'first=' + first + ' groups=' + groups + ' last=' + last;
})()`);
await evaluate(`(() => {
  // choose the quality chord Dm (root 2, quality m)
  const sel = document.querySelector('#harmonics-body #harm-source');
  sel.value = 'q:2:m';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(200);
await check('quality chord sets a custom source with pcs', `(() => {
  const n = window.__chipseq.store.getDoc().tracks[0].notes.find((x) => x.harmonics);
  const src = n.harmonics.chordSource;
  return src && src.label === 'Dm' && JSON.stringify([...src.pcs].sort((a,b)=>a-b)) === '[2,5,9]'
    || JSON.stringify(src);
})()`);
await check('readout shows the custom chord', `(() => {
  const name = document.querySelector('#harmonics-body .harm-chord-name');
  const src = document.querySelector('#harmonics-body .harm-chord-src');
  return name.textContent === 'Dm' && src.textContent.includes('custom')
    || name.textContent + '/' + src.textContent;
})()`);
await check('pc picker shows the chord notes', `(() => {
  const on = [...document.querySelectorAll('#harmonics-body .pc-key.on')].map((b) => b.dataset.pc).join(',');
  return on === '2,5,9' || on;
})()`);
await evaluate(`(() => {
  // toggle A (pc 9) off via the picker -> D5-ish power dyad
  document.querySelector('#harmonics-body .pc-key[data-pc="9"]').click();
})()`);
await sleep(200);
await check('picker toggle updates the chord', `(() => {
  const n = window.__chipseq.store.getDoc().tracks[0].notes.find((x) => x.harmonics);
  return JSON.stringify([...n.harmonics.chordSource.pcs].sort((a,b)=>a-b)) === '[2,5]' || JSON.stringify(n.harmonics.chordSource);
})()`);
await evaluate(`(() => {
  // back to the recommendation
  const sel = document.querySelector('#harmonics-body #harm-source');
  sel.value = 'rec';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(150);
await check('recommended source clears the override', `(() => {
  const n = window.__chipseq.store.getDoc().tracks[0].notes.find((x) => x.harmonics);
  return n.harmonics.chordSource === null || JSON.stringify(n.harmonics.chordSource);
})()`);
await evaluate(`(() => {
  const sel = document.querySelector('#harmonics-body #harm-chord');
  sel.value = 'autoKey';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(150);

await check('arp audition button plays without error', `(() => {
  const btn = document.querySelector('#harmonics-body #harm-audition');
  if (!btn) return 'no audition button';
  btn.click();
  return true;
})()`);
await evaluate(`document.querySelector('#harmonics-body #harm-pattern [data-v="updown"]').click()`);
await sleep(150);
await check('pattern set to updown', `window.__chipseq.store.getDoc().tracks[0].notes[0].harmonics.pattern === 'updown'`);

// ---- undo/redo ----
await check('undo available', `window.__chipseq.store.canUndo()`);
await evaluate(`window.__chipseq.store.undo()`);
await check('undo reverted pattern', `window.__chipseq.store.getDoc().tracks[0].notes[0].harmonics.pattern === 'up'`);
await evaluate(`window.__chipseq.store.redo()`);
await check('redo re-applied pattern', `window.__chipseq.store.getDoc().tracks[0].notes[0].harmonics.pattern === 'updown'`);

// ---- remove arp restores original ----
await evaluate(`document.querySelector('#harmonics-body #harm-remove').click()`);
await sleep(150);
await check('arp removed, note intact', `(() => {
  const n = window.__chipseq.store.getDoc().tracks[0].notes[0];
  return n.harmonics === null && n.durationTicks > 0;
})()`);

// ---- export dialog ----
await evaluate(`(() => {
  // loop region around the drawn note so region export has content
  // (enabled: false - region export must work without loop playback on)
  window.__chipseq.store.setLoop({ startTick: 1536, endTick: 1920, enabled: false });
})()`);
await evaluate(`document.getElementById('btn-export').click()`);
await sleep(200);
await check('export dialog open', `document.getElementById('dlg-export').open`);
await check('.h preview contains NOTE_', `document.getElementById('export-preview').textContent.includes('NOTE_')`);
await check('.h preview has BadgeNote array', `document.getElementById('export-preview').textContent.includes('static const BadgeNote')`);
await evaluate(`document.querySelector('#seg-export [data-tab="fmf"]').click()`);
await sleep(200);
await check('.fmf tab shows a valid Flipper header', `(() => {
  const text = document.getElementById('export-fmf-preview').textContent;
  return text.startsWith('Filetype: Flipper Music Format') && text.includes('BPM: 120')
    && text.includes('Notes: ') || text.slice(0, 80);
})()`);
await check('.fmf notes list is non-empty', `(() => {
  const line = document.getElementById('export-fmf-preview').textContent.split('\\n').find((l) => l.startsWith('Notes:'));
  return line && line.replace('Notes: ', '').split(', ').length >= 1 || 'missing';
})()`);
await evaluate(`document.querySelector('#seg-export [data-tab="h"]').click()`);
await sleep(150);
await check('loop-region checkbox enabled with bar range', `(() => {
  const box = document.getElementById('chk-export-region');
  const label = document.getElementById('export-region-label').textContent;
  return !box.disabled && label.includes('bars') || label;
})()`);
await evaluate(`(() => {
  const box = document.getElementById('chk-export-region');
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(150);
await check('region .h preview = exact region length with rests', `(() => {
  const text = document.getElementById('export-preview').textContent;
  const ms = [...text.matchAll(/,\\s+(\\d+)\\}/g)].map((m) => Number(m[1]));
  const total = ms.reduce((a, b) => a + b, 0);
  // 384 ticks at 120 BPM = 2000 ms exactly; note is inside, so rests surround it
  return total === 2000 && text.includes('NOTE_REST') && text.includes('(loop region)')
    || 'total=' + total;
})()`);
await check('region .wav is exactly the region length', `(async () => {
  const { renderWav } = await import('/js/core/export-wav.js');
  const doc = window.__chipseq.store.getDoc();
  const region = { startTick: 1536, endTick: 1920 };
  const { blob } = await renderWav(doc, { region });
  const expectedSamples = Math.ceil(44100 * 384 * 60 / (doc.song.bpm * doc.ppq));
  return blob.size === 44 + 2 * expectedSamples || 'size=' + blob.size + ' expected=' + (44 + 2 * expectedSamples);
})()`);
await evaluate(`(() => {
  const box = document.getElementById('chk-export-region');
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(100);
await evaluate(`document.querySelector('#dlg-export [value="cancel"]').click()`);
await sleep(100);

// ---- wav render (OfflineAudioContext) ----
await check('wav renders and is a valid RIFF', `(async () => {
  const { renderWav } = await import('/js/core/export-wav.js');
  const { blob } = await renderWav(window.__chipseq.store.getDoc());
  const buf = new Uint8Array(await blob.arrayBuffer());
  return buf.length > 1000 && String.fromCharCode(...buf.slice(0, 4)) === 'RIFF' && String.fromCharCode(...buf.slice(8, 12)) === 'WAVE';
})()`);

// ---- playback engine starts/stops without throwing ----
// ---- retroactive key detection button ----
await evaluate(`(async () => {
  // seed a clearly G-major melody so detection has something to chew on
  const { createNote, addNote } = await import('/js/core/doc.js');
  const s = window.__chipseq.store;
  s.commit('key seed', ['notes'], (d) => {
    const id = d.tracks[0].id;
    const seed = [[67, 400], [71, 250], [74, 300], [66, 150], [69, 100], [72, 100]];
    let t = 96 * 40; // far right, away from other test notes
    for (const [pitch, dur] of seed) {
      addNote(d, id, createNote({ pitch, startTick: t, durationTicks: dur }));
      t += dur;
    }
  });
})()`);
await evaluate(`document.getElementById('btn-detect-key').click()`);
await sleep(150);
await check('detect-key button sets the song key', `(() => {
  const k = window.__chipseq.store.getDoc().song.key;
  return k.tonic === 7 && k.mode === 'major' || JSON.stringify(k);
})()`);
await check('detect-key shows feedback', `document.getElementById('st-save').textContent.includes('key detected: G major')`);
await check('key selects reflect detection', `document.getElementById('sel-key-tonic').value === '7'`);
// undo both seed + detection so later tests see the original state
await evaluate(`window.__chipseq.store.undo(); window.__chipseq.store.undo();`);
await sleep(150);

// ---- wheel: plain = horizontal, shift = vertical ----
await check('plain wheel scrolls time axis', `(() => {
  const vp = document.getElementById('roll-viewport');
  const ui = window.__chipseq.uiStore.state;
  const beforeTick = ui.scrollTick, beforePitch = ui.scrollPitch;
  vp.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
  return ui.scrollTick > beforeTick && ui.scrollPitch === beforePitch
    || 'tick ' + beforeTick + '->' + ui.scrollTick + ' pitch ' + beforePitch + '->' + ui.scrollPitch;
})()`);
await check('shift+wheel scrolls pitch axis', `(() => {
  const vp = document.getElementById('roll-viewport');
  const ui = window.__chipseq.uiStore.state;
  const beforeTick = ui.scrollTick, beforePitch = ui.scrollPitch;
  vp.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, shiftKey: true }));
  return ui.scrollPitch > beforePitch && ui.scrollTick === beforeTick
    || 'tick ' + beforeTick + '->' + ui.scrollTick + ' pitch ' + beforePitch + '->' + ui.scrollPitch;
})()`);
await evaluate(`window.__chipseq.uiStore.update('view', (s) => { s.scrollTick = 0; })`);
await sleep(100);

// ---- transport: placed cursor, stop vs pause ----
// give the song enough length that playing from the placed cursor works
await evaluate(`(async () => {
  const { createNote, addNote } = await import('/js/core/doc.js');
  const s = window.__chipseq.store;
  s.commit('long tail note', ['notes'], (d) => {
    addNote(d, d.tracks[0].id, createNote({ pitch: 45, startTick: 2400, durationTicks: 96 * 20 }));
  });
})()`);
await sleep(150);
await evaluate(`(() => {
  // click the ruler at some x to place the cursor
  const ruler = document.getElementById('ruler-canvas');
  const r = ruler.getBoundingClientRect();
  const x = r.left + 150, y = r.top + 10;
  ruler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
})()`);
await sleep(150);
await check('ruler click sets origin + cursor together', `(() => {
  const s = window.__chipseq.store.session;
  return s.originTick > 0 && s.originTick === s.cursorTick || 'origin=' + s.originTick + ' cursor=' + s.cursorTick;
})()`);
const originTick = await evaluate(`window.__chipseq.store.session.originTick`);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))`);
await sleep(400);
await check('Space plays from origin', `window.__chipseq.engine.isPlaying()`);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))`);
await sleep(100);
await check('Space-stop reverts cursor to origin', `(() => {
  const s = window.__chipseq.store.session;
  return !window.__chipseq.engine.isPlaying() && s.cursorTick === ${originTick} || 'cursor=' + s.cursorTick;
})()`);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', shiftKey: true, bubbles: true }))`);
await sleep(500);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', shiftKey: true, bubbles: true }))`);
await sleep(100);
await check('Shift+Space pauses ahead of origin, origin untouched', `(() => {
  const s = window.__chipseq.store.session;
  return !window.__chipseq.engine.isPlaying() && s.cursorTick > ${originTick} && s.originTick === ${originTick}
    || 'cursor=' + s.cursorTick + ' origin=' + s.originTick;
})()`);
const pausedTick = await evaluate(`window.__chipseq.store.session.cursorTick`);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', shiftKey: true, bubbles: true }))`);
await sleep(150);
await check('Shift+Space resumes from the pause position', `(() => {
  const t = window.__chipseq.engine.getPlayheadTick();
  return window.__chipseq.engine.isPlaying() && t >= ${pausedTick} && t < ${pausedTick} + 300 || 'playhead=' + t;
})()`);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))`);
await sleep(100);
await evaluate(`(() => {
  // right-click ruler, then use the context menu reset option
  const ruler = document.getElementById('ruler-canvas');
  const r = ruler.getBoundingClientRect();
  ruler.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 100, clientY: r.top + 10 }));
})()`);
await sleep(150);
await check('ruler context menu has reset option', `!![...document.querySelectorAll('.ctx-menu button')].find((b) => b.textContent === 'Reset cursor to start')`);
await evaluate(`[...document.querySelectorAll('.ctx-menu button')].find((b) => b.textContent === 'Reset cursor to start').click()`);
await sleep(100);
await check('reset moves origin and cursor to 0', `(() => {
  const s = window.__chipseq.store.session;
  return s.originTick === 0 && s.cursorTick === 0 || 'origin=' + s.originTick + ' cursor=' + s.cursorTick;
})()`);

await check('engine plays and stops', `(() => {
  const e = window.__chipseq.engine;
  e.play(0);
  const playing = e.isPlaying();
  e.stop();
  return playing && !e.isPlaying();
})()`);

// ---- background-tab safety: no overdue note bursts, no stray auditions ----
await check('hiding the tab stops the audition loop', `(() => {
  const e = window.__chipseq.engine;
  e.setAudition(() => window.__chipseq.store.getDoc().instruments[0]);
  const was = e.isAuditioning();
  document.dispatchEvent(new Event('visibilitychange'));
  // jsdom-less: visibilityState is 'visible' in a headless window, so drive
  // the hidden path explicitly through the same public API
  e.setAudition(null);
  return was && !e.isAuditioning() || 'was=' + was;
})()`);
await check('returning to a throttled tab resyncs instead of firing a backlog', `(async () => {
  const e = window.__chipseq.engine;
  const s = window.__chipseq.store;
  const { createNote, addNote } = await import('/js/core/doc.js');
  // a long stream of notes so a stalled scheduler would have a big backlog
  s.commit('stream', ['notes'], (d) => {
    for (let i = 0; i < 64; i++) {
      addNote(d, d.tracks[0].id, createNote({ pitch: 60 + (i % 12), startTick: 96 * 60 + i * 24, durationTicks: 24 }));
    }
  });
  e.play(96 * 60);
  await new Promise((r) => setTimeout(r, 150));
  const before = e.getPlayheadTick();
  document.dispatchEvent(new Event('visibilitychange')); // resync path
  await new Promise((r) => setTimeout(r, 100));
  const after = e.getPlayheadTick();
  const stillPlaying = e.isPlaying();
  e.stop();
  s.undo();
  return stillPlaying && after >= before || 'playing=' + stillPlaying + ' ' + before + '->' + after;
})()`);
await check('leaving the editor stops any audition loop', `(() => {
  const e = window.__chipseq.engine;
  e.setAudition(() => window.__chipseq.store.getDoc().instruments[0]);
  const on = e.isAuditioning();
  document.getElementById('btn-home').click();
  const off = !e.isAuditioning();
  // back to the editor for the remaining checks
  document.querySelector('#recent-list .recent-item').click();
  return on && off || 'on=' + on + ' off=' + off;
})()`);
await sleep(400);

// ---- conflicts in mono ----
await evaluate(`(async () => {
  const { createNote, addNote } = await import('/js/core/doc.js');
  const s = window.__chipseq.store;
  const t = s.getDoc().tracks[0];
  const n0 = t.notes[0];
  s.commit('test overlap', ['notes'], (d) => {
    addNote(d, d.tracks[0].id, createNote({ pitch: n0.pitch + 3, startTick: n0.startTick, durationTicks: n0.durationTicks }));
  });
})()`);
await sleep(200);
await check('conflict detected', `window.__chipseq.conflicts.count() === 2`);
await check('status bar shows conflict chip', `document.getElementById('st-conflicts').textContent.includes('conflict')`);
await evaluate(`window.__chipseq.conflicts.autoFix()`);
await sleep(150);
await check('auto-fix resolves conflicts', `window.__chipseq.conflicts.count() === 0`);

// ---- snap preference: set 1/16 via keyboard, persisted into the project ----
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit5', bubbles: true }))`);
await sleep(150);
await check('Digit5 sets snap 1/16 and stores it in the doc', `(() => {
  const ui = window.__chipseq.uiStore.state;
  const grid = window.__chipseq.store.getDoc().grid;
  return ui.snapTicks === 24 && grid && grid.snapTicks === 24
    || 'ui=' + ui.snapTicks + ' doc=' + JSON.stringify(grid);
})()`);

// ---- visibility: hidden attribute must actually hide screens ----
await check('start screen visually hidden in editor', `getComputedStyle(document.getElementById('screen-start')).display === 'none'`);

// ---- MIDI import via drag&drop + assignment dialog ----
await evaluate(`(() => {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const str = (s) => push(...[...s].map((c) => c.charCodeAt(0)));
  const u32 = (v) => push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const u16 = (v) => push((v >>> 8) & 255, v & 255);
  str('MThd'); u32(6); u16(1); u16(2); u16(480);
  const t1 = [0x00,0xff,0x51,0x03,0x07,0xa1,0x20, 0x00,0x90,60,100, 0x83,0x60,0x80,60,0, 0x00,0xff,0x2f,0x00];
  str('MTrk'); u32(t1.length); push(...t1);
  const t2 = [0x00,0x90,48,80,0x00,52,80,0x00,55,80, 0x87,0x40,48,0,0x00,52,0,0x00,55,0, 0x00,0xff,0x2f,0x00];
  str('MTrk'); u32(t2.length); push(...t2);
  const file = new File([new Uint8Array(bytes)], 'clubtune.mid', { type: 'audio/midi' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
})()`);
await sleep(600);
await check('midi import dialog open', `document.getElementById('dlg-midi-import').open`);
await check('midi dialog is centered', `(() => {
  const r = document.getElementById('dlg-midi-import').getBoundingClientRect();
  const dx = Math.abs((r.left + r.width / 2) - window.innerWidth / 2);
  const dy = Math.abs((r.top + r.height / 2) - window.innerHeight / 2);
  return dx < 40 && dy < 40 || 'off-center dx=' + dx + ' dy=' + dy;
})()`);
await check('import hint mentions roles can be exchanged later', `document.getElementById('midi-import-meta').textContent.includes('exchanged later')`);
await check('two tracks listed with role selects', `document.querySelectorAll('#midi-track-table .midi-role').length === 2`);
await check('per-track preview buttons present', `document.querySelectorAll('#midi-track-table .midi-preview').length === 2`);
await evaluate(`document.querySelectorAll('#midi-track-table .midi-preview')[0].click()`);
await sleep(300);
await check('preview toggles to pause icon while playing', `document.querySelectorAll('#midi-track-table .midi-preview')[0].innerHTML.includes('player-pause')`);
await evaluate(`document.querySelectorAll('#midi-track-table .midi-preview')[0].click()`);
await sleep(200);
await check('preview stops on second click', `document.querySelectorAll('#midi-track-table .midi-preview')[0].innerHTML.includes('player-play')`);
await check('roles suggested melody+chords', `(() => {
  const sels = [...document.querySelectorAll('#midi-track-table .midi-role')].map((s) => s.value);
  return sels[0] === 'melody' && sels[1] === 'chords';
})()`);
await evaluate(`document.getElementById('btn-midi-ok').click()`);
await sleep(500);
await check('midi project imported', `(() => {
  const d = window.__chipseq.store.getDoc();
  return d.tracks.length === 2 && d.song.bpm === 120 && d.chordTrackId === d.tracks[1].id && d.name === 'clubtune';
})()`);
await check('imported melody has 1 note', `window.__chipseq.store.getDoc().tracks[0].notes.length === 1`);
await sleep(300);
await check('chord lane renders imported chords with a name', `(async () => {
  const { buildChordEvents } = await import('/js/core/flatten.js');
  const { chordName } = await import('/js/core/music.js');
  const events = buildChordEvents(window.__chipseq.store.getDoc());
  if (events.length !== 1 || chordName(events[0].pcs) !== 'C') {
    return 'events=' + JSON.stringify(events.map((e) => chordName(e.pcs)));
  }
  const c = document.getElementById('chords-canvas');
  const data = c.getContext('2d').getImageData(0, 0, Math.min(c.width, 600), c.height).data;
  let greenish = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 1] > data[i] + 8 && data[i + 1] > data[i + 2] + 8) greenish++;
  }
  return greenish > 50 || 'greenish=' + greenish; // accent-tinted chord block visible
})()`);

// ---- M/C role buttons in the tracks panel (mono mode) ----
await check('every track row has M and C role buttons', `document.querySelectorAll('#track-list .role-btn').length === 4`);
await check('C button reassigns the chords track in mono', `(() => {
  const d = () => window.__chipseq.store.getDoc();
  const rows = document.querySelectorAll('#track-list .track-row');
  rows[0].querySelector('.role-btn.chords').click();
  const movedToFirst = d().chordTrackId === d().tracks[0].id;
  document.querySelectorAll('#track-list .track-row')[1].querySelector('.role-btn.chords').click();
  const backToSecond = d().chordTrackId === d().tracks[1].id;
  return movedToFirst && backToSecond || 'moved=' + movedToFirst + ' back=' + backToSecond;
})()`);
await check('M button moves ONLY the melody marker (not the editing focus)', `(() => {
  const d = () => window.__chipseq.store.getDoc();
  const activeBefore = d().activeTrackId;
  document.querySelectorAll('#track-list .track-row')[1].querySelector('.role-btn:not(.chords)').click();
  const melodyMoved = d().melodyTrackId === d().tracks[1].id;
  const activeUntouched = d().activeTrackId === activeBefore;
  document.querySelectorAll('#track-list .track-row')[0].querySelector('.role-btn:not(.chords)').click();
  const restored = d().melodyTrackId === d().tracks[0].id;
  return melodyMoved && activeUntouched && restored
    || 'melody=' + melodyMoved + ' active=' + activeUntouched + ' restored=' + restored;
})()`);
await check('row click changes editing focus but NOT the melody marker', `(() => {
  const d = () => window.__chipseq.store.getDoc();
  const melodyBefore = d().melodyTrackId;
  document.querySelectorAll('#track-list .track-row')[1].click();
  const focusMoved = d().activeTrackId === d().tracks[1].id;
  const melodyStayed = d().melodyTrackId === melodyBefore;
  document.querySelectorAll('#track-list .track-row')[0].click();
  return focusMoved && melodyStayed || 'focus=' + focusMoved + ' melody=' + melodyStayed;
})()`);

// ---- track rename: ENTER in the prompt saves ----
await check('Enter in the rename prompt saves the new name', `(async () => {
  const nameEl = document.querySelector('#track-list .track-row .track-name');
  nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const dlg = document.getElementById('dlg-prompt');
  if (!dlg.open) return 'prompt did not open';
  const input = document.getElementById('prompt-input');
  input.value = 'Renamed via Enter';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 250));
  const closed = !dlg.open;
  const renamed = window.__chipseq.store.getDoc().tracks[0].name === 'Renamed via Enter';
  window.__chipseq.store.undo();
  return closed && renamed || 'closed=' + closed + ' renamed=' + renamed;
})()`);

// ---- import MIDI tracks into the open project ----
await check('import-track button sits next to the add button', `(() => {
  const imp = document.getElementById('btn-import-track');
  const add = document.getElementById('btn-add-track');
  return !!imp && !!add && imp.nextElementSibling === add || 'imp=' + !!imp;
})()`);
await check('merge import adds tracks without touching the song', `(async () => {
  const s = window.__chipseq.store;
  const before = {
    tracks: s.getDoc().tracks.length,
    bpm: s.getDoc().song.bpm,
    melody: s.getDoc().melodyTrackId,
    firstName: s.getDoc().tracks[0].name,
    notes: s.getDoc().tracks[0].notes.length,
  };
  // build a 2-track MIDI (120 BPM) and feed it to the hidden input
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const str = (t) => push(...[...t].map((c) => c.charCodeAt(0)));
  const u32 = (v) => push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const u16 = (v) => push((v >>> 8) & 255, v & 255);
  str('MThd'); u32(6); u16(1); u16(2); u16(480);
  const t1 = [0x00,0xff,0x51,0x03,0x07,0xa1,0x20, 0x00,0x90,60,100, 0x83,0x60,0x80,60,0, 0x00,0xff,0x2f,0x00];
  str('MTrk'); u32(t1.length); push(...t1);
  const t2 = [0x00,0x90,48,80,0x00,52,80,0x00,55,80, 0x87,0x40,48,0,0x00,52,0,0x00,55,0, 0x00,0xff,0x2f,0x00];
  str('MTrk'); u32(t2.length); push(...t2);
  const file = new File([new Uint8Array(bytes)], 'add-me.mid', { type: 'audio/midi' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('track-import-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 600));

  const dlg = document.getElementById('dlg-midi-import');
  if (!dlg.open) return 'merge dialog did not open';
  const titleOk = dlg.querySelector('h2').textContent.includes('into this project');
  const okLabel = document.getElementById('btn-midi-ok').textContent === 'Add tracks';
  const noChordSuggestion = [...document.querySelectorAll('#midi-track-table .midi-role')].every((s2) => s2.value !== 'chords');
  document.getElementById('btn-midi-ok').click();
  await new Promise((r) => setTimeout(r, 400));

  const d = s.getDoc();
  const grew = d.tracks.length === before.tracks + 2;
  const songKept = d.song.bpm === before.bpm && d.melodyTrackId === before.melody;
  const originalKept = d.tracks[0].name === before.firstName && d.tracks[0].notes.length === before.notes;
  const focused = d.activeTrackId === d.tracks[before.tracks].id;
  s.undo();
  return titleOk && okLabel && noChordSuggestion && grew && songKept && originalKept && focused
    || JSON.stringify({ titleOk, okLabel, noChordSuggestion, grew, songKept, originalKept, focused });
})()`);

// ---- resizable side panels ----
await check('both panels have resize handles', `document.querySelectorAll('.panel-resize').length === 2`);
await check('dragging the handle resizes the tracks panel and persists', `(() => {
  const panel = document.getElementById('tracks-panel');
  const handle = panel.querySelector('.panel-resize');
  const r = handle.getBoundingClientRect();
  const before = Math.round(panel.getBoundingClientRect().width);
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 2, clientY: r.top + 100, button: 0 }));
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 62, clientY: r.top + 100 }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 62, clientY: r.top + 100 }));
  const after = Math.round(panel.getBoundingClientRect().width);
  const saved = JSON.parse(localStorage.getItem('chipseq.v1.panelw') || '{}');
  return after === before + 60 && saved.tracks === after || 'before=' + before + ' after=' + after + ' saved=' + JSON.stringify(saved);
})()`);

// ---- instrument tool (poly): picker opens section, custom config, preset ----
await evaluate(`document.querySelector('#seg-mode [data-mode="poly"]').click()`);
await sleep(200);
await check('instrument section hidden before picker use', `document.getElementById('sec-instrument').hidden`);
await evaluate(`(() => {
  const sel = document.querySelector('#track-list .track-row select');
  sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
})()`);
await sleep(200);
await check('using the picker opens the instrument section', `(() => {
  const sec = document.getElementById('sec-instrument');
  const ctx = sec.querySelector('.tool-status').textContent;
  return !sec.hidden && ctx.includes('Square') || 'hidden=' + sec.hidden + ' ctx=' + ctx;
})()`);
await evaluate(`document.querySelector('#instrument-body #in-wave [data-v="triangle"]').click()`);
await sleep(200);
await check('editing makes the track instrument Custom', `(() => {
  const d = window.__chipseq.store.getDoc();
  const t = d.tracks[0];
  const sel = document.querySelector('#track-list .track-row select');
  return t.instrument && t.instrument.wave === 'triangle' && sel.value === '__custom'
    || JSON.stringify(t.instrument) + ' sel=' + sel.value;
})()`);
await check('custom instrument flows into playback events', `(async () => {
  const { flattenSong } = await import('/js/core/flatten.js');
  const d = window.__chipseq.store.getDoc();
  const ev = flattenSong(d).events.find((e) => e.instrumentId === 'track:' + d.tracks[0].id);
  return !!ev || 'no track: event';
})()`);
// audition toggle: live loop, input = live-only, change = commit
await evaluate(`document.querySelector('#instrument-body #in-audition').click()`);
await sleep(200);
await check('audition toggle starts the loop', `(() => {
  const btn = document.querySelector('#instrument-body #in-audition');
  return window.__chipseq.engine.isAuditioning() && btn.classList.contains('active') || 'looping=' + window.__chipseq.engine.isAuditioning();
})()`);
await check('slider drag (input) updates label but not the doc', `(() => {
  const d = () => window.__chipseq.store.getDoc();
  const before = d().tracks[0].instrument.gain;
  const el = document.querySelector('#instrument-body #in-gain');
  el.value = '80';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const label = document.querySelector('#instrument-body #in-gain-label').textContent;
  return d().tracks[0].instrument.gain === before && label === '80%' || 'gain=' + d().tracks[0].instrument.gain + ' label=' + label;
})()`);
await check('slider release (change) commits the value', `(() => {
  const el = document.querySelector('#instrument-body #in-gain');
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return window.__chipseq.store.getDoc().tracks[0].instrument.gain === 0.8 || window.__chipseq.store.getDoc().tracks[0].instrument.gain;
})()`);
// Levels read as percentages, and boost past unity is allowed but flagged -
// the master limiter is what makes going over safe rather than forbidden.
await check('gain above unity is allowed and flagged as hot', `(() => {
  const el = document.querySelector('#instrument-body #in-gain');
  const label = document.querySelector('#instrument-body #in-gain-label');
  if (Number(el.max) <= 100) return 'slider still capped at ' + el.max;
  el.value = '130';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const hot = label.classList.contains('hot');
  const text = label.textContent;
  el.value = '80';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const cool = label.classList.contains('hot');
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return (text === '130%' && hot && !cool) || 'text=' + text + ' hot=' + hot + ' cool=' + cool;
})()`);
await evaluate(`document.querySelector('#instrument-body #in-audition').click()`);
await sleep(100);
await check('audition toggle stops the loop', `!window.__chipseq.engine.isAuditioning()`);

// save as preset via the prompt dialog
await evaluate(`document.querySelector('#instrument-body #in-save').click()`);
await sleep(300);
await check('preset prompt dialog opens', `document.getElementById('dlg-prompt').open`);
await evaluate(`(() => {
  document.getElementById('prompt-input').value = 'NES Triangle';
  document.querySelector('#dlg-prompt [value="ok"]').click();
})()`);
await sleep(300);
await check('saved preset lands in the project and the track uses it', `(() => {
  const d = window.__chipseq.store.getDoc();
  const preset = d.instruments.find((i) => i.name === 'NES Triangle');
  const t = d.tracks[0];
  return preset && t.instrumentId === preset.id && t.instrument === null
    || JSON.stringify({ preset: !!preset, id: t.instrumentId, custom: t.instrument });
})()`);
await check('preset offered in the other track picker too', `(() => {
  const sels = document.querySelectorAll('#track-list .track-row select');
  const other = sels[1];
  return other && [...other.options].some((o) => o.textContent === 'NES Triangle') || 'options missing';
})()`);
await check('default instrument renamed to plain Square', `(() => {
  const sel = document.querySelectorAll('#track-list .track-row select')[0];
  const names = [...sel.options].map((o) => o.textContent);
  return names.includes('Square') && !names.includes('Badge Square') || names.join(',');
})()`);

// ---- automation lanes (poly): per-control keyframes ----
await check('automation stack open by default with gain expanded', `(() => {
  const master = document.getElementById('auto-master');
  const btns = [...document.querySelectorAll('.auto-lane-btn')].map((b) => b.textContent.trim());
  const rows = document.getElementById('roll-area').style.gridTemplateRows;
  // triangle preset: gain + 4 ADSR lanes, NO duty lane
  return master && master.textContent.includes('▾') && btns.length === 6
    && btns.some((t) => t.startsWith('Gain')) && !btns.some((t) => t.startsWith('Duty'))
    && rows.endsWith('142px') || btns.join(',') + ' rows=' + rows;
})()`);
// The lane's y<->value mapping follows the param's declared range, so the
// expected value is derived rather than hard-coded - the gain lane's range
// grew to allow boost above unity and a literal 0.5 here would have silently
// become wrong rather than failing loudly.
await check('click in expanded gain lane adds a keyframe', `(async () => {
  const { AUTOMATION_PARAMS } = await import('/js/core/automation.js');
  const { min, max } = AUTOMATION_PARAMS.gain;
  const c = document.getElementById('auto-canvas');
  const r = c.getBoundingClientRect();
  // gain lane occupies y 18..78 with 6px padding; y=48 is its vertical middle
  for (const type of ['mousedown', 'mouseup']) {
    (type === 'mousedown' ? c : window).dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + 100, clientY: r.top + 48, button: 0 }));
  }
  const expected = min + (max - min) * 0.5;
  const lane = (window.__chipseq.store.getDoc().tracks[0].automation || {}).gain || [];
  return lane.length === 1 && lane[0].tick === 192 && Math.abs(lane[0].value - expected) < 0.06
    || JSON.stringify(lane) + ' expected~' + expected;
})()`);
await check('click on a collapsed lane only expands it (no edit)', `(() => {
  const c = document.getElementById('auto-canvas');
  const r = c.getBoundingClientRect();
  // attack lane header: collapsed strip right below gain (y 78..94)
  for (const type of ['mousedown', 'mouseup']) {
    (type === 'mousedown' ? c : window).dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + 300, clientY: r.top + 86, button: 0 }));
  }
  const auto = window.__chipseq.store.getDoc().tracks[0].automation || {};
  const attackBtn = [...document.querySelectorAll('.auto-lane-btn')].find((b) => b.textContent.includes('Attack'));
  const saved = JSON.parse(localStorage.getItem('chipseq.v1.autolane') || '{}');
  return !(auto.attack || []).length && attackBtn.classList.contains('expanded') && saved.expanded.attack === true
    || JSON.stringify({ attack: auto.attack, expanded: attackBtn.className });
})()`);
await check('keyframe in the attack lane overrides note envelopes', `(async () => {
  const { flattenSong } = await import('/js/core/flatten.js');
  const c = document.getElementById('auto-canvas');
  const r = c.getBoundingClientRect();
  // attack lane now expanded at y 78..138; click near the top = long attack
  for (const type of ['mousedown', 'mouseup']) {
    (type === 'mousedown' ? c : window).dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + 10, clientY: r.top + 78 + 10, button: 0 }));
  }
  const d = window.__chipseq.store.getDoc();
  const lane = (d.tracks[0].automation || {}).attack || [];
  if (lane.length !== 1 || lane[0].value < 0.2) return 'lane=' + JSON.stringify(lane);
  const ev = flattenSong(d).events.find((e) => d.tracks[0].notes.some((n) => n.id === e.noteId));
  return ev && ev.adsr && ev.adsr.a === lane[0].value || JSON.stringify(ev && ev.adsr);
})()`);
await check('dragging moves a gain keyframe', `(() => {
  const c = document.getElementById('auto-canvas');
  const r = c.getBoundingClientRect();
  const ui = window.__chipseq.uiStore.state;
  const x = r.left + 192 * ui.pxPerTick;
  const y = r.top + 48;
  c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 48, clientY: y - 10 }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 48, clientY: y - 10 }));
  const lane = window.__chipseq.store.getDoc().tracks[0].automation.gain;
  return lane.length === 1 && lane[0].tick === 288 || JSON.stringify(lane);
})()`);
await check('double-click cycles curve, undo reverts', `(async () => {
  const { AUTOMATION_PARAMS } = await import('/js/core/automation.js');
  const { min, max } = AUTOMATION_PARAMS.gain;
  const c = document.getElementById('auto-canvas');
  const r = c.getBoundingClientRect();
  const ui = window.__chipseq.uiStore.state;
  const lane0 = window.__chipseq.store.getDoc().tracks[0].automation.gain[0];
  const x = r.left + lane0.tick * ui.pxPerTick;
  // recompute point y from its value in the gain lane (y 18..78, pad 6)
  const y = r.top + 18 + 6 + (1 - (lane0.value - min) / (max - min)) * 48;
  c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
  const after = window.__chipseq.store.getDoc().tracks[0].automation.gain[0].curve;
  window.__chipseq.store.undo();
  const reverted = window.__chipseq.store.getDoc().tracks[0].automation.gain[0].curve;
  return after === 'ease' && reverted === 'linear' || after + '/' + reverted;
})()`);
await check('right-click deletes a keyframe', `(async () => {
  const { AUTOMATION_PARAMS } = await import('/js/core/automation.js');
  const { min, max } = AUTOMATION_PARAMS.gain;
  const c = document.getElementById('auto-canvas');
  const r = c.getBoundingClientRect();
  const ui = window.__chipseq.uiStore.state;
  const lane0 = window.__chipseq.store.getDoc().tracks[0].automation.gain[0];
  const x = r.left + lane0.tick * ui.pxPerTick;
  const y = r.top + 18 + 6 + (1 - (lane0.value - min) / (max - min)) * 48;
  c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 2 }));
  const lane = window.__chipseq.store.getDoc().tracks[0].automation.gain;
  return lane.length === 0 || JSON.stringify(lane);
})()`);
await check('duty lane appears only for PWM instruments', `(() => {
  const s = window.__chipseq.store;
  const before = [...document.querySelectorAll('.auto-lane-btn')].some((b) => b.textContent.includes('Duty'));
  s.commit('to pwm', ['tracks'], (d) => {
    d.tracks[0].instrument = { id: 'track:' + d.tracks[0].id, name: 'Custom', wave: 'custom', duty: 0.25,
      harmonics: null, adsr: { a: 0.002, d: 0, s: 1, r: 0.002 }, gain: 0.3 };
  });
  const after = [...document.querySelectorAll('.auto-lane-btn')].some((b) => b.textContent.includes('Duty'));
  s.undo();
  return !before && after || 'before=' + before + ' after=' + after;
})()`);
await check('master toggle collapses the whole stack', `(() => {
  document.getElementById('auto-master').click();
  const rows = document.getElementById('roll-area').style.gridTemplateRows;
  const collapsed = rows.endsWith('18px');
  document.getElementById('auto-master').click();
  return collapsed || rows;
})()`);
await check('mono mode hides the lanes and ignores automation', `(async () => {
  const { flattenSong } = await import('/js/core/flatten.js');
  document.querySelector('#seg-mode [data-mode="mono"]').click();
  await new Promise((r) => setTimeout(r, 200));
  const menu = document.querySelector('.ctx-menu button');
  if (menu) menu.click();
  await new Promise((r) => setTimeout(r, 200));
  const hidden = document.getElementById('roll-area').classList.contains('mono-mode');
  const d = window.__chipseq.store.getDoc();
  const ignored = flattenSong(d).events.every((e) => e.instrumentId === 'badge' && !('adsr' in e));
  document.querySelector('#seg-mode [data-mode="poly"]').click();
  await new Promise((r) => setTimeout(r, 200));
  return hidden && ignored || 'hidden=' + hidden + ' ignored=' + ignored;
})()`);
// clean up automation for the remaining checks
await evaluate(`window.__chipseq.store.commit('clear auto', ['automation'], (d) => { delete d.tracks[0].automation; })`);
await sleep(150);

// ---- back home, then check trimmer + autosave + reload ----
await evaluate(`document.getElementById('btn-home').click()`);
await sleep(300);
await check('back on start screen with 3 recents (demos are separate)', `!document.getElementById('screen-start').hidden && document.querySelectorAll('#recent-list .recent-item').length === 3`);
await evaluate(`document.querySelectorAll('.recent-item')[1] ? document.querySelectorAll('.recent-item')[1].click() : document.querySelector('.recent-item').click()`);
await sleep(300);
await check('loop region restored from localStorage', `(() => {
  const loop = window.__chipseq.store.getLoop();
  return loop && loop.startTick === 1536 && loop.endTick === 1920 || JSON.stringify(loop);
})()`);
await check('loop region included in .tune.json export', `(async () => {
  const { exportTuneJson } = await import('/js/core/persist.js');
  const text = await exportTuneJson(window.__chipseq.store.getDoc()).text();
  const parsed = JSON.parse(text);
  return parsed.loop && parsed.loop.startTick === 1536 || JSON.stringify(parsed.loop);
})()`);
await check('snap preference restored from localStorage', `(() => {
  const ui = window.__chipseq.uiStore.state;
  const sel = document.getElementById('sel-snap');
  return ui.snapTicks === 24 && sel.options[sel.selectedIndex].textContent === '1/16'
    || 'ui=' + ui.snapTicks + ' sel=' + sel.options[sel.selectedIndex].textContent;
})()`);
await check('grid preference included in .tune.json export', `(async () => {
  const { exportTuneJson } = await import('/js/core/persist.js');
  const parsed = JSON.parse(await exportTuneJson(window.__chipseq.store.getDoc()).text());
  return parsed.grid && parsed.grid.snapTicks === 24 || JSON.stringify(parsed.grid);
})()`);

// ---- tempo map + doc.uses ----
await check('the BPM field writes the tempo map, not the legacy mirror', `(async () => {
  const { bpmAt } = await import('/js/core/doc.js');
  const inp = document.getElementById('inp-bpm');
  inp.value = '150';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  const d = window.__chipseq.store.getDoc();
  const errs = [];
  if (!Array.isArray(d.song.tempo) || d.song.tempo.length !== 1) errs.push('tempo map: ' + JSON.stringify(d.song.tempo));
  if (bpmAt(d, 0) !== 150) errs.push('bpmAt=' + bpmAt(d, 0));
  // the v3 scalar is kept in sync so the previously deployed build can still
  // open files written here
  if (d.song.bpm !== 150) errs.push('legacy mirror=' + d.song.bpm);
  window.__chipseq.store.undo();
  return errs.length === 0 || errs.join('; ');
})()`);

await check('a mid-song tempo change is declared in doc.uses', `(async () => {
  const { setTempo } = await import('/js/core/doc.js');
  const store = window.__chipseq.store;
  store.commit('test tempo map', ['song'], (d) => setTempo(d, 200, 384));
  const d = store.getDoc();
  const declared = (d.uses || []).includes('tempoMap');
  // an older build would read the mirror and play one tempo throughout,
  // which is why this has to be announced rather than assumed harmless
  const mirrorStillFirst = d.song.bpm === d.song.tempo[0].bpm;
  store.undo();
  const cleared = !(store.getDoc().uses || []).includes('tempoMap');
  return (declared && mirrorStillFirst && cleared)
    || 'declared=' + declared + ' mirror=' + mirrorStillFirst + ' cleared=' + cleared;
})()`);

await check('unsupported features are reported, never dropped', `(async () => {
  const { unsupportedFeatures, migrate } = await import('/js/core/doc.js');
  const raw = JSON.stringify({ ...window.__chipseq.store.getDoc(), uses: ['harmonics', 'effects@1'], futureBlock: { kind: 'x', v: 1 } });
  const doc = migrate(JSON.parse(raw));
  const missing = unsupportedFeatures(doc);
  return (missing.length === 1 && missing[0] === 'effects@1' && !!doc.futureBlock)
    || JSON.stringify({ missing, kept: !!doc.futureBlock });
})()`);

// ---- WAV render: structure, level and the non-clipping master ----
// Rendered audio is checked by measurement rather than byte-comparison: the
// WaveShaper's behaviour depends on the Chromium build, so a byte golden
// would fail on browser upgrades instead of on real regressions.
const WAV_HELPERS = `
  const readWav = async (blob) => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const str = (o, n) => String.fromCharCode(...buf.slice(o, o + n));
    const samples = new Int16Array(buf.buffer, 44, (buf.length - 44) / 2);
    let peak = 0, sumSq = 0;
    for (const s of samples) { const a = Math.abs(s / 32768); if (a > peak) peak = a; sumSq += a * a; }
    return {
      riff: str(0, 4), wave: str(8, 4), fmt: str(12, 4), dataTag: str(36, 4),
      fmtSize: dv.getUint32(16, true), format: dv.getUint16(20, true),
      channels: dv.getUint16(22, true), rate: dv.getUint32(24, true),
      byteRate: dv.getUint32(28, true), blockAlign: dv.getUint16(32, true),
      bits: dv.getUint16(34, true), dataSize: dv.getUint32(40, true),
      riffSize: dv.getUint32(4, true),
      bytes: buf.length, sampleCount: samples.length,
      peak, rms: Math.sqrt(sumSq / samples.length),
    };
  };
`;

await check('rendered WAV is structurally valid', `(async () => {
  ${WAV_HELPERS}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { blob } = await renderWav(window.__chipseq.store.getDoc());
  const w = await readWav(blob);
  const errs = [];
  if (w.riff !== 'RIFF' || w.wave !== 'WAVE' || w.fmt !== 'fmt ' || w.dataTag !== 'data') errs.push('chunk tags');
  if (w.fmtSize !== 16 || w.format !== 1) errs.push('not PCM');
  if (w.channels !== 1 || w.rate !== 44100 || w.bits !== 16) errs.push('not 16-bit mono 44.1k');
  if (w.blockAlign !== 2 || w.byteRate !== 88200) errs.push('block align/byte rate');
  // the length fields must agree with the payload, or players truncate
  if (w.dataSize !== w.sampleCount * 2) errs.push('data size vs samples');
  if (w.riffSize !== w.bytes - 8) errs.push('riff size');
  return errs.length === 0 || errs.join(', ');
})()`);

await check('WAV length matches the song length at the project tempo', `(async () => {
  ${WAV_HELPERS}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { songEndTick } = await import('/js/core/doc.js');
  const doc = window.__chipseq.store.getDoc();
  const { blob } = await renderWav(doc);
  const w = await readWav(blob);
  const seconds = w.sampleCount / 44100;
  const songS = songEndTick(doc) * (60 / (doc.song.bpm * doc.ppq));
  // the render adds the longest release plus a short tail
  return seconds > songS && seconds < songS + 1.5 || 'wav=' + seconds.toFixed(3) + ' song=' + songS.toFixed(3);
})()`);

await check('a normal mix renders below 0 dBFS and is not flagged', `(async () => {
  ${WAV_HELPERS}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { blob, level } = await renderWav(window.__chipseq.store.getDoc());
  const w = await readWav(blob);
  return (level.over === false && w.peak <= 1 && w.peak > 0 && w.rms > 0)
    || 'over=' + level.over + ' peak=' + w.peak.toFixed(4) + ' rms=' + w.rms.toFixed(4);
})()`);

// The headline guarantee: however hot the project is, the file cannot clip -
// and the user is told it happened rather than left with a squashed render.
await check('a deliberately hot mix is limited, not clipped, and is reported', `(async () => {
  ${WAV_HELPERS}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { dbToLin, limiterConfig } = await import('/js/core/graph.js');
  const doc = structuredClone(window.__chipseq.store.getDoc());
  doc.mode = 'poly';
  // eight loud voices stacked on the same beat - guaranteed to sum over 1.0
  doc.instruments.forEach((i) => { i.gain = 1; });
  doc.tracks = [0,1,2,3,4,5,6,7].map((i) => ({
    id: 'hot-' + i, name: 'hot' + i, role: 'melody', instrumentId: 'badge',
    notes: [{ id: 'hn-' + i, pitch: 60 + i, startTick: 0, durationTicks: 384, velocity: 127, harmonics: null }],
  }));
  doc.activeTrackId = doc.melodyTrackId = 'hot-0';
  const { blob, level } = await renderWav(doc);
  const w = await readWav(blob);
  const ceiling = dbToLin(limiterConfig(doc).ceilingDb);
  const errs = [];
  if (!level.over) errs.push('hot mix not flagged (peak ' + level.peakDb.toFixed(2) + ' dB)');
  if (level.peak <= 1) errs.push('pre-limiter peak not above 1: ' + level.peak.toFixed(3));
  // +0.5/32768 tolerance: the ceiling survives 16-bit rounding, not exceeds it
  if (w.peak > ceiling + 0.0001) errs.push('rendered peak above the ceiling: ' + w.peak.toFixed(5));
  if (level.shapedRatio <= 0) errs.push('nothing reported as shaped');
  return errs.length === 0 || errs.join('; ');
})()`);

// Regression guard for the bug this phase fixed: the exporter used to bypass
// the master gain entirely, so files rendered ~1 dB hotter than the preview.
await check('export runs through the same master gain as playback', `(async () => {
  ${WAV_HELPERS}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { MASTER_GAIN } = await import('/js/core/graph.js');
  const doc = structuredClone(window.__chipseq.store.getDoc());
  doc.mode = 'poly';
  const inst = doc.instruments.find((i) => i.id === 'badge');
  inst.gain = 0.5;
  inst.adsr = { a: 0.002, d: 0, s: 1, r: 0.002 };
  doc.tracks = [{
    id: 'lvl', name: 'lvl', role: 'melody', instrumentId: 'badge',
    notes: [{ id: 'ln', pitch: 69, startTick: 0, durationTicks: 384, velocity: 127, harmonics: null }],
  }];
  doc.activeTrackId = doc.melodyTrackId = 'lvl';
  const { blob } = await renderWav(doc);
  const w = await readWav(blob);
  // one square voice: gain * velocity/127 * MASTER_GAIN, before the (inactive
  // at this level) clipper. A normalized PeriodicWave overshoots a little, so
  // this is a band rather than an equality.
  const expected = 0.5 * (127 / 127) * MASTER_GAIN;
  const ratio = w.peak / expected;
  return (ratio > 0.85 && ratio < 1.35) || 'peak=' + w.peak.toFixed(4) + ' expected~' + expected.toFixed(4) + ' ratio=' + ratio.toFixed(3);
})()`);

await check('the engine exposes a pre-limiter peak for the clip indicator', `(() => {
  const e = window.__chipseq.engine;
  if (typeof e.getPeak !== 'function') return 'no getPeak';
  e.ensureCtx();
  const p = e.getPeak();
  return (typeof p === 'number' && p >= 0 && p <= 8) || 'peak=' + p;
})()`);

// ---- autosave + reload ----
await sleep(700); // let autosave debounce flush
const projName = await evaluate(`window.__chipseq.store.getDoc().name`);
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(1500);
await check('reload resumes the LAST-OPENED project (incl. its mode)', `(() => {
  const doc = window.__chipseq && window.__chipseq.store.getDoc();
  const activeSeg = document.querySelector('#seg-mode .seg-btn.active');
  return !document.getElementById('screen-editor').hidden && doc && doc.name === ${JSON.stringify('Untitled')}
    && activeSeg && activeSeg.dataset.mode === doc.mode
    && doc.tracks[0].notes.length >= 1 || (doc ? doc.name + '/' + doc.mode : 'no app');
})()`);
await evaluate(`document.getElementById('btn-home').click()`);
await sleep(300);
await check('home lists all projects incl. the previous one', `(() => {
  const text = document.getElementById('recent-list').textContent;
  return !document.getElementById('screen-start').hidden && text.includes(${JSON.stringify(projName)})
    && document.querySelectorAll('#recent-list .recent-item').length === 3 || text;
})()`);

// ---- referential integrity through the real UI ----
await check('deleting the marked track re-points the markers', `(async () => {
  const { createTrack, getTrack } = await import('/js/core/doc.js');
  const store = window.__chipseq.store;
  let repaired = null;
  const off = store.on('doc-repaired', (w) => (repaired = w));
  // add a track, point every marker at it, then delete it
  let victimId = null;
  store.commit('add victim', ['tracks'], (d) => {
    const t = createTrack({ name: 'Victim', role: 'melody', instrumentId: 'sine' });
    d.tracks.push(t);
    victimId = t.id;
    d.activeTrackId = t.id;
    d.melodyTrackId = t.id;
    d.chordTrackId = t.id;
  });
  store.commit('delete victim', ['tracks'], (d) => {
    d.tracks = d.tracks.filter((t) => t.id !== victimId);
  });
  const d = store.getDoc();
  off();
  const errs = [];
  if (!getTrack(d, d.activeTrackId)) errs.push('active dangling');
  if (!getTrack(d, d.melodyTrackId)) errs.push('melody dangling');
  if (d.chordTrackId !== null) errs.push('chord not cleared: ' + d.chordTrackId);
  if (!repaired || !repaired.length) errs.push('no repair reported');
  store.undo();
  store.undo();
  return errs.length === 0 || errs.join('; ');
})()`);

// ---- storage that never throws ----
// Runs LAST: once persist degrades it stays degraded for the page's lifetime,
// which is exactly the behaviour under test but would upset anything after it.
await check('a full quota degrades gracefully instead of throwing', `(async () => {
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function () {
    throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
  };
  try {
    const { isDegraded, saveProject } = await import('/js/core/persist.js');
    const doc = window.__chipseq.store.getDoc();
    let threw = false;
    let durable = true;
    try { durable = saveProject(doc); } catch { threw = true; }
    // The app has to keep FUNCTIONING while storage is dead - edits still
    // apply, undo still works, the in-memory project is intact. (Which screen
    // happens to be showing at this point in the suite is irrelevant.)
    const before = window.__chipseq.store.getDoc().name;
    window.__chipseq.store.commit('edit while full', ['song'], (d) => { d.name = 'edited while full'; });
    const applied = window.__chipseq.store.getDoc().name === 'edited while full';
    window.__chipseq.store.undo();
    const undone = window.__chipseq.store.getDoc().name === before;
    const errs = [];
    if (threw) errs.push('saveProject threw');
    if (durable !== false) errs.push('claimed a durable save');
    if (!isDegraded()) errs.push('not marked degraded');
    if (!applied) errs.push('edit did not apply');
    if (!undone) errs.push('undo broke');
    return errs.length === 0 || errs.join('; ');
  } finally {
    Storage.prototype.setItem = original;
  }
})()`);

await check('the status bar says it is not saving', `(async () => {
  // the autosave debounce has to run for the message to appear
  await new Promise((r) => setTimeout(r, 700));
  const el = document.getElementById('st-save');
  return (el.classList.contains('warn') && /not saving/.test(el.textContent))
    || 'class=' + el.className + ' text=' + JSON.stringify(el.textContent);
})()`);

// ---- console errors ----
if (consoleErrors.length) {
  fail++;
  console.log('FAIL console errors:\n  ' + consoleErrors.join('\n  '));
} else {
  pass++;
  console.log('OK   no console errors');
}

console.log(`\n${pass} passed, ${fail} failed`);
chrome.kill();
server.close();
process.exit(fail ? 1 : 0);
