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
await check('demo seeded into Recent projects (not auto-opened)', `(() => {
  const items = document.querySelectorAll('.recent-item');
  const text = document.getElementById('recent-list').textContent;
  return items.length === 1 && text.includes('Demo Mono 1') || 'items=' + items.length;
})()`);
await check('footer shows brand + version', `(() => {
  const t = document.getElementById('st-brand').textContent;
  return /^ChipSeq by n0ctu · v\\d+\\.\\d+\\.\\d+$/.test(t) || t;
})()`);
await check('demo seed flag set (no reseed after delete-all)', `localStorage.getItem('chipseq.v1.demosSeeded') === '1'`);
// open the demo once to verify it loads intact, then back home
await evaluate(`document.querySelector('.recent-item').click()`);
await sleep(300);
await check('demo opens with all notes intact', `(() => {
  const doc = window.__chipseq.store.getDoc();
  return !document.getElementById('screen-editor').hidden && doc.name === 'Demo Mono 1'
    && doc.tracks[0].notes.length === 7 || doc.name + '/' + doc.tracks[0].notes.length;
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
  // (enabled: false — region export must work without loop playback on)
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
  const blob = await renderWav(doc, { region });
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
  const blob = await renderWav(window.__chipseq.store.getDoc());
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
await check('M button switches the melody/active track in mono', `(() => {
  const d = () => window.__chipseq.store.getDoc();
  document.querySelectorAll('#track-list .track-row')[1].querySelector('.role-btn:not(.chords)').click();
  const switched = d().activeTrackId === d().tracks[1].id;
  document.querySelectorAll('#track-list .track-row')[0].querySelector('.role-btn:not(.chords)').click();
  const restored = d().activeTrackId === d().tracks[0].id;
  return switched && restored || 'switched=' + switched + ' restored=' + restored;
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

// ---- back home, then check trimmer + autosave + reload ----
await evaluate(`document.getElementById('btn-home').click()`);
await sleep(300);
await check('back on start screen with 3 recents (incl. demo)', `!document.getElementById('screen-start').hidden && document.querySelectorAll('.recent-item').length === 3`);
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

// ---- autosave + reload ----
await sleep(700); // let autosave debounce flush
const projName = await evaluate(`window.__chipseq.store.getDoc().name`);
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await sleep(1500);
await check('reload auto-opens the most recently edited project', `(() => {
  const doc = window.__chipseq && window.__chipseq.store.getDoc();
  return !document.getElementById('screen-editor').hidden && doc && doc.name === 'clubtune'
    && doc.tracks[0].notes.length >= 1 || (doc ? doc.name : 'no app');
})()`);
await evaluate(`document.getElementById('btn-home').click()`);
await sleep(300);
await check('home lists all projects incl. the previous one', `(() => {
  const text = document.getElementById('recent-list').textContent;
  return !document.getElementById('screen-start').hidden && text.includes(${JSON.stringify(projName)})
    && document.querySelectorAll('.recent-item').length === 3 || text;
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
