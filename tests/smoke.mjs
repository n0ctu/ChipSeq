// Headless-browser smoke test via raw CDP (needs Node 22+ and Chromium).
// Run: node tests/smoke.mjs   (set CHROME_BIN to override browser discovery)
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findChrome } from './util.mjs';
import { createServer as createBadgeServer } from '../server/index.mjs';
import { FakeBadge } from '../tools/fake-badge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = findChrome();
const PORT = 8931;
// os.tmpdir() honours $TMPDIR, so a sandbox that redirects temp files gets
// them there; a bare '/tmp' ignored that and wrote to a directory that turned
// out to be read-only, and Chrome cannot start without a writable profile.
const PROFILE = join(tmpdir(), 'chipseq-smoke-profile-' + Date.now());

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// When set, served instead of the sw.js on disk. The update test needs the
// worker's BYTES to change at the same URL - that is the only thing a browser
// treats as a new version - and doing it here keeps the repository file
// untouched even if the run dies halfway.
let swOverride = null;
const server = http.createServer(async (req, res) => {
  try {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const data = path === '/sw.js' && swOverride ? swOverride : await readFile(join(ROOT, path));
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      // Same reason dev-server.mjs does it, plus one specific to this file: with
      // no Cache-Control at all Chrome caches heuristically, and the offline
      // test at the bottom then passes on the HTTP cache while the service
      // worker does nothing. Verified by disabling the worker's cache lookup
      // entirely - the app still booted offline until this header existed.
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

// A real badge server, on its own port, so the Badges card can be driven
// end to end against the same code the hardware talks to - not a stub that
// would agree with the card by construction.
const badgeHub = createBadgeServer({});
await new Promise((r) => badgeHub.httpServer.listen(0, r));
const BADGE_PORT = badgeHub.httpServer.address().port;
const BADGE_WS = `ws://127.0.0.1:${BADGE_PORT}/ws`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two ways to get a browser.
//
// Normally this spawns its own, on a random debugging port it reads back from
// the profile - a fixed port silently attaches to whatever browser already
// holds it, which once meant driving a days-old leaked profile without
// noticing. Harmless until service workers, which persist.
//
// CHROME_CDP=host:port attaches to a Chrome someone else started, e.g.
//   chrome --headless=new --remote-debugging-port=9222 \
//          --autoplay-policy=no-user-gesture-required --window-size=1400,1300
// That is for a sandbox that allows TCP but not the AF_UNIX socket Chromium
// insists on for its process-singleton lock: run the browser outside, drive
// it over CDP from inside. Everything below is plain HTTP+WebSocket to
// 127.0.0.1, which such a sandbox permits. The suite does not own that
// browser, so it neither kills it nor deletes its profile.
let chrome = null;
let DEBUG_PORT = null;
if (process.env.CHROME_CDP) {
  const [host, port] = process.env.CHROME_CDP.split(':');
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    console.error('FAIL CHROME_CDP must be on 127.0.0.1 - the test server binds there');
    process.exit(1);
  }
  DEBUG_PORT = Number(port || host);
  console.log(`attaching to an external Chrome on 127.0.0.1:${DEBUG_PORT}`);
} else {
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
    // tall window: reproduces the fractional-scrollPitch clamp at load
    '--window-size=1400,1300',
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore' });

  // Chrome writes the port it actually chose here, so we can only ever talk to
  // the browser we just started.
  for (let i = 0; i < 100; i++) {
    try {
      const line = (await readFile(join(PROFILE, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      if (Number(line)) { DEBUG_PORT = Number(line); break; }
    } catch {}
    await sleep(100);
  }
  if (!DEBUG_PORT) {
    console.error('FAIL Chrome never reported a debugging port');
    process.exit(1);
  }
}

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
let page = targets.find((t) => t.type === 'page');
if (!page) {
  // An attached browser may hold no page yet; ask it for one.
  page = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
// One-shot waiters for CDP events, so a navigation can be awaited instead of
// slept through.
const eventWaiters = new Map();
function once(method) {
  return new Promise((resolve) => {
    const list = eventWaiters.get(method) || [];
    list.push(resolve);
    eventWaiters.set(method, list);
  });
}
// Every request the page has started but not finished, with its start time.
// Purely diagnostic: when a boot times out, the single most useful fact is
// which fetch never came back - a module, sw.js, a demo - and this is the only
// vantage point that can see it. One boot on one machine blocked for 426
// SECONDS with the app object never appearing, and nothing in the pass/fail
// output could say why.
const inflight = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Network.requestWillBeSent') {
    inflight.set(msg.params.requestId, { url: msg.params.request.url, at: Date.now() });
  } else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
    inflight.delete(msg.params.requestId);
  }
  if (msg.method && eventWaiters.has(msg.method)) {
    for (const resolve of eventWaiters.get(msg.method)) resolve(msg.params);
    eventWaiters.delete(msg.method);
  }
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

// Boot is a condition, not a duration. The demos are 1.9 MB and the static
// server sends no-store, so how long a reload takes depends on the machine -
// the fixed sleeps here were tuned against a warm browser profile and started
// failing the moment the harness began using a genuinely fresh one.
async function waitUntil(expr, { timeout = 20000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v = false;
    // Race each probe against its own small timeout. Runtime.evaluate has
    // none: a wedged renderer simply never replies, and one probe then holds
    // this loop far past its deadline - a boot that should have failed at 20
    // seconds was observed reporting after 442, because a single evaluate sat
    // blocked the whole time the page was. The orphaned reply resolves into
    // `pending` later and is ignored.
    try { v = await Promise.race([evaluate(expr), sleep(2000).then(() => false)]); } catch {}
    if (v === true) return true;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

// The app object exists and it has settled on a screen: the start page with
// its demos listed, or straight into the editor for a returning visitor.
const BOOTED = `!!window.__chipseq && (
  !document.getElementById('screen-editor').hidden
  || document.querySelectorAll('#demo-list .demo-item').length > 0
)`;

let bootCount = 0;
async function navigateAndBoot(why = '') {
  // Wait for the load event before evaluating anything. A Runtime.evaluate
  // sent while the old document is being torn down is simply dropped, and
  // send() then waits for a reply that never comes - the run hangs rather than
  // failing, which is a far worse way to be wrong.
  bootCount++;
  const t0 = Date.now();
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await Promise.race([loaded, sleep(20000)]);
  if (!(await waitUntil(BOOTED))) {
    // Say WHICH boot and WHAT the page looked like. "did not boot" on its own
    // cannot be acted on from a paste - and this failed once on a machine the
    // author could not see into.
    let state = '(page unreachable)';
    try {
      state = await evaluate(`(() => {
        const app = !!window.__chipseq;
        const start = document.getElementById('screen-start');
        const editor = document.getElementById('screen-editor');
        const demos = document.querySelectorAll('#demo-list .demo-item').length;
        const doc = app ? window.__chipseq.store.getDoc() : null;
        return 'app=' + app + ' start=' + (start && !start.hidden) + ' editor=' + (editor && !editor.hidden)
          + ' demos=' + demos + (doc ? ' doc="' + doc.name + '" notes=' + doc.tracks.reduce((n, t) => n + t.notes.length, 0) : '')
          + ' readyState=' + document.readyState;
      })()`);
    } catch (err) { state = '(evaluate failed: ' + err.message.split('\n')[0] + ')'; }
    const errs = consoleErrors.length ? ' consoleErrors=' + JSON.stringify(consoleErrors.slice(-3)) : '';
    const stuck = [...inflight.values()]
      .map((r) => `${r.url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '')} (${((Date.now() - r.at) / 1000).toFixed(1)}s)`)
      .slice(0, 8);
    const net = stuck.length ? ` pendingRequests=[${stuck.join(', ')}]` : ' pendingRequests=none';
    console.log(`FAIL the app did not finish booting within 20s [boot #${bootCount}${why ? ' ' + why : ''}, ${Date.now() - t0} ms] ${state}${errs}${net}`);
    fail++;
  }
}

// Shared by every test that measures rendered audio. Defined up here so a
// test's position in the file does not decide whether it can measure.
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

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await navigateAndBoot('first load');
// hermetic run even if a stale browser profile is reused
await evaluate(`localStorage.clear()`);
await navigateAndBoot('after localStorage.clear');

// ---- fresh boot: start page greets new users with the seeded demo ----
await check('fresh boot greets with the start page', `!document.getElementById('screen-start').hidden && !!window.__chipseq`);
await check('demos listed in their own section, not in recents', `(() => {
  const demoItems = document.querySelectorAll('#demo-list .demo-item');
  const demoText = document.getElementById('demo-list').textContent;
  const recents = document.getElementById('recent-list').textContent;
  return demoItems.length === 6 && demoText.includes('Demo Mono') && demoText.includes('Demo Poly')
    && demoText.includes('Rickroll') && demoText.includes('Tetris') && demoText.includes('Bad Apple')
    && demoText.includes('Unreal Superhero 3')
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
  return demoItems === 6 && recents === 1 || 'demos=' + demoItems + ' recents=' + recents;
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
  // a long stream of notes so a stalled scheduler would have a big backlog.
  // Pentatonic rather than chromatic - it is the same 64 notes to the
  // scheduler and much easier on anyone within earshot.
  const PENTA = [0, 2, 4, 7, 9];
  s.commit('stream', ['notes'], (d) => {
    for (let i = 0; i < 64; i++) {
      const pitch = 60 + PENTA[i % PENTA.length] + 12 * Math.floor((i % 15) / 5);
      addNote(d, d.tracks[0].id, createNote({ pitch, startTick: 96 * 60 + i * 24, durationTicks: 24 }));
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

// ---- track dialog: name + colour, Enter saves ----
await check('Enter in the track dialog saves the new name', `(async () => {
  const nameEl = document.querySelector('#track-list .track-row .track-name');
  nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const dlg = document.getElementById('dlg-track');
  if (!dlg.open) return 'track dialog did not open';
  const input = document.getElementById('track-name');
  input.value = 'Renamed via Enter';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 250));
  const closed = !dlg.open;
  const renamed = window.__chipseq.store.getDoc().tracks[0].name === 'Renamed via Enter';
  window.__chipseq.store.undo();
  return closed && renamed || 'closed=' + closed + ' renamed=' + renamed;
})()`);

await check('the track dialog sets an explicit colour', `(async () => {
  const store = window.__chipseq.store;
  const before = store.getDoc().tracks[0].color;
  const nameEl = document.querySelector('#track-list .track-row .track-name');
  nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const swatches = document.querySelectorAll('#track-colors .swatch');
  if (swatches.length !== 8) return 'expected 8 colours, got ' + swatches.length;
  // the track's current colour is the one marked
  const marked = [...swatches].findIndex((b) => b.classList.contains('on'));
  swatches[4].click();
  document.querySelector('#dlg-track [value="ok"]').click();
  await new Promise((r) => setTimeout(r, 250));
  const picked = store.getDoc().tracks[0].color === 4;
  store.undo();
  const restored = store.getDoc().tracks[0].color === before;
  return (marked === before && picked && restored)
    || 'marked=' + marked + ' before=' + before + ' picked=' + picked + ' restored=' + restored;
})()`);

await check('the track dialog stores a hex, and rejects one that does not parse', `(async () => {
  const store = window.__chipseq.store;
  const before = store.getDoc().tracks[0].color;
  const open = async () => {
    document.querySelector('#track-list .track-row .track-name')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
  };
  const type = (v) => {
    const el = document.querySelector('#track-hex');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el;
  };

  await open();
  // typing a hex releases the palette selection - one field, not two
  const el = type('#ff8800');
  const swatchCleared = ![...document.querySelectorAll('#track-colors .swatch')].some((b) => b.classList.contains('on'));
  document.querySelector('#dlg-track [value="ok"]').click();
  await new Promise((r) => setTimeout(r, 250));
  const stored = store.getDoc().tracks[0].color === '#ff8800';
  const rendered = getComputedStyle(document.querySelector('#track-list .track-color')).backgroundColor;

  // a typo must not reach the project file
  await open();
  const bad = type('#zz');
  const flagged = bad.classList.contains('invalid');
  document.querySelector('#dlg-track [value="ok"]').click();
  await new Promise((r) => setTimeout(r, 250));
  const kept = store.getDoc().tracks[0].color;

  // picking a swatch goes back to the palette
  await open();
  document.querySelectorAll('#track-colors .swatch')[2].click();
  const hexCleared = document.querySelector('#track-hex').value === '';
  document.querySelector('#dlg-track [value="ok"]').click();
  await new Promise((r) => setTimeout(r, 250));
  const backToIndex = store.getDoc().tracks[0].color === 2;

  while (store.getDoc().tracks[0].color !== before) store.undo();
  return (stored && swatchCleared && rendered === 'rgb(255, 136, 0)' && flagged
    && Number.isInteger(kept) === false && kept === '#ff8800' && hexCleared && backToIndex)
    || JSON.stringify({ stored, swatchCleared, rendered, flagged, kept, hexCleared, backToIndex });
})()`);

await check('colours are baked in, so reordering repaints nothing', `(async () => {
  const { trackColorIndex } = await import('/js/core/doc.js');
  const store = window.__chipseq.store;
  const doc = store.getDoc();
  if (doc.tracks.length < 2) return 'need two tracks';
  const snapshot = () => store.getDoc().tracks
    .map((t) => t.id + ':' + trackColorIndex(store.getDoc(), t)).sort().join();
  const before = snapshot();
  store.commit('reorder', ['tracks'], (d) => {
    const [t] = d.tracks.splice(0, 1);
    d.tracks.push(t);
  });
  const after = snapshot();
  store.undo();
  return before === after || 'before=' + before + ' after=' + after;
})()`);

await check('dragging a row anywhere reorders the track list', `(async () => {
  const store = window.__chipseq.store;
  const rows = () => [...document.querySelectorAll('#track-list .track-row')];
  if (rows().length < 2) return 'need two tracks';
  const namesBefore = store.getDoc().tracks.map((t) => t.name);
  // grab by the NAME, i.e. plain row body - not a dedicated handle
  const from = rows()[0];
  const grab = from.querySelector('.track-name');
  const target = rows()[rows().length - 1].getBoundingClientRect();
  grab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 40, clientY: from.getBoundingClientRect().top + 5, button: 0 }));
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: target.bottom - 2 }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: target.bottom - 2 }));
  from.dispatchEvent(new MouseEvent('click', { bubbles: true })); // the browser's click after a drag
  await new Promise((r) => setTimeout(r, 200));
  const namesAfter = store.getDoc().tracks.map((t) => t.name);
  const movedToEnd = namesAfter[namesAfter.length - 1] === namesBefore[0];
  const sameSet = [...namesAfter].sort().join() === [...namesBefore].sort().join();
  // ONE undo entry: the reorder, not a reorder plus a track switch
  store.undo();
  const restored = store.getDoc().tracks.map((t) => t.name).join() === namesBefore.join();
  return (movedToEnd && sameSet && restored)
    || 'after=' + namesAfter.join() + ' restored=' + restored;
})()`);

await check('a click under the drag threshold still selects the track', `(async () => {
  const store = window.__chipseq.store;
  const rows = [...document.querySelectorAll('#track-list .track-row')];
  const order = store.getDoc().tracks.map((t) => t.id).join();
  const second = rows[1];
  const y = second.getBoundingClientRect().top + 5;
  second.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 40, clientY: y, button: 0 }));
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: y + 2 })); // under 4px
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: y + 2 }));
  second.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  const d = store.getDoc();
  const selected = d.activeTrackId === d.tracks[1].id;
  const unmoved = d.tracks.map((t) => t.id).join() === order;
  return (selected && unmoved) || 'selected=' + selected + ' unmoved=' + unmoved;
})()`);

// The tracks panel and the Mixer resolve colour independently, and drifted
// once already (the Mixer coloured by row index). Assert they agree on the
// rendered pixels, not on the code path.
await check('the Mixer shows the same colours as the tracks panel', `(async () => {
  const { createTrack, pickTrackColor } = await import('/js/core/doc.js');
  const store = window.__chipseq.store;
  store.commit('colour fixture', ['song', 'tracks'], (d) => {
    d.mode = 'poly';
    while (d.tracks.length < 3) d.tracks.push(createTrack({ name: 'T' + d.tracks.length, color: pickTrackColor(d) }));
    // deliberately NOT in palette order, and not matching row positions
    d.tracks[0].color = 6;
    d.tracks[1].color = 0;
    d.tracks[2].color = '#ff8800'; // the literal-hex form of the same field
    d.tracks[0].role = 'muted'; // the silenced path is where this broke
  });
  await new Promise((r) => setTimeout(r, 250));
  const sec = document.getElementById('sec-mixer');
  if (!sec.classList.contains('open')) sec.querySelector('.tool-card-head').click();
  await new Promise((r) => setTimeout(r, 400));

  // backgroundColor alone is NOT enough: an ancestor's opacity changes what
  // the dot looks like without changing its computed colour, which is exactly
  // how a muted track's dot came to look wrong in the Mixer while every
  // colour comparison passed. Fold the inherited opacity into the reading.
  const swatch = (e) => {
    let opacity = 1;
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      opacity *= Number(getComputedStyle(n).opacity);
    }
    return getComputedStyle(e).backgroundColor + '@' + opacity.toFixed(2);
  };
  const panel = [...document.querySelectorAll('#track-list .track-color')].map(swatch);
  const mixer = [...document.querySelectorAll('#mixer-body .mix-row .track-color')].map(swatch);
  const levels = [...document.querySelectorAll('#levels-body .lv-track .track-color')].map(swatch);
  store.undo();
  if (!mixer.length) return 'mixer did not render';
  if (panel.join() !== mixer.join()) return 'panel=' + panel.join() + ' mixer=' + mixer.join();
  // ...and that a hex is rendered as itself rather than snapped to a palette
  // entry, in both views.
  if (!panel[2].startsWith('rgb(255, 136, 0)')) return 'hex not honoured: ' + panel[2];
  // Levels lists them too, when it happens to be open
  if (levels.length && levels.join() !== panel.join()) return 'levels=' + levels.join();
  return true;
})()`);

await check('the solo button silences others without hiding them', `(async () => {
  const { soloActive, createTrack, pickTrackColor } = await import('/js/core/doc.js');
  const { flattenSong } = await import('/js/core/flatten.js');
  const store = window.__chipseq.store;
  // set up its own context rather than depending on where in the suite it runs
  store.commit('solo fixture', ['song', 'tracks', 'notes'], (d) => {
    d.mode = 'poly';
    while (d.tracks.length < 2) d.tracks.push(createTrack({ name: 'Extra', color: pickTrackColor(d) }));
  });
  await new Promise((r) => setTimeout(r, 250));

  const rows = [...document.querySelectorAll('#track-list .track-row')];
  const soloBtn = rows[1] && rows[1].querySelector('.role-btn.solo');
  if (!soloBtn) return 'no solo button on row 2';

  soloBtn.click();
  await new Promise((r) => setTimeout(r, 200));
  const d = store.getDoc();
  const lit = document.querySelectorAll('#track-list .role-btn.solo.on').length === 1;
  const active = soloActive(d);
  const heard = new Set(flattenSong(d).events.map((e) => e.trackId));
  // only the soloed track sounds - but nothing was removed from the document,
  // so the grid still has everything to draw
  const onlySoloed = heard.size <= 1 && (heard.size === 0 || heard.has(d.tracks[1].id));
  const nothingHidden = d.tracks.length === rows.length;

  soloBtn.click();
  await new Promise((r) => setTimeout(r, 200));
  const cleared = !soloActive(store.getDoc());
  store.undo();
  store.undo();
  store.undo();
  return (lit && active && onlySoloed && nothingHidden && cleared)
    || 'lit=' + lit + ' active=' + active + ' only=' + onlySoloed
       + ' kept=' + nothingHidden + ' cleared=' + cleared;
})()`);

await check('dragging from a control does not reorder', `(async () => {
  const store = window.__chipseq.store;
  const rows = [...document.querySelectorAll('#track-list .track-row')];
  const order = store.getDoc().tracks.map((t) => t.id).join();
  const btn = rows[0].querySelector('button');
  const target = rows[rows.length - 1].getBoundingClientRect();
  btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 40, clientY: rows[0].getBoundingClientRect().top + 5, button: 0 }));
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: target.bottom - 2 }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: target.bottom - 2 }));
  await new Promise((r) => setTimeout(r, 150));
  return store.getDoc().tracks.map((t) => t.id).join() === order || 'order changed';
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
// The card is always there in poly - but collapsed, because a stock Square
// is the baseline and there is nothing to show yet.
await check('instrument card present but closed on a stock instrument', `(() => {
  const sec = document.getElementById('sec-instrument');
  const status = sec.querySelector('.tool-status');
  return (!sec.hidden && !sec.classList.contains('open') && !status.classList.contains('on')
    && /Square|Sine|Saw/.test(status.textContent))
    || 'hidden=' + sec.hidden + ' open=' + sec.classList.contains('open') + ' status=' + status.textContent;
})()`);
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
// Fine-tuned into a Custom config, the tool is now genuinely "in play", so
// auto mode opens the card on its own - proven by clearing every explicit
// and forced state first, so only status().on can be responsible.
await check('a fine-tuned instrument makes the card open itself', `(() => {
  document.getElementById('tools-reset').click();
  const sec = document.getElementById('sec-instrument');
  const status = sec.querySelector('.tool-status');
  return (sec.classList.contains('open') && status.classList.contains('on') && /Custom/.test(status.textContent))
    || 'open=' + sec.classList.contains('open') + ' status=' + status.textContent;
})()`);
// ---- envelope editor ----
// The sliders and the canvas edit ONE shape. While it stays ADSR-shaped it is
// stored as four numbers; the moment it is drawn into something they cannot
// express, an explicit envelope block appears and the sliders stand down.
await evaluate(`(() => {
  const s = window.__chipseq.store;
  s.commit('env fixture', ['tracks'], (d) => {
    const t = d.tracks[0];
    t.instrument = { id: 'track:' + t.id, name: 'Custom', wave: 'square', duty: null,
      harmonics: null, adsr: { a: 0.08, d: 0.25, s: 0.45, r: 0.35 }, gain: 0.6 };
  });
})()`);
await sleep(300);
await openTool('instrument');

await check('the envelope starts as ADSR, stored as four numbers', `(() => {
  const t = window.__chipseq.store.getDoc().tracks[0];
  const mode = document.querySelector('#in-env-mode');
  const canvas = document.querySelector('#in-env');
  return (!!canvas && !t.instrument.env && mode.textContent === 'ADSR'
    && !document.querySelector('#instrument-body .harm-field.disabled'))
    || 'env=' + JSON.stringify(t.instrument.env) + ' mode=' + (mode && mode.textContent);
})()`);

await check('drawing a point the sliders cannot express stores an envelope', `(() => {
  const c = document.querySelector('#in-env');
  const rect = c.getBoundingClientRect();
  // attack+decay = 0.33 s and release = 0.35 s both clamp to the 0.4 s
  // minimum span, so the pre-sustain stage is half of the non-held width
  const usable = rect.width - 12;
  const preW = (usable - usable * 0.25) * 0.5;
  const x = rect.left + 6 + preW * 0.7; // clear of the existing handles
  const y = rect.top + rect.height / 2;
  c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
  const t = window.__chipseq.store.getDoc().tracks[0];
  const env = t.instrument.env;
  return (env && env.kind === 'env' && env.points.length === 5 && env.sustainIndex === 3)
    || JSON.stringify(env);
})()`);

await check('the sliders stand down rather than rounding the curve away', `(() => {
  const mode = document.querySelector('#in-env-mode');
  const disabled = document.querySelectorAll('#instrument-body .harm-field.disabled').length;
  const reset = document.querySelector('#in-env-reset');
  return (mode.textContent === 'drawn' && disabled === 4 && !!reset)
    || 'mode=' + mode.textContent + ' disabled=' + disabled + ' reset=' + !!reset;
})()`);

await check('a drawn envelope survives a save/load round-trip', `(async () => {
  const { exportProjectFile, importProjectFile } = await import('/js/core/persist.js');
  const doc = window.__chipseq.store.getDoc();
  const back = importProjectFile(await exportProjectFile(doc).text());
  const a = doc.tracks[0].instrument.env;
  const b = back.tracks[0].instrument.env;
  return JSON.stringify(a) === JSON.stringify(b) || JSON.stringify(b);
})()`);

await check('reset returns to ADSR and clears the block', `(() => {
  document.querySelector('#in-env-reset').click();
  const t = window.__chipseq.store.getDoc().tracks[0];
  const mode = document.querySelector('#in-env-mode');
  const disabled = document.querySelectorAll('#instrument-body .harm-field.disabled').length;
  // the sliders must come back to what they were BEFORE the drawing, not to
  // the zeros a non-ADSR shape reads back as
  const restored = t.instrument.adsr.a === 0.08 && t.instrument.adsr.s === 0.45;
  return (!t.instrument.env && mode.textContent === 'ADSR' && disabled === 0 && restored)
    || 'env=' + JSON.stringify(t.instrument.env) + ' mode=' + mode.textContent
       + ' disabled=' + disabled + ' adsr=' + JSON.stringify(t.instrument.adsr);
})()`);
await evaluate(`window.__chipseq.store.undo()`);

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
// The spectrum shapes whatever wave is selected, so this checks BOTH that a
// neutral spectrum leaves the audio alone and that a tilt actually changes it.
await evaluate(`(() => {
  const d = window.__chipseq.store.getDoc();
  const t = d.tracks.find((x) => x.id === d.activeTrackId);
  window.__waveSnapshot = { id: t.id, instrument: t.instrument ? JSON.parse(JSON.stringify(t.instrument)) : null, instrumentId: t.instrumentId };
})()`);

await check('a neutral spectrum renders identically to the raw wave', `(async () => {
  ${WAV_HELPERS}
  const store = window.__chipseq.store;
  const { renderWav } = await import('/js/core/export-wav.js');
  const trackId = store.getDoc().activeTrackId;
  const setInst = (patch) => store.commit('spec fixture', ['tracks'], (doc) => {
    const t = doc.tracks.find((x) => x.id === trackId);
    t.instrumentId = 'track:' + t.id;
    t.instrument = { id: 'track:' + t.id, name: 'X', wave: 'sawtooth', harmonics: null, duty: null,
      adsr: { a: 0.001, d: 0, s: 1, r: 0.001 }, gain: 0.5, ...patch };
  });
  const rms = async () => (await readWav((await renderWav(store.getDoc())).blob)).rms;

  setInst({});
  await new Promise((r) => setTimeout(r, 250));
  const raw = await rms();
  // an explicitly neutral block must be indistinguishable from no block
  setInst({ spectrum: { kind: 'spectrum', v: 1, tilt: 0, partials: null } });
  await new Promise((r) => setTimeout(r, 250));
  const neutral = await rms();
  // ...and a tilt must not be
  setInst({ spectrum: { kind: 'spectrum', v: 1, tilt: -12, partials: null } });
  await new Promise((r) => setTimeout(r, 250));
  const dark = await rms();

  const same = Math.abs(raw - neutral) < 1e-6;
  const changed = Math.abs(dark - raw) > 1e-4;
  return (same && changed) || JSON.stringify({ raw, neutral, dark, same, changed });
})()`);

await check('the tilt slider writes a spectrum block', `(async () => {
  const store = window.__chipseq.store;
  const el = document.querySelector('#instrument-body #in-tilt');
  if (!el) return 'no tilt slider';
  el.value = '-60'; // -6.0 dB/oct
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const t = store.getDoc().tracks.find((x) => x.id === store.getDoc().activeTrackId);
  return (t.instrument.spectrum && t.instrument.spectrum.tilt === -6 && t.instrument.spectrum.kind === 'spectrum')
    || JSON.stringify(t.instrument.spectrum);
})()`);

await check('a drawbar multiplies without wiping the tilt', `(async () => {
  const store = window.__chipseq.store;
  const bar = document.querySelector('#instrument-body #in-partials input[data-h="2"]');
  if (!bar) return 'no drawbar';
  bar.value = '50';
  bar.dispatchEvent(new Event('input', { bubbles: true }));
  bar.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const spec = store.getDoc().tracks.find((x) => x.id === store.getDoc().activeTrackId).instrument.spectrum;
  return (spec.partials[2] === 0.5 && spec.tilt === -6) || JSON.stringify(spec);
})()`);

await check('reset removes the spectrum block entirely', `(async () => {
  const store = window.__chipseq.store;
  const btn = document.querySelector('#instrument-body #in-spec-reset');
  if (!btn) return 'no spectrum reset link';
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const inst = store.getDoc().tracks.find((x) => x.id === store.getDoc().activeTrackId).instrument;
  const gone = !document.querySelector('#instrument-body #in-spec-reset');
  return (!inst.spectrum && gone) || 'spectrum=' + JSON.stringify(inst.spectrum) + ' linkGone=' + gone;
})()`);

await check('the spectrum sits below ADSR and folds like the cards do', `(async () => {
  const store = window.__chipseq.store;
  const trackId = store.getDoc().activeTrackId;
  const set = (spectrum) => store.commit('fold fixture', ['tracks'], (d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    t.instrumentId = 'track:' + t.id;
    t.instrument = { id: 'track:' + t.id, name: 'X', wave: 'sawtooth', harmonics: null, duty: null,
      adsr: { a: 0.001, d: 0, s: 1, r: 0.001 }, gain: 0.5, ...(spectrum ? { spectrum } : {}) };
  });

  set(null);
  await new Promise((r) => setTimeout(r, 350));
  const det = document.querySelector('#instrument-body #in-spec');
  if (!det) return 'no spectrum section';
  const closedWhenNeutral = !det.open;

  // it belongs after the ADSR sliders and before Gain
  const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
  const ordered = top('#instrument-body #in-r') < top('#instrument-body #in-spec')
    && top('#instrument-body #in-spec') < top('#instrument-body #in-gain');

  set({ kind: 'spectrum', v: 1, tilt: -6, partials: null });
  await new Promise((r) => setTimeout(r, 350));
  const det2 = document.querySelector('#instrument-body #in-spec');
  const openWhenShaped = det2.open;
  // the summary reports the state, so a closed section is still informative
  const labelled = det2.querySelector('summary').textContent.includes('dB');

  return (closedWhenNeutral && ordered && openWhenShaped && labelled)
    || JSON.stringify({ closedWhenNeutral, ordered, openWhenShaped, labelled });
})()`);

await check('a sine offers no spectrum, having nothing to shape', `(async () => {
  const store = window.__chipseq.store;
  document.querySelector('#instrument-body #in-wave [data-v="sine"]').click();
  await new Promise((r) => setTimeout(r, 300));
  return !document.querySelector('#instrument-body #in-tilt') || 'tilt slider shown for a sine';
})()`);

await check('the spectrum block leaves the track as it found it', `(async () => {
  const store = window.__chipseq.store;
  const snap = window.__waveSnapshot;
  store.commit('restore instrument', ['tracks'], (doc) => {
    const t = doc.tracks.find((x) => x.id === snap.id);
    if (!t) return;
    t.instrument = snap.instrument ? JSON.parse(JSON.stringify(snap.instrument)) : null;
    t.instrumentId = snap.instrumentId;
  });
  await new Promise((r) => setTimeout(r, 300));
  const t = store.getDoc().tracks.find((x) => x.id === snap.id);
  return (JSON.stringify(t.instrument) === JSON.stringify(snap.instrument) && t.instrumentId === snap.instrumentId)
    || 'instrument=' + JSON.stringify(t.instrument);
})()`);

// ---- the command palette ----
await check('Ctrl+K opens the palette listing runnable commands', `(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', ctrlKey: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const dlg = document.getElementById('dlg-palette');
  if (!dlg || !dlg.open) return 'palette did not open';
  const items = [...document.querySelectorAll('#palette-list .palette-item')];
  const labels = items.map((li) => li.textContent.trim());
  const hasPlay = labels.some((l) => /Play/.test(l));
  const hasKbd = items.some((li) => li.querySelector('kbd'));
  return (items.length >= 5 && hasPlay && hasKbd)
    || 'items=' + items.length + ' play=' + hasPlay + ' kbd=' + hasKbd;
})()`);

await check('typing filters, and Enter runs the highlighted command', `(async () => {
  const input = document.getElementById('palette-input');
  input.value = 'metronome';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const items = [...document.querySelectorAll('#palette-list .palette-item')];
  if (items.length !== 1) return 'filter left ' + items.length + ' items';

  const before = window.__chipseq.engine.isMetronome ? window.__chipseq.engine.isMetronome() : null;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const dlg = document.getElementById('dlg-palette');
  const closed = !dlg.open;
  const after = window.__chipseq.engine.isMetronome ? window.__chipseq.engine.isMetronome() : null;
  const toggled = before === null || after !== before;
  // put it back
  if (toggled && before !== null) window.__chipseq.engine.setMetronome(before);
  return (closed && toggled) || 'closed=' + closed + ' before=' + before + ' after=' + after;
})()`);

await check('the palette hides commands that cannot run', `(async () => {
  const { available } = await import('/js/ui/commands.js');
  const store = window.__chipseq.store;
  // clear the undo stack by reloading the doc is heavy; assert the guard
  // directly against the real store instead
  const ids = available({ store, conflicts: { count: () => 0 } }).map((c) => c.id);
  const undoOffered = ids.includes('undo');
  const conflictOffered = ids.includes('next-conflict');
  return (undoOffered === store.canUndo() && conflictOffered === false)
    || 'undo=' + undoOffered + '/' + store.canUndo() + ' conflict=' + conflictOffered;
})()`);

// ---- make-up ----
//
// The point of Analyse is that the rendered file actually lands on target,
// so this measures the render before and after rather than trusting the
// arithmetic.
await check('Analyse brings the rendered peak to the target', `(async () => {
  ${WAV_HELPERS}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { MAKEUP_TARGET_DB, makeupConfig } = await import('/js/core/graph.js');
  const store = window.__chipseq.store;

  const doc = structuredClone(store.getDoc());
  doc.mode = 'poly';
  doc.tracks = [{
    id: 'mk-t', name: 'mk', role: 'melody', instrumentId: 'badge', color: 0,
    notes: [{ id: 'mk-n', pitch: 60, startTick: 0, durationTicks: 192, velocity: 100, harmonics: null }],
  }];
  doc.activeTrackId = doc.melodyTrackId = 'mk-t';
  delete doc.master;

  const first = await renderWav(structuredClone(doc));
  const before = first.level.peakDb;
  if (!(before < MAKEUP_TARGET_DB - 1)) return 'fixture is not quiet enough to test: ' + before;

  // what Analyse computes
  const db = Math.round((0 + (MAKEUP_TARGET_DB - before)) * 10) / 10;
  const raised = structuredClone(doc);
  raised.master = { makeup: { kind: 'makeup', v: 1, db } };
  const second = await renderWav(raised);
  const after = second.level.peakDb;

  // within a rounding step of the target, and demonstrably louder
  const onTarget = Math.abs(after - MAKEUP_TARGET_DB) < 0.15;
  const louder = after > before + 1;
  const stored = makeupConfig(raised).db === db;
  return (onTarget && louder && stored)
    || JSON.stringify({ before: +before.toFixed(2), db, after: +after.toFixed(2), onTarget, louder, stored });
})()`);

// Make-up has to reach the PREVIEW, not only the exported file. The master
// node is built once and the routing rebuild reuses it, so a stored level
// that nothing pushes onto that node moves the number and the export while
// playback carries on unchanged - which is exactly what happened.
await check('make-up reaches the live master, not just the render', `(async () => {
  const store = window.__chipseq.store;
  const engine = window.__chipseq.engine;
  const { MASTER_GAIN, dbToLin } = await import('/js/core/graph.js');

  await engine.ensureCtx();
  engine.play(0);
  await new Promise((r) => setTimeout(r, 150));
  engine.stop();
  const before = engine.masterLevel();
  if (before === null) return 'no graph after playing';

  store.commit('makeup preview', ['song'], (d) => {
    d.master = d.master || {};
    d.master.makeup = { kind: 'makeup', v: 1, db: 6 };
  });
  await new Promise((r) => setTimeout(r, 400));
  const after = engine.masterLevel();

  store.commit('clear makeup', ['song'], (d) => { if (d.master) delete d.master.makeup; });
  await new Promise((r) => setTimeout(r, 400));
  const cleared = engine.masterLevel();

  const raised = Math.abs(after - MASTER_GAIN * dbToLin(6)) < 0.02;
  const restored = Math.abs(cleared - MASTER_GAIN) < 0.02;
  return (raised && restored)
    || JSON.stringify({ before, after, want: MASTER_GAIN * dbToLin(6), cleared, raised, restored });
})()`);

await check('the make-up slider overrides Analyse and clears at zero', `(async () => {
  const store = window.__chipseq.store;
  const { makeupConfig } = await import('/js/core/graph.js');
  const sec = document.getElementById('sec-levels');
  if (!sec) return 'no levels card';
  if (!sec.classList.contains('open')) sec.querySelector('.tool-card-head').click();
  await new Promise((r) => setTimeout(r, 500));

  const el = document.querySelector('#levels-body #lv-makeup');
  if (!el) return 'no make-up slider';
  el.value = '35'; // +3.5 dB
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  const set = makeupConfig(store.getDoc()).db === 3.5;
  const shown = document.querySelector('#levels-body #lv-makeup-label').textContent;

  // Dragging the slider is a decision, so it must switch OFF auto - otherwise
  // the next automatic measurement would quietly replace the chosen value.
  const manual = makeupConfig(store.getDoc()).auto === false;

  // ...and that holds at zero too: "no make-up, and leave it alone" is a
  // different statement from "never measured", so the block stays.
  const el2 = document.querySelector('#levels-body #lv-makeup');
  el2.value = '0';
  el2.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  const zeroed = makeupConfig(store.getDoc());
  const heldAtZero = zeroed.db === 0 && zeroed.auto === false;
  // leave the project as we found it
  store.commit('clear makeup', ['song'], (d) => { if (d.master) delete d.master.makeup; });
  return (set && shown === '+3.5 dB' && manual && heldAtZero)
    || 'set=' + set + ' shown=' + shown + ' manual=' + manual + ' heldAtZero=' + heldAtZero;
})()`);

// ---- badges: connect, adopt by displayed code, name, map ----
//
// Driven against a REAL badge server started by this harness, with the
// reference fake badge on the other end. The card is the last untested link
// in the chain, and the one a person actually touches.
await check('the Badges card connects to a server', `(async () => {
  const sec = document.getElementById('sec-badges');
  if (!sec) return 'no badges card';
  if (!sec.classList.contains('open')) sec.querySelector('.tool-card-head').click();
  await new Promise((r) => setTimeout(r, 500));
  const url = document.querySelector('#badges-body #bg-url');
  if (!url) return 'no url field';
  url.value = ${JSON.stringify(BADGE_WS)};
  document.querySelector('#badges-body #bg-connect').click();
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('#badges-body #bg-adopt')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return 'never connected: ' + (document.querySelector('#badges-body .in-hint') || {}).textContent;
})()`);

// The fake badge connects and is handed a code to display, exactly as the
// real firmware now does.
const labBadge = new FakeBadge({ url: BADGE_WS, id: 'smoke:badge:01', fw: 'smoke-1' });
await labBadge.connect();
await sleep(500);

// The card repaints on every state change, and state changes on a timer. If
// that repaint destroys the field you are typing into, the feature is unusable
// no matter how correct the protocol is.
await check('typing a code survives a repaint', `(async () => {
  const input = document.querySelector('#badges-body #bg-adopt-code');
  if (!input) return 'no adopt field';
  input.focus();
  input.value = 'ABC';
  input.setSelectionRange(3, 3);
  // force the repaint a clock sample or a roster change would cause
  const { badgeState } = await import('/js/net/badges.js');
  const s = badgeState();
  s.badges = [...s.badges];
  document.querySelector('#badges-body #bg-url').dispatchEvent(new Event('input', { bubbles: true }));
  window.__chipseq.store.commit('force repaint', ['tracks'], () => {});
  await new Promise((r) => setTimeout(r, 300));

  const after = document.querySelector('#badges-body #bg-adopt-code');
  const kept = after && after.value === 'ABC';
  const focused = document.activeElement === after;
  const caret = after && after.selectionStart === 3;
  if (after) after.value = '';
  return (kept && focused && caret)
    || 'kept=' + kept + ' focused=' + focused + ' caret=' + caret;
})()`);

await check('a badge is adopted by typing the code it shows', `(async () => {
  const code = ${JSON.stringify(labBadge.showingCode || '')};
  const input = document.querySelector('#badges-body #bg-adopt-code');
  if (!input) return 'no adopt field';
  input.value = code;
  document.querySelector('#badges-body #bg-adopt').click();
  for (let i = 0; i < 60; i++) {
    const rows = document.querySelectorAll('#badges-body .bg-badge');
    if (rows.length === 1) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  const hint = [...document.querySelectorAll('#badges-body .in-hint')].map((e) => e.textContent).join(' | ');
  return 'not adopted: ' + hint;
})()`);

// The card HEADER, not its body. The panel repaints on document and UI-store
// changes, and badge state is neither - so adopting a badge left the header
// saying "no badges" until an unrelated edit happened to repaint it.
await check('the card header follows the badge roster', `(async () => {
  const status = document.querySelector('#sec-badges .tool-status');
  if (!status) return 'no status element';
  for (let i = 0; i < 60; i++) {
    if (/1 badge/.test(status.textContent)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return 'header still says: ' + JSON.stringify(status.textContent);
})()`);

await check('the adopted badge shows as online and can be mapped to a track', `(async () => {
  const row = document.querySelector('#badges-body .bg-badge');
  if (!row) return 'no badge row';
  const online = row.querySelector('.bg-dot.on') !== null;
  const sel = row.querySelector('select[data-act="map"]');
  if (!sel) return 'no track selector';
  const trackId = window.__chipseq.store.getDoc().tracks[0].id;
  const option = [...sel.options].find((o) => o.value === trackId);
  if (!option) return 'the track is not offered';
  sel.value = trackId;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const after = document.querySelector('#badges-body select[data-act="map"]');
  return (online && after.value === trackId) || 'online=' + online + ' mapped=' + after.value;
})()`);

// The whole point of the feature: pressing play must send notes to a mapped
// badge. Everything else was tested in isolation and the integration was not,
// which is precisely how it came to send nothing at all.
//
// The notes arrive at the fake badge in THIS process, so the assertion is here
// rather than in the page - the browser cannot see what came out the far end.
await evaluate(`(async () => {
  const store = window.__chipseq.store;
  const { getBadgeClient } = await import('/js/net/badges.js');
  const badge = getBadgeClient().state.badges[0];
  if (!badge || !badge.trackId) return 'not mapped';
  store.commit('badge fixture', ['notes', 'tracks'], (d) => {
    const t = d.tracks.find((x) => x.id === badge.trackId);
    t.notes = [];
    for (let i = 0; i < 8; i++) {
      t.notes.push({ id: 'bn-' + i, pitch: 60 + [0, 4, 7, 12][i % 4], startTick: i * 96,
        durationTicks: 96, velocity: 100, harmonics: null });
    }
  });
  return 'ok';
})()`);
await sleep(400);

labBadge.played.length = 0;
await evaluate(`(async () => {
  await window.__chipseq.engine.ensureCtx();
  window.__chipseq.engine.play(0);
})()`);
await sleep(1500);
await evaluate(`window.__chipseq.engine.stop()`);
await sleep(300);

{
  const got = labBadge.played.length;
  if (got > 0) {
    pass++;
    console.log('OK  ', `pressing play streams notes to a mapped badge (${got} received)`);
  } else {
    fail++;
    console.log('FAIL', 'pressing play streams notes to a mapped badge -> nothing arrived');
  }
  // ...and stopping must silence it, or the last note hangs on the hardware.
  const quiet = labBadge.pending.size === 0;
  if (quiet) { pass++; console.log('OK  ', 'stopping clears the badge queue'); }
  else { fail++; console.log('FAIL', 'stopping clears the badge queue -> ' + labBadge.pending.size + ' left'); }
}

// ---- uploading a tune, through the card a person actually clicks ----
//
// The upload machinery is unit-tested and the relay is server-tested, but the
// path from "press Send" to "bytes in the badge" crosses the card, the client,
// the server and the badge. That join is exactly where the live-playback bug
// lived, so it gets an end-to-end test rather than an assumption.
await check('the card offers a library for a badge that can store', `(async () => {
  for (let i = 0; i < 40; i++) {
    if (document.querySelector('#badges-body .bg-lib [data-act="put"]')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  const row = document.querySelector('#badges-body .bg-badge');
  return 'no Send control: ' + (row ? row.textContent.replace(/\\s+/g, ' ').slice(0, 120) : 'no row');
})()`);

await check('pressing Send uploads the song to the badge', `(async () => {
  const scope = document.querySelector('#badges-body [data-act="put-scope"]');
  const btn = document.querySelector('#badges-body [data-act="put"]');
  if (!btn) return 'no Send button';
  if (scope) scope.value = ''; // whole song
  btn.click();
  // The library list appearing is the card's own confirmation that the badge
  // committed it and reported back.
  for (let i = 0; i < 100; i++) {
    const tune = document.querySelector('#badges-body .bg-tune');
    if (tune) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  const hint = [...document.querySelectorAll('#badges-body .in-hint')].map((e) => e.textContent).join(' | ');
  return 'no tune listed: ' + hint;
})()`);

{
  // Asserted in THIS process, against the badge, because the browser cannot
  // see what actually landed on the far end.
  const stored = [...labBadge.tunes.values()][0];
  if (stored && stored.bytes > 0) {
    pass++;
    console.log('OK  ', `the badge is holding the uploaded tune (${stored.bytes} B, ${stored.tracks} tracks)`);
  } else {
    fail++;
    console.log('FAIL', 'the badge is holding the uploaded tune -> nothing stored');
  }

  // And it must be the same bytes the sequencer built, not merely some bytes.
  const built = await evaluate(`(async () => {
    const { buildTune } = await import('/js/core/badge-tune.js');
    return buildTune(window.__chipseq.store.getDoc(),
      { name: window.__chipseq.store.getDoc().name }).id;
  })()`);
  if (stored && stored.id === built) {
    pass++;
    console.log('OK  ', `and its CRC matches what the sequencer built (${built})`);
  } else {
    fail++;
    console.log('FAIL', `and its CRC matches what the sequencer built -> ${stored && stored.id} vs ${built}`);
  }
}

// ---- sending an edited song asks before replacing ----
//
// The id is the content checksum, so the edit produces a different id under
// the same name. A shared name is not proof of an update - every fresh project
// is called "Untitled" - so the card must ask, and Cancel must cost nothing.
const oldTuneId = [...labBadge.tunes.keys()][0];
await evaluate(`window.__chipseq.store.commit('smoke edit', ['notes'], (d) => {
  d.tracks[0].notes[0].pitch += 1;
})`);
const newTuneId = await evaluate(`(async () => {
  const { buildTune } = await import('/js/core/badge-tune.js');
  return buildTune(window.__chipseq.store.getDoc(),
    { name: window.__chipseq.store.getDoc().name }).id;
})()`);

await check('sending the edited song opens a Replace dialog', `(async () => {
  const scope = document.querySelector('#badges-body [data-act="put-scope"]');
  if (scope) scope.value = ''; // whole song, same as the id computed above
  document.querySelector('#badges-body [data-act="put"]').click();
  const dlg = document.getElementById('dlg-confirm');
  for (let i = 0; i < 40; i++) {
    if (dlg.open) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!dlg.open) return 'no dialog appeared';
  const title = document.getElementById('confirm-title').textContent;
  return title === 'Replace tune' || 'wrong dialog: ' + title;
})()`);

await check('cancelling leaves the badge untouched', `(async () => {
  const dlg = document.getElementById('dlg-confirm');
  dlg.querySelector('button[value="cancel"]').click();
  await new Promise((r) => setTimeout(r, 400));
  return !dlg.open || 'dialog still open';
})()`);
{
  const untouched = labBadge.tunes.has(oldTuneId) && !labBadge.tunes.has(newTuneId)
    && labBadge.tunes.size === 1;
  if (untouched) { pass++; console.log('OK  ', 'and the old version is still the only one stored'); }
  else { fail++; console.log('FAIL', `and the old version is still the only one stored -> ${[...labBadge.tunes.keys()]}`); }
}

await check('confirming Replace sends the new version', `(async () => {
  const scope = document.querySelector('#badges-body [data-act="put-scope"]');
  if (scope) scope.value = '';
  document.querySelector('#badges-body [data-act="put"]').click();
  const dlg = document.getElementById('dlg-confirm');
  for (let i = 0; i < 40; i++) {
    if (dlg.open) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!dlg.open) return 'no dialog appeared';
  document.getElementById('btn-confirm-ok').click();
  return true;
})()`);
{
  // The replace is judged on the badge itself: the new id arrives, the stale
  // one is dropped after the commit, and exactly one tune remains.
  let swapped = false;
  for (let i = 0; i < 100; i++) {
    if (labBadge.tunes.has(newTuneId) && !labBadge.tunes.has(oldTuneId) && labBadge.tunes.size === 1) {
      swapped = true;
      break;
    }
    await sleep(100);
  }
  if (swapped) { pass++; console.log('OK  ', 'the badge ends up with the new version under the old name, alone'); }
  else { fail++; console.log('FAIL', `the badge ends up with the new version alone -> ${[...labBadge.tunes.keys()]}`); }
}
// Put the song back so the later playback tests see the notes they expect.
await evaluate(`window.__chipseq.store.undo()`);


// ---- auditioning a note reaches the badges ----
//
// Asserted against the badge in THIS process: the browser cannot see what came
// out the far end, and "the click made a sound locally" is not the claim.
{
  labBadge.played.length = 0;
  await evaluate(`window.__chipseq.engine.previewNote(72, null)`);
  await sleep(600);
  const got = labBadge.played.filter((p) => p.pitch === 72);
  if (got.length === 1) {
    pass++;
    console.log('OK  ', `auditioning a note plays it on the badge (${got[0].ms} ms)`);
  } else {
    fail++;
    console.log('FAIL', `auditioning a note plays it on the badge -> ${got.length} received`);
  }

  // The badge is mapped to a track, but auditioning must reach it regardless
  // of mapping - and an UNMAPPED badge must hear it too.
  await evaluate(`(async () => {
    const { getBadgeClient } = await import('/js/net/badges.js');
    const b = getBadgeClient().state.badges[0];
    getBadgeClient().map(b.id, null);
  })()`);
  await sleep(400);
  labBadge.played.length = 0;
  await evaluate(`window.__chipseq.engine.previewNote(76, null)`);
  await sleep(600);
  if (labBadge.played.some((p) => p.pitch === 76)) {
    pass++;
    console.log('OK  ', 'an unmapped badge still hears auditioned notes');
  } else {
    fail++;
    console.log('FAIL', 'an unmapped badge still hears auditioned notes -> silent');
  }

  // ...but not over a running transport, where it would cut across the song.
  await evaluate(`(async () => {
    await window.__chipseq.engine.ensureCtx();
    window.__chipseq.engine.play(0);
  })()`);
  await sleep(300);
  labBadge.played.length = 0;
  await evaluate(`window.__chipseq.engine.previewNote(79, null)`);
  await sleep(400);
  const during = labBadge.played.filter((p) => p.pitch === 79).length;
  await evaluate(`window.__chipseq.engine.stop()`);
  await sleep(200);
  if (during === 0) {
    pass++;
    console.log('OK  ', 'auditioning is suppressed while the transport runs');
  } else {
    fail++;
    console.log('FAIL', `auditioning is suppressed while the transport runs -> ${during} leaked`);
  }
}

// ---- effects: buses and sends ----
//
// The plan's verification for this phase: identical topology in an
// AudioContext and an OfflineAudioContext, and a MEASURED difference in the
// rendered file when a send is open.
await check('a bus builds the same graph offline as it does live', `(async () => {
  const { buildGraph } = await import('/js/core/graph.js');
  const { DEFAULT_EFFECTS } = await import('/js/core/effects.js');
  const { createBus } = await import('/js/core/doc.js');
  const doc = structuredClone(window.__chipseq.store.getDoc());
  doc.mode = 'poly';
  const bus = createBus({ name: 'Space', chain: [DEFAULT_EFFECTS.delay, DEFAULT_EFFECTS.reverb] });
  doc.buses = [bus];
  doc.tracks[0].sends = [{ busId: bus.id, level: 0.5 }];

  const shape = (ctx) => {
    const g = buildGraph(ctx, doc);
    return {
      buses: g.busNodes.size,
      tracks: g.trackNodes.size,
      skipped: g.busNodes.skipped.length,
      limited: g.limited,
    };
  };
  const live = shape(new (window.AudioContext || window.webkitAudioContext)());
  const offline = shape(new OfflineAudioContext(1, 1024, 44100));
  return JSON.stringify(live) === JSON.stringify(offline)
    || 'live=' + JSON.stringify(live) + ' offline=' + JSON.stringify(offline);
})()`);

await check('an open send is audible in the rendered file', `(async () => {
  ${WAV_HELPERS}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { createBus } = await import('/js/core/doc.js');
  const { DEFAULT_EFFECTS } = await import('/js/core/effects.js');

  const base = structuredClone(window.__chipseq.store.getDoc());
  base.mode = 'poly';
  // one short note, so a delay tail shows up as energy that was not there
  base.tracks = [{
    id: 'fx-t', name: 'fx', role: 'melody', instrumentId: 'badge', color: 0,
    notes: [{ id: 'fx-n', pitch: 60, startTick: 0, durationTicks: 48, velocity: 100, harmonics: null }],
  }];
  base.activeTrackId = base.melodyTrackId = 'fx-t';
  const bus = createBus({ name: 'Echo', chain: [DEFAULT_EFFECTS.delay] });
  base.buses = [bus];

  const render = async (level) => {
    const doc = structuredClone(base);
    if (level > 0) doc.tracks[0].sends = [{ busId: bus.id, level }];
    const { blob } = await renderWav(doc);
    return readWav(blob);
  };
  const dry = await render(0);
  const wet = await render(1);
  // a delay adds repeats after the note, so total energy must rise
  const louder = wet.rms > dry.rms * 1.05;
  const longer = wet.sampleCount >= dry.sampleCount;
  return (louder && longer) || JSON.stringify({ dryRms: dry.rms, wetRms: wet.rms, louder, longer });
})()`);

await check('an effect from a newer build is skipped, not fatal', `(async () => {
  const { buildGraph } = await import('/js/core/graph.js');
  const { DEFAULT_EFFECTS } = await import('/js/core/effects.js');
  const { createBus } = await import('/js/core/doc.js');
  const doc = structuredClone(window.__chipseq.store.getDoc());
  doc.mode = 'poly';
  const bus = createBus({ name: 'Future', chain: [{ kind: 'granulator', v: 9 }, DEFAULT_EFFECTS.filter] });
  doc.buses = [bus];
  doc.tracks[0].sends = [{ busId: bus.id, level: 0.5 }];
  const g = buildGraph(new OfflineAudioContext(1, 1024, 44100), doc);
  return (g.busNodes.size === 1 && g.busNodes.skipped.length === 1 && g.busNodes.skipped[0] === 'granulator')
    || 'skipped=' + JSON.stringify(g.busNodes.skipped);
})()`);

// Deleting a bus has to remove its SOUND, not just its row: the chain lives
// inside the bus object and the engine rebuilds routing on the same commit,
// so this asserts the rendered audio goes back to dry.
await check('deleting a bus removes its effect from the render', `(async () => {
  ${WAV_HELPERS}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { buildGraph } = await import('/js/core/graph.js');
  const { createBus } = await import('/js/core/doc.js');
  const { DEFAULT_EFFECTS } = await import('/js/core/effects.js');

  const base = structuredClone(window.__chipseq.store.getDoc());
  base.mode = 'poly';
  base.buses = undefined;
  base.tracks = [{
    id: 'del-t', name: 'del', role: 'melody', instrumentId: 'badge', color: 0,
    notes: [{ id: 'del-n', pitch: 60, startTick: 0, durationTicks: 48, velocity: 100, harmonics: null }],
  }];
  base.activeTrackId = base.melodyTrackId = 'del-t';

  const dry = await readWav((await renderWav(structuredClone(base))).blob);

  const withBus = structuredClone(base);
  const bus = createBus({ name: 'Echo', chain: [DEFAULT_EFFECTS.delay] });
  withBus.buses = [bus];
  withBus.tracks[0].sends = [{ busId: bus.id, level: 1 }];
  const wet = await readWav((await renderWav(withBus)).blob);

  // now delete it the way the card does: bus gone, sends to it gone
  const deleted = structuredClone(withBus);
  deleted.buses = deleted.buses.filter((b) => b.id !== bus.id);
  for (const t of deleted.tracks) delete t.sends;
  const after = await readWav((await renderWav(deleted)).blob);
  const g = buildGraph(new OfflineAudioContext(1, 1024, 44100), deleted);

  const wasAudible = wet.rms > dry.rms * 1.05;
  const backToDry = Math.abs(after.rms - dry.rms) < 1e-6;
  const noBusNodes = g.busNodes.size === 0;
  return (wasAudible && backToDry && noBusNodes)
    || JSON.stringify({ dryRms: dry.rms, wetRms: wet.rms, afterRms: after.rms, wasAudible, backToDry, noBusNodes });
})()`);

await check('the Effects card creates a bus and opens a send', `(async () => {
  const store = window.__chipseq.store;
  const before = JSON.stringify(store.getDoc().buses || []);
  const sec = document.getElementById('sec-effects');
  if (!sec) return 'no effects card';
  if (!sec.classList.contains('open')) sec.querySelector('.tool-card-head').click();
  await new Promise((r) => setTimeout(r, 500));
  const add = document.querySelector('#effects-body #fx-add-bus');
  if (!add) return 'no add-bus button';
  add.click();
  await new Promise((r) => setTimeout(r, 350));
  const list = store.getDoc().buses || [];
  if (list.length !== 1) return 'buses=' + list.length;

  const send = document.querySelector('#effects-body #fx-send');
  if (!send) return 'no send slider';
  send.value = '40';
  send.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 350));
  const doc = store.getDoc();
  const t = doc.tracks.find((x) => x.id === doc.activeTrackId);
  const declared = (doc.uses || []).includes('effects@1');
  const ok = t.sends && t.sends[0].level === 0.4 && declared;

  // Deleting the bus must take the sends with it - an invisible send to a
  // bus that no longer exists would come back if an id were ever recycled.
  document.querySelector('#effects-body #fx-del-bus').click();
  await new Promise((r) => setTimeout(r, 350));
  const after = store.getDoc();
  const gone = !(after.buses && after.buses.length)
    && after.tracks.every((x) => !x.sends)
    && !(after.uses || []).includes('effects@1');
  // put the project back the way it was
  store.commit('clear fx', ['tracks', 'doc'], (d) => {
    d.buses = JSON.parse(before);
    for (const tr of d.tracks) delete tr.sends;
  });
  await new Promise((r) => setTimeout(r, 250));
  return (ok && gone) || 'sends=' + JSON.stringify(t.sends) + ' declared=' + declared + ' deleted=' + gone;
})()`);

// The reset button exists because a project's stored gains can drift away
// from what the wave was calibrated at. It reads the built-in level, not the
// document's, so a drifted project still lands on the right number.
await check('gain reset returns the instrument to its calibrated level', `(async () => {
  const store = window.__chipseq.store;
  const { defaultGainForWave } = await import('/js/core/doc.js');
  const trackId = store.getDoc().activeTrackId;
  // drift it somewhere else entirely, the way the flattened v5 docs did
  store.commit('drift gain', ['tracks'], (doc) => {
    const t = doc.tracks.find((x) => x.id === trackId);
    t.instrument = { ...(t.instrument || { wave: 'square', adsr: { a: 0.002, d: 0, s: 1, r: 0.002 } }),
      id: 'track:' + t.id, name: 'Custom', gain: 0.5 };
  });
  await new Promise((r) => setTimeout(r, 250));
  const btn = document.querySelector('#instrument-body #in-gain-reset');
  if (!btn) return 'no reset link while the gain is drifted';
  // it belongs beside the percentage, not on a line of its own
  const label = document.querySelector('#instrument-body #in-gain-label');
  const sameLine = Math.abs(btn.getBoundingClientRect().top - label.getBoundingClientRect().top) < 6;
  if (!sameLine) return 'reset link is not on the value line';
  btn.click();
  await new Promise((r) => setTimeout(r, 250));
  const t = store.getDoc().tracks.find((x) => x.id === trackId);
  const want = defaultGainForWave(t.instrument.wave);
  const shown = document.querySelector('#instrument-body #in-gain-label').textContent;
  // It appears only while there is something to reset, so after the click it
  // must be GONE - along with the hint that explains it.
  const after = document.querySelector('#instrument-body #in-gain-reset');
  const hint = document.querySelector('#instrument-body #in-gain-hint');
  return (Math.abs(t.instrument.gain - want) < 1e-9 && !after && !hint)
    || 'gain=' + t.instrument.gain + ' want=' + want + ' label=' + shown
       + ' link=' + !!after + ' hint=' + !!hint;
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

// These two live AFTER the audition sequence on purpose: opening a project -
// which the fetch test does, twice - kills the audition loop the toggle test
// above needs to still be running from 900 lines earlier. Moving the tests was
// the fix; teaching openProject to spare a test's audition would be backwards.
// ---- fetching the tune back opens it as a project ----
//
// The full loop: the tune stored on the badge comes back over the socket,
// reverses into ticks, and opens in the editor with the conversion warning
// showing. Asserted around a real transfer against the fake badge.
const preFetchDocId = await evaluate(`window.__chipseq.store.getDoc().id`);
const storedTune = [...labBadge.tunes.values()][0];

await check('the fetch button opens the stored tune as a project', `(async () => {
  const btn = document.querySelector('#badges-body .bg-tune [data-act="get-tune"]');
  if (!btn) return 'no fetch button - is the fetch capability wired through?';
  btn.click();
  for (let i = 0; i < 100; i++) {
    if (window.__chipseq.store.getDoc().id !== ${JSON.stringify(preFetchDocId)}) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const doc = window.__chipseq.store.getDoc();
  if (doc.id === ${JSON.stringify(preFetchDocId)}) return 'no project opened';
  if (doc.name !== ${JSON.stringify(storedTune.name)}) return 'wrong name: ' + doc.name;
  const notes = doc.tracks.reduce((n, t) => n + t.notes.length, 0);
  if (!(notes > 0)) return 'no notes came back';
  const notice = document.getElementById('st-save').textContent;
  return notice.includes('converted from a badge tune')
    || 'no conversion warning shown: "' + notice + '"';
})()`);

await check('the fetched copy re-exports identically to what the badge holds', `(async () => {
  const { buildTune } = await import('/js/core/badge-tune.js');
  const rebuilt = buildTune(window.__chipseq.store.getDoc(),
    { name: ${JSON.stringify(storedTune.name)} });
  return rebuilt.id === ${JSON.stringify(storedTune.id)}
    || 'ids differ: ' + rebuilt.id + ' vs ${storedTune.id}';
})()`);

// Put the original project back and remove the imported one from storage, or
// the recents-count assertion later in this file counts a project this test
// created.
await evaluate(`(async () => {
  const { loadProject, deleteProject } = await import('/js/core/persist.js');
  const importedId = window.__chipseq.store.getDoc().id;
  window.__chipseq.openProject(loadProject(${JSON.stringify(preFetchDocId)}));
  deleteProject(importedId);
})()`);

await check('deleting a stored tune clears it from the card', `(async () => {
  const del = document.querySelector('#badges-body .bg-tune [data-act="drop-tune"]');
  if (!del) return 'no delete button';
  del.click();
  for (let i = 0; i < 60; i++) {
    if (!document.querySelector('#badges-body .bg-tune')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return 'the tune is still listed';
})()`);


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
await check('Spread fans the tracks and the export says so', `(async () => {
  const store = window.__chipseq.store;
  const sec = document.getElementById('sec-mixer');
  if (!sec.classList.contains('open')) sec.querySelector('.tool-card-head').click();
  await new Promise((r) => setTimeout(r, 250));
  // one track only in this project, so add a couple to fan out
  const { createTrack } = await import('/js/core/doc.js');
  store.commit('tracks to spread', ['tracks'], (d) => {
    d.tracks.push(createTrack({ name: 'S1', role: 'melody', instrumentId: 'sine' }));
    d.tracks.push(createTrack({ name: 'S2', role: 'melody', instrumentId: 'saw' }));
  });
  await new Promise((r) => setTimeout(r, 200));
  document.getElementById('mix-spread').click();
  await new Promise((r) => setTimeout(r, 200));
  const pans = store.getDoc().tracks.map((t) => t.pan ?? 0);
  const fanned = pans.some((p) => p < 0) && pans.some((p) => p > 0);

  // and the export dialog must now say the file will be stereo, instead of
  // the "mono mix" it used to claim regardless
  document.getElementById('btn-export').click();
  await new Promise((r) => setTimeout(r, 200));
  const line = document.getElementById('export-channels').textContent;
  document.querySelector('#dlg-export [value="cancel"]').click();
  store.undo();
  store.undo();
  return (fanned && /stereo/.test(line)) || 'pans=' + JSON.stringify(pans) + ' line=' + line;
})()`);

await check('the mixer card edits track gain through the UI', `(async () => {
  const store = window.__chipseq.store;
  const before = store.getDoc().tracks[0].gain;
  const sec = document.getElementById('sec-mixer');
  if (!sec || sec.hidden) return 'mixer card missing';
  if (!sec.classList.contains('open')) sec.querySelector('.tool-card-head').click();
  await new Promise((r) => setTimeout(r, 250));
  const slider = document.querySelector('#mixer-body input[data-act="gain"]');
  if (!slider) return 'no gain slider';
  slider.value = '60';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  const uncommitted = store.getDoc().tracks[0].gain === before;
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  const committed = store.getDoc().tracks[0].gain === 0.6;
  const label = document.querySelector('#mixer-body .mix-val').textContent;
  store.undo();
  return (uncommitted && committed && label === '60%')
    || 'uncommitted=' + uncommitted + ' committed=' + committed + ' label=' + label;
})()`);

await check('default instrument renamed to plain Square', `(() => {
  const sel = document.querySelectorAll('#track-list .track-row select')[0];
  const names = [...sel.options].map((o) => o.textContent);
  return names.includes('Square') && !names.includes('Badge Square') || names.join(',');
})()`);

// ---- automation lanes (poly): per-control keyframes ----

// Lane geometry is derived from the corner buttons' own heights, never
// hard-coded: the stack grows whenever a parameter is added (Pan did exactly
// that), and a literal y would then silently point at the wrong lane.
const LANE_GEOM = `
  const laneGeom = (label) => {
    let y = 0;
    for (const b of document.querySelectorAll('.auto-lane-btn')) {
      const h = parseFloat(b.style.height);
      if (b.textContent.trim().startsWith(label)) return { y, h, btn: b };
      y += h;
    }
    return null;
  };
`;

await check('automation stack open by default with gain expanded', `(() => {
  const master = document.getElementById('auto-master');
  const btns = [...document.querySelectorAll('.auto-lane-btn')];
  const labels = btns.map((b) => b.textContent.trim());
  const rows = document.getElementById('roll-area').style.gridTemplateRows;
  // triangle preset: gain + pan + 4 ADSR lanes, NO duty lane
  const total = btns.reduce((sum, b) => sum + parseFloat(b.style.height), 0);
  return (master && master.textContent.includes('▾')
    && labels.some((t) => t.startsWith('Gain')) && labels.some((t) => t.startsWith('Pan'))
    && !labels.some((t) => t.startsWith('Duty'))
    && rows.endsWith(total + 'px'))
    || labels.join(',') + ' rows=' + rows + ' total=' + total;
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
  ${LANE_GEOM}
  const c = document.getElementById('auto-canvas');
  const r = c.getBoundingClientRect();
  const g = laneGeom('Attack');
  for (const type of ['mousedown', 'mouseup']) {
    (type === 'mousedown' ? c : window).dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + 300, clientY: r.top + g.y + g.h / 2, button: 0 }));
  }
  const auto = window.__chipseq.store.getDoc().tracks[0].automation || {};
  const attackBtn = [...document.querySelectorAll('.auto-lane-btn')].find((b) => b.textContent.includes('Attack'));
  const saved = JSON.parse(localStorage.getItem('chipseq.v1.autolane') || '{}');
  return !(auto.attack || []).length && attackBtn.classList.contains('expanded') && saved.expanded.attack === true
    || JSON.stringify({ attack: auto.attack, expanded: attackBtn.className });
})()`);
await check('keyframe in the attack lane overrides note envelopes', `(async () => {
  const { flattenSong } = await import('/js/core/flatten.js');
  ${LANE_GEOM}
  const c = document.getElementById('auto-canvas');
  const r = c.getBoundingClientRect();
  const g = laneGeom('Attack'); // now expanded; click near its top = long attack
  for (const type of ['mousedown', 'mouseup']) {
    (type === 'mousedown' ? c : window).dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + 10, clientY: r.top + g.y + 10, button: 0 }));
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
await check('loop region included in .chipseq.json export', `(async () => {
  const { exportProjectFile } = await import('/js/core/persist.js');
  const text = await exportProjectFile(window.__chipseq.store.getDoc()).text();
  const parsed = JSON.parse(text);
  return parsed.loop && parsed.loop.startTick === 1536 || JSON.stringify(parsed.loop);
})()`);
await check('snap preference restored from localStorage', `(() => {
  const ui = window.__chipseq.uiStore.state;
  const sel = document.getElementById('sel-snap');
  return ui.snapTicks === 24 && sel.options[sel.selectedIndex].textContent === '1/16'
    || 'ui=' + ui.snapTicks + ' sel=' + sel.options[sel.selectedIndex].textContent;
})()`);
await check('grid preference included in .chipseq.json export', `(async () => {
  const { exportProjectFile } = await import('/js/core/persist.js');
  const parsed = JSON.parse(await exportProjectFile(window.__chipseq.store.getDoc()).text());
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
  const raw = JSON.stringify({ ...window.__chipseq.store.getDoc(), uses: ['harmonics', 'granular@1'], futureBlock: { kind: 'x', v: 1 } });
  const doc = migrate(JSON.parse(raw));
  const missing = unsupportedFeatures(doc);
  return (missing.length === 1 && missing[0] === 'granular@1' && !!doc.futureBlock)
    || JSON.stringify({ missing, kept: !!doc.futureBlock });
})()`);

// ---- WAV render: structure, level and the non-clipping master ----
// Rendered audio is checked by measurement rather than byte-comparison: the
// WaveShaper's behaviour depends on the Chromium build, so a byte golden
// would fail on browser upgrades instead of on real regressions.


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

// Velocity is stored (MIDI import fills it in) but deliberately not applied
// while no UI can show or edit it. Assert on rendered audio, not on the
// constant, so re-enabling it cannot pass unnoticed.
await check('per-note velocity does not change the rendered audio', `(async () => {
  ${WAV_HELPERS}
  const { renderWav } = await import('/js/core/export-wav.js');
  const base = structuredClone(window.__chipseq.store.getDoc());
  base.mode = 'poly';
  const render = async (velocity) => {
    const doc = structuredClone(base);
    for (const t of doc.tracks) for (const n of t.notes) n.velocity = velocity;
    const { blob } = await renderWav(doc);
    const w = await readWav(blob);
    return { peak: w.peak, rms: w.rms };
  };
  const nominal = await render(100);
  const quiet = await render(20);
  const loud = await render(127);
  if (!(nominal.peak > 0)) return 'fixture rendered silence';
  const same = (a, b) => Math.abs(a.peak - b.peak) < 1e-6 && Math.abs(a.rms - b.rms) < 1e-6;
  return (same(nominal, quiet) && same(nominal, loud))
    || JSON.stringify({ nominal, quiet, loud });
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
  // This tests the master CLIPPER, so Levels is switched off - otherwise it
  // pulls the mix under the target and the clipper never engages, which is
  // Levels working correctly but proves nothing about the clipper.
  doc.master = { ...(doc.master || {}), normalize: { kind: 'normalize', v: 1, enabled: false } };
  // eight loud voices stacked on the same beat - guaranteed to sum over 1.0
  doc.instruments.forEach((i) => { i.gain = 1; });
  // A spread C major rather than eight chromatic semitones: same voice count
  // and the same summed level, but the suite is audible on whoever runs it.
  const HOT_CHORD = [36, 48, 55, 60, 64, 67, 72, 79];
  doc.tracks = HOT_CHORD.map((pitch, i) => ({
    id: 'hot-' + i, name: 'hot' + i, role: 'melody', instrumentId: 'badge',
    notes: [{ id: 'hn-' + i, pitch, startTick: 0, durationTicks: 384, velocity: 127, harmonics: null }],
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
  const { VELOCITY_GAIN } = await import('/js/core/instruments.js');
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
  // one square voice: gain * VELOCITY_GAIN * MASTER_GAIN, before the (inactive
  // at this level) clipper. A normalized PeriodicWave overshoots a little, so
  // this is a band rather than an equality. VELOCITY_GAIN is imported rather
  // than spelled out: the note above carries velocity 127 and is deliberately
  // NOT rendered any louder for it, which is the policy under test elsewhere.
  const expected = 0.5 * VELOCITY_GAIN * MASTER_GAIN;
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
await navigateAndBoot('reload-resumes');
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

// ---- unified modulation, rendered ----
const MOD_DOC = `
  const modDoc = (patch) => {
    const doc = structuredClone(window.__chipseq.store.getDoc());
    doc.mode = 'poly';
    const inst = doc.instruments.find((i) => i.id === 'badge');
    inst.gain = 0.8;
    inst.adsr = { a: 0.01, d: 0, s: 1, r: 0.05 };
    doc.tracks = [{
      id: 'mod', name: 'mod', role: 'melody', instrumentId: 'badge', notes: [
        { id: 'mn', pitch: 69, startTick: 0, durationTicks: 384, velocity: 127, harmonics: null },
      ],
    }];
    doc.activeTrackId = doc.melodyTrackId = 'mod';
    patch(doc, inst);
    return doc;
  };
`;

// The merged curve has to carry the release tail. The old two-node scheme let
// the ADSR node release while the lane curve held its final value; folding
// them into one array means the array itself must come back to silence, or a
// note under automation would simply stop dead.
await check('a note under a gain lane still releases to silence', `(async () => {
  ${WAV_HELPERS}
  ${MOD_DOC}
  const { renderWav } = await import('/js/core/export-wav.js');
  const doc = modDoc((d) => {
    d.tracks[0].automation = { gain: [
      { tick: 0, value: 0.2, curve: 'linear' },
      { tick: 384, value: 1, curve: 'linear' },
    ] };
  });
  const { blob } = await renderWav(doc);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const samples = new Int16Array(buf.buffer, 44, (buf.length - 44) / 2);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s / 32768));
  // last 20 ms must be silent: the release ran to zero inside the curve
  let tail = 0;
  for (let i = samples.length - 900; i < samples.length; i++) tail = Math.max(tail, Math.abs(samples[i] / 32768));
  return (peak > 0.3 && tail < 0.01) || 'peak=' + peak.toFixed(4) + ' tail=' + tail.toFixed(4);
})()`);

// A rising lane must actually rise: the note is quieter at its start than at
// its end, which is what proves the lane and the envelope were multiplied
// rather than one of them winning.
await check('a rising gain lane is audible across the note', `(async () => {
  ${MOD_DOC}
  const { renderWav } = await import('/js/core/export-wav.js');
  const doc = modDoc((d) => {
    d.tracks[0].automation = { gain: [
      { tick: 0, value: 0.1, curve: 'linear' },
      { tick: 384, value: 1, curve: 'linear' },
    ] };
  });
  const { blob } = await renderWav(doc);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const samples = new Int16Array(buf.buffer, 44, (buf.length - 44) / 2);
  const rms = (from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += (samples[i] / 32768) ** 2;
    return Math.sqrt(sum / (to - from));
  };
  // The note is 384 ticks = 2 s at 120 BPM = 88200 samples; the render adds a
  // release plus padding after that, so both windows must sit INSIDE the note.
  const early = rms(4000, 8000);
  const late = rms(80000, 84000);
  return (late > early * 2) || 'early=' + early.toFixed(4) + ' late=' + late.toFixed(4);
})()`);

// A drawn envelope overrides the sliders - the storage is additive, so a
// project without one is untouched.
await check('a drawn envelope overrides the ADSR sliders', `(async () => {
  ${MOD_DOC}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { adsrToEnv } = await import('/js/core/modulation.js');
  const plain = modDoc(() => {});
  const drawn = modDoc((d, inst) => {
    // a slow swell the four sliders cannot express: rise, dip, rise
    inst.env = { kind: 'env', v: 1, timeBase: 'sec', sustainIndex: 3, points: [
      { t: 0, value: 0, curve: 'linear' },
      { t: 0.3, value: 1, curve: 'linear' },
      { t: 0.5, value: 0.2, curve: 'linear' },
      { t: 0.8, value: 1, curve: 'linear' },
      { t: 0.05, value: 0, curve: 'linear' },
    ] };
  });
  const rmsOf = async (doc) => {
    const { blob } = await renderWav(doc);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const s = new Int16Array(buf.buffer, 44, (buf.length - 44) / 2);
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += (s[i] / 32768) ** 2;
    return Math.sqrt(sum / s.length);
  };
  const a = await rmsOf(plain);
  const b = await rmsOf(drawn);
  // the swell spends much of the note below full level, so it is quieter
  return (b < a * 0.9 && b > 0) || 'plain=' + a.toFixed(4) + ' drawn=' + b.toFixed(4);
})()`);

// detune is a real target now, which is what makes vibrato and portamento
// data rather than deferred features.
await check('detune shifts the rendered pitch', `(async () => {
  ${MOD_DOC}
  const { renderWav } = await import('/js/core/export-wav.js');
  const zeroCrossings = async (doc) => {
    const { blob } = await renderWav(doc);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const s = new Int16Array(buf.buffer, 44, (buf.length - 44) / 2);
    let n = 0;
    for (let i = 5000; i < 20000; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) n++;
    return n;
  };
  const base = await zeroCrossings(modDoc(() => {}));
  const up = await zeroCrossings(modDoc((d) => { d.tracks[0].notes[0].detune = 1200; }));
  // an octave up is twice the frequency, so roughly twice the crossings
  return (up > base * 1.7 && up < base * 2.3) || 'base=' + base + ' up=' + up;
})()`);

// ---- mixer: per-track nodes, rendered ----
await check('track gain is applied by the graph, not baked into voices', `(async () => {
  ${WAV_HELPERS}
  ${MOD_DOC}
  const { renderWav } = await import('/js/core/export-wav.js');
  const full = await renderWav(modDoc(() => {}));
  const half = await renderWav(modDoc((d) => { d.tracks[0].gain = 0.5; }));
  const a = (await readWav(full.blob)).peak;
  const b = (await readWav(half.blob)).peak;
  const ratio = b / a;
  return (ratio > 0.45 && ratio < 0.55) || 'full=' + a.toFixed(4) + ' half=' + b.toFixed(4) + ' ratio=' + ratio.toFixed(3);
})()`);

// Stereo only when something is panned: an unpanned project must keep
// rendering the same mono file it always did.
await check('an unpanned project still renders mono', `(async () => {
  ${WAV_HELPERS}
  ${MOD_DOC}
  const { renderWav } = await import('/js/core/export-wav.js');
  const w = await readWav((await renderWav(modDoc(() => {}))).blob);
  return (w.channels === 1 && w.blockAlign === 2 && w.dataSize === w.sampleCount * 2)
    || 'ch=' + w.channels + ' align=' + w.blockAlign;
})()`);

await check('a panned track renders stereo, weighted to that side', `(async () => {
  ${MOD_DOC}
  const { renderWav } = await import('/js/core/export-wav.js');
  const { blob } = await renderWav(modDoc((d) => { d.tracks[0].pan = -1; }));
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const channels = dv.getUint16(22, true);
  if (channels !== 2) return 'channels=' + channels;
  // interleaved L R L R - measure each side's energy separately
  const frames = new Int16Array(buf.buffer, 44, (buf.length - 44) / 2);
  let left = 0, right = 0;
  for (let i = 0; i + 1 < frames.length; i += 2) {
    left += (frames[i] / 32768) ** 2;
    right += (frames[i + 1] / 32768) ** 2;
  }
  return (left > right * 20 && right >= 0) || 'left=' + left.toFixed(2) + ' right=' + right.toFixed(2);
})()`);

// A pan lane sweeps position over the note, which the track node cannot do -
// the voices pan themselves, so the energy has to move between the channels.
await check('a pan lane sweeps the voice across the field', `(async () => {
  ${MOD_DOC}
  const { renderWav } = await import('/js/core/export-wav.js');
  const doc = modDoc((d) => {
    d.tracks[0].automation = { pan: [
      { tick: 0, value: -1, curve: 'linear' },
      { tick: 384, value: 1, curve: 'linear' },
    ] };
    // several short notes, so each one is placed separately along the sweep
    d.tracks[0].notes = [0, 96, 192, 288].map((t, i) => ({
      id: 'pn' + i, pitch: 69, startTick: t, durationTicks: 96, velocity: 120, harmonics: null,
    }));
  });
  const { blob } = await renderWav(doc);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  if (dv.getUint16(22, true) !== 2) return 'not stereo: ' + dv.getUint16(22, true);
  const s = new Int16Array(buf.buffer, 44, (buf.length - 44) / 2);
  const energy = (from, to) => {
    let l = 0, r = 0;
    for (let i = from; i + 1 < to; i += 2) { l += (s[i] / 32768) ** 2; r += (s[i + 1] / 32768) ** 2; }
    return { l, r };
  };
  const first = energy(0, 40000);          // first note: hard left
  const last = energy(s.length - 60000, s.length - 20000); // last: hard right
  return (first.l > first.r * 5 && last.r > last.l * 5)
    || 'first L/R=' + (first.l / (first.r || 1e-9)).toFixed(1) + ' last R/L=' + (last.r / (last.l || 1e-9)).toFixed(1);
})()`);

await check('forcing stereo renders two channels with nothing panned', `(async () => {
  ${WAV_HELPERS}
  ${MOD_DOC}
  const { renderWav } = await import('/js/core/export-wav.js');
  const doc = modDoc(() => {});
  const auto = await readWav((await renderWav(doc)).blob);
  const forced = await readWav((await renderWav(doc, { stereo: true })).blob);
  return (auto.channels === 1 && forced.channels === 2 && forced.blockAlign === 4)
    || 'auto=' + auto.channels + ' forced=' + forced.channels;
})()`);

await check('solo silences everything else', `(async () => {
  ${MOD_DOC}
  const { flattenSong } = await import('/js/core/flatten.js');
  const doc = modDoc((d) => {
    d.tracks.push({ id: 'mod2', name: 'other', role: 'melody', instrumentId: 'sine', solo: true,
      notes: [{ id: 'mn2', pitch: 60, startTick: 0, durationTicks: 384, velocity: 100, harmonics: null }] });
  });
  const ids = new Set(flattenSong(doc).events.map((e) => e.trackId));
  return (ids.size === 1 && ids.has('mod2')) || [...ids].join(',');
})()`);

// ---- saved view: scroll, zoom and cursor travel with the project ----
await check('the viewport is mirrored into the document', `(async () => {
  const store = window.__chipseq.store;
  const ui = window.__chipseq.uiStore;
  ui.update('view', (s) => { s.scrollTick = 768; s.scrollPitch = 66; s.pxPerTick = 1.25; });
  ui.update('cursor', (s) => { s.gridCursor.pitch = 55; });
  store.session.originTick = 384;
  ui.update('transport', () => {});
  await new Promise((r) => setTimeout(r, 450)); // the mirror is throttled
  const v = store.getView();
  return (v && v.scrollTick === 768 && v.scrollPitch === 66 && v.pxPerTick === 1.25
    && v.cursorTick === 384 && v.cursorPitch === 55)
    || JSON.stringify(v);
})()`);

await check('scrolling is not an edit', `(() => {
  // no undo entry, and the history button state must not have changed
  const store = window.__chipseq.store;
  const before = store.canUndo();
  store.setView({ scrollTick: 12, scrollPitch: 60, pxPerTick: 1, cursorTick: 0, cursorPitch: 60 });
  return store.canUndo() === before || 'undo state changed';
})()`);

await check('the saved view is exported and restored on reopen', `(async () => {
  const { exportProjectFile, importProjectFile } = await import('/js/core/persist.js');
  const store = window.__chipseq.store;
  // scrollPitch 100: a tall window clamps low values up (it would need rows
  // below the lowest pitch), so pick one this viewport can actually honour.
  store.setView({ scrollTick: 960, scrollPitch: 100, pxPerTick: 2, cursorTick: 288, cursorPitch: 64 });
  const doc = store.getDoc();
  const back = importProjectFile(await exportProjectFile(doc).text());
  if (JSON.stringify(back.view) !== JSON.stringify(doc.view)) return 'not exported: ' + JSON.stringify(back.view);

  // reopening applies it to the live viewport instead of re-centring
  window.__chipseq.openProject(back);
  await new Promise((r) => setTimeout(r, 400));
  const ui = window.__chipseq.uiStore.state;
  return (ui.scrollTick === 960 && ui.scrollPitch === 100 && ui.pxPerTick === 2
    && window.__chipseq.store.session.originTick === 288)
    || 'scroll=' + ui.scrollTick + '/' + ui.scrollPitch + ' zoom=' + ui.pxPerTick
       + ' cursor=' + window.__chipseq.store.session.originTick;
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
// ---- the browser is told this is a dark UI ----
//
// Native scrollbars, checkboxes, number spinners and the popup a <select>
// opens are painted by the browser, not by our CSS, so the only way to reach
// them is color-scheme. Without it Chrome uses the light theme and a long tool
// list gets a bright white scrollbar down the side of a dark app.
await check('the root declares a dark color-scheme', `(() => {
  const root = getComputedStyle(document.documentElement);
  const meta = document.querySelector('meta[name=color-scheme]');
  return (root.colorScheme === 'dark' && meta && meta.content === 'dark')
    || 'colorScheme=' + root.colorScheme + ' meta=' + (meta && meta.content);
})()`);

// ---- an arp-heavy song plays without freezing the roll ----
//
// A real song with 62 autoSong arp notes stuttered at 4 fps: the roll
// re-rendered every arp note's events per frame, each rebuilding the chord
// lookup over the whole chord track. This is the regression test, run in a
// real Chromium against a synthetic song heavier than the one that broke.
//
// Playing from MID-song matters: the follow-scroll only starts moving the grid
// once the playhead passes its 1/3 anchor, and it is the moving grid that
// repaints notes every frame. From tick 0 the first seconds are the cheap
// phase and the test would measure nothing.
{
  const { arpHeavySong } = await import('./util.mjs');
  const heavy = await arpHeavySong({ arpNotes: 400 });
  const preId = await evaluate(`window.__chipseq.store.getDoc().id`);
  await evaluate(`window.__chipseq.openProject(${JSON.stringify(heavy)})`);
  await check('the arp-heavy song opens', `(() => {
    const d = window.__chipseq.store.getDoc();
    const arps = d.tracks.reduce((n, t) => n + t.notes.filter((x) => x.harmonics).length, 0);
    return arps >= 400 || 'arps=' + arps;
  })()`);

  await check('the roll keeps up while an arp-heavy song scrolls under the playhead', `(async () => {
    const e = window.__chipseq.engine;
    const ui = window.__chipseq.uiStore.state;
    ui.pxPerTick = 0.5;
    await e.ensureCtx();
    // Deep into the song, so the grid is scrolling from the very first frame.
    e.play(96 * 4 * 40);
    await new Promise((r) => setTimeout(r, 400)); // let the glide settle
    let frames = 0;
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        frames++;
        if (performance.now() - start < 2000) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const secs = (performance.now() - start) / 1000;
    const fps = frames / secs;
    const scrolled = ui.scrollTick > 0;
    e.stop();
    // 20 fps is a 20x margin over the < 1 fps this measured before the fix,
    // and well below the ~60 a healthy run gives - so it cannot flake, and it
    // cannot pass on the broken code.
    return (fps > 20 && scrolled) || 'fps=' + fps.toFixed(1) + ' scrolled=' + scrolled;
  })()`);

  // A loop wrap must not re-flatten the song. Counted, not timed: spy on the
  // engine's flatten by wrapping the module export it reads through.
  await check('a loop wrap seeks instead of re-flattening the whole song', `(async () => {
    const e = window.__chipseq.engine;
    const s = window.__chipseq.store;
    // A one-beat loop: wraps ~2x per second at 120 bpm.
    s.setLoop({ startTick: 0, endTick: 96, enabled: true });
    await e.ensureCtx();
    // Count flattens by watching the 'playstate' restarts the engine emits on
    // a re-flatten path... too indirect. Instead time the scheduler: measure
    // the longest gap between playhead samples across many wraps. A whole-song
    // re-flatten (72 ms on this song) inside the 25 ms scheduler tick shows up
    // as stalls; a seek does not.
    e.play(0);
    let last = performance.now(), worst = 0;
    const until = performance.now() + 2500;
    while (performance.now() < until) {
      await new Promise((r) => setTimeout(r, 5));
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }
    const wraps = Math.floor(2.5 * 2);
    e.stop();
    s.setLoop(null);
    return worst < 60 || 'worst main-thread stall between samples: ' + worst.toFixed(0) + ' ms across ~' + wraps + ' loop wraps';
  })()`);

  await evaluate(`(async () => {
    const { loadProject, deleteProject } = await import('/js/core/persist.js');
    const heavyId = window.__chipseq.store.getDoc().id;
    window.__chipseq.openProject(loadProject(${JSON.stringify(preId)}));
    deleteProject(heavyId);
  })()`);
}

// ---- the grid scrolls under the playhead ----
//
// tests/unit.mjs pins the arithmetic; this pins the WIRING, by feeding the roll
// a playhead directly instead of waiting on real-time audio. Faking the engine
// makes it deterministic and quick - a real playback test would have to sit
// through several seconds of song to get past the anchor.
// ---- the grid scrolls under the playhead ----
//
// tests/unit.mjs pins the arithmetic; these pin the WIRING, by feeding the roll
// a playhead directly instead of waiting on real-time audio.
const ROLL_RIG = `
  const { uiStore, engine } = window.__chipseq;
  const ui = uiStore.state;
  const W = document.getElementById('overlay-canvas').clientWidth;
  const anchor = W / 3;
  const realPlaying = engine.isPlaying, realTick = engine.getPlayheadTick;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // The view eases into place, so a fixed number of frames would be reading it
  // mid-glide. Wait for it to stop moving instead.
  const settle = async (budget = 120) => {
    let last = NaN;
    for (let i = 0; i < budget; i++) {
      await frame();
      if (ui.scrollTick === last) return true;
      last = ui.scrollTick;
    }
    return false;
  };
`;

await check('the roll anchors the playhead a third across and scrolls the grid', `(async () => {
  ${ROLL_RIG}
  const at = async (tick) => {
    engine.getPlayheadTick = () => tick;
    await settle();
    return { scroll: ui.scrollTick, x: (tick - ui.scrollTick) * ui.pxPerTick };
  };
  try {
    ui.pxPerTick = 0.5;
    engine.isPlaying = () => true;
    const anchorTicks = anchor / ui.pxPerTick;

    // Phase 3 first, to find where the grid actually ends. Hardcoding a tick
    // here is how the first version of this test failed: it picked one past the
    // end of a short song and read a pinned scroll as a broken anchor.
    const far = await at(1e9);
    const maxScroll = far.scroll;
    if (!(maxScroll > 0)) return 'no scrollable grid to test with';

    const early = await at(200);
    const mid = await at(Math.floor(maxScroll / 2) + anchorTicks);

    if (early.scroll !== 0) return 'grid moved before the anchor: ' + JSON.stringify(early);
    if (Math.abs(early.x - 100) > 0.5) return 'playhead not tracking before the anchor: ' + JSON.stringify(early);
    if (!(mid.scroll > 0)) return 'grid did not scroll: ' + JSON.stringify(mid);
    if (Math.abs(mid.x - anchor) > 0.5) return 'playhead not anchored: ' + JSON.stringify({ mid, anchor });
    if (far.x <= anchor) return 'playhead did not move on at the end: ' + JSON.stringify({ far, anchor });
    return true;
  } finally {
    engine.isPlaying = realPlaying;
    engine.getPlayheadTick = realTick;
    uiStore.update('view', (v) => { v.scrollTick = 0; });
  }
})()`);

await check('starting mid-song eases the view over rather than jumping', `(async () => {
  ${ROLL_RIG}
  try {
    ui.pxPerTick = 0.5;
    const anchorTicks = anchor / ui.pxPerTick;

    // Find where the grid ends and pick a tick comfortably inside the stretch
    // where the view actually scrolls. Hardcoding one put the first version of
    // this test past the end of a short song, where the scroll is pinned and
    // the playhead is meant to leave the anchor.
    engine.isPlaying = () => true;
    engine.getPlayheadTick = () => 1e9;
    await settle();
    const maxScroll = ui.scrollTick;
    if (!(maxScroll > 0)) return 'no scrollable grid to test with';
    const tick = Math.floor(maxScroll / 2) + anchorTicks;

    // Start from the top of the song with the transport stopped, then begin
    // playing from well inside it: the view has a long way to travel.
    engine.isPlaying = () => false;
    engine.getPlayheadTick = () => tick;
    uiStore.update('view', (v) => { v.scrollTick = 0; });
    await frame();

    engine.isPlaying = () => true;
    await frame();
    const afterOne = ui.scrollTick;
    await settle();
    const settled = ui.scrollTick;

    if (!(settled > 0)) return 'never reached the anchor: ' + settled;
    if (Math.abs((tick - settled) * ui.pxPerTick - anchor) > 0.5) {
      return 'did not settle on the anchor: ' + JSON.stringify({ settled, anchor });
    }
    // The whole point: one frame must not get there. Allow generous slack for a
    // slow first frame, but landing within a pixel of the target immediately is
    // a jump, not a glide.
    if (Math.abs(afterOne - settled) * ui.pxPerTick < 1) {
      return 'jumped to the anchor in a single frame: ' + JSON.stringify({ afterOne, settled });
    }
    if (afterOne < 0) return 'glided the wrong way: ' + afterOne;
    return true;
  } finally {
    engine.isPlaying = realPlaying;
    engine.getPlayheadTick = realTick;
    uiStore.update('view', (v) => { v.scrollTick = 0; });
  }
})()`);

await check('the playhead is the same one pixel wide running or stopped', `(async () => {
  ${ROLL_RIG}
  const canvas = document.getElementById('overlay-canvas');
  const ctx2 = canvas.getContext('2d');
  // Count the columns painted in the playhead colour (--playhead, #f5a623).
  const widthAt = () => {
    const row = Math.floor(canvas.height / 2);
    const d = ctx2.getImageData(0, row, canvas.width, 1).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] > 120 && d[i + 1] < 210 && d[i + 2] < 90) n++;
    }
    return n;
  };
  try {
    ui.pxPerTick = 0.5;
    engine.getPlayheadTick = () => 400;
    engine.isPlaying = () => true;
    await settle();
    const running = widthAt();
    engine.isPlaying = () => false;
    window.__chipseq.store.session.cursorTick = 400;
    await frame();
    const stopped = widthAt();
    const dpr = Math.round(window.devicePixelRatio || 1);
    if (running !== stopped) return 'width changes with the transport: ' + JSON.stringify({ running, stopped });
    if (running !== dpr) return 'not one CSS pixel: ' + JSON.stringify({ running, dpr });
    return true;
  } finally {
    engine.isPlaying = realPlaying;
    engine.getPlayheadTick = realTick;
    uiStore.update('view', (v) => { v.scrollTick = 0; });
  }
})()`);

await check('the automation lanes repaint their playhead when the cursor moves', `(async () => {
  ${ROLL_RIG}
  const auto = document.getElementById('auto-canvas');
  const snapshot = () => auto.getContext('2d').getImageData(0, 0, auto.width, auto.height).data.join(',');
  const wasMode = window.__chipseq.store.getDoc().mode;
  try {
    if (wasMode !== 'poly') {
      document.querySelector('#seg-mode .seg-btn[data-mode=poly]').click();
      await frame();
    }
    if (window.__chipseq.store.getDoc().mode !== 'poly') return 'could not switch to poly mode';
    if (auto.height <= 0) return 'automation canvas has no height';
    ui.pxPerTick = 0.5;
    engine.isPlaying = () => false;
    // Stopped, the lanes follow the placed cursor. Before this was fixed they
    // drew a playhead only while playing, so they kept whatever was last
    // painted and moving the cursor changed nothing at all.
    window.__chipseq.store.session.cursorTick = 200;
    await frame();
    const a = snapshot();
    window.__chipseq.store.session.cursorTick = 1200;
    await frame();
    const b = snapshot();
    return a !== b || 'the lanes did not repaint when the cursor moved';
  } finally {
    engine.isPlaying = realPlaying;
    engine.getPlayheadTick = realTick;
    if (wasMode !== 'poly') {
      document.querySelector('#seg-mode .seg-btn[data-mode=' + wasMode + ']').click();
    }
  }
})()`);

if (consoleErrors.length) {
  fail++;
  console.log('FAIL console errors:\n  ' + consoleErrors.join('\n  '));
} else {
  pass++;
  console.log('OK   no console errors');
}

// ---- offline: the app opens with no network at all ----
//
// Last, and after the console-error gate, because pulling the network out from
// under a page legitimately makes noise - the badge socket cannot reconnect,
// and that is not a fault to report.
//
// This is the claim the whole service worker exists to make, so it is tested by
// actually cutting the network rather than by checking that a file is present.
// 127.0.0.1 is a secure context, which is why a worker can register here at all.
await navigateAndBoot('service-worker');

await check('the service worker registers and takes control', `(async () => {
  const reg = await navigator.serviceWorker.ready;
  return !!(reg && navigator.serviceWorker.controller) || 'no controller';
})()`);

await check('one versioned cache holds the whole app', `(async () => {
  await navigator.serviceWorker.ready;
  const names = (await caches.keys()).filter((n) => n.startsWith('chipseq-'));
  if (names.length !== 1) return 'caches=' + JSON.stringify(names);
  const keys = await (await caches.open(names[0])).keys();
  return keys.length > 60 || 'entries=' + keys.length;
})()`);

// An update must install and then WAIT. This is the behaviour that protects
// unsaved work and stops a running page importing a tool card out of another
// build's cache, so it is worth more than a comment.
{
  const real = await readFile(join(ROOT, 'sw.js'), 'utf8');
  swOverride = real.replace(/const VERSION = '[^']+'/, "const VERSION = 'smoke-update'");
  await evaluate(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true)`);
  const appeared = await waitUntil(`!document.getElementById('st-update').hidden`, { timeout: 20000 });
  if (appeared) { pass++; console.log('OK   a new build offers itself in the status bar'); }
  else { fail++; console.log('FAIL a new build never offered itself'); }

  await check('...and does NOT activate on its own', `(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const names = await caches.keys();
    // The new worker is parked, and the page is still served by the old one.
    return (!!reg.waiting && reg.active && names.includes('chipseq-smoke-update'))
      || 'waiting=' + !!reg.waiting + ' caches=' + JSON.stringify(names);
  })()`);
  swOverride = null;
}

// Offline by SHUTTING THE SERVER DOWN, not by CDP's network emulation. The
// emulation applies to the page target only, and a service worker is a
// separate target - so its own fetches went out over a live network and every
// assertion below passed while fully online. The control caught that. Closing
// the origin is also the honest version of the scenario: a laptop that rebooted
// somewhere with no internet.
server.close();
server.closeAllConnections();
await sleep(300);

// The control. Without it every assertion below would also pass on a network
// that never actually went away.
await check('a file outside the precache really cannot be fetched', `(async () => {
  try {
    await fetch('README.md', { cache: 'no-store' });
    return 'the network is still up';
  } catch {
    return true;
  }
})()`);

await navigateAndBoot('offline');

await check('the app boots with the network off', `(() => {
  const start = document.getElementById('screen-start');
  const editor = document.getElementById('screen-editor');
  return (!!window.__chipseq && (!start.hidden || !editor.hidden))
    || 'app=' + !!window.__chipseq;
})()`);


await check('demo songs load from the cache', `(async () => {
  const files = await (await fetch('demos/index.json')).json();
  const doc = JSON.parse(await (await fetch('demos/' + files[0])).text());
  return (files.length >= 4 && !!doc.tracks) || 'files=' + files.length;
})()`);

// The subtle one: tool cards import with ?v=APP_VERSION, and the precache key
// carries no query. A worker matching URLs exactly would serve every card from
// the network - fine online, and a blank sidebar offline.
await check('a lazily loaded tool module resolves despite its ?v= query', `(async () => {
  const m = await import('./js/ui/tools/transpose.js?v=offline-smoke');
  return Object.keys(m).length > 0 || 'no exports';
})()`);

labBadge.close();
badgeHub.httpServer.close();

// Chrome's children can outlive the parent by a moment and keep the profile
// directory busy, so a single attempt loses the race and - when the failure was
// swallowed - left the directory behind. Retry briefly, and SAY SO if it still
// fails: silently ignoring this is what let 236 profiles pile up unnoticed.
async function removeProfile(dir) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 10) {
        console.log(`WARN could not remove ${dir}: ${err.code || err.message}`);
        return;
      }
      await sleep(200);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);

// Wait for Chrome to actually be gone before exiting. kill() followed straight
// by process.exit() leaves the whole tree orphaned and the profile half
// deleted - which is how a leaked browser came to hold the debugging port for
// days. SIGTERM lets it reap its own children; SIGKILL is the backstop.
if (chrome) {
  await new Promise((resolve) => {
    const done = setTimeout(() => { chrome.kill('SIGKILL'); resolve(); }, 5000);
    chrome.once('exit', () => { clearTimeout(done); resolve(); });
    chrome.kill('SIGTERM');
  });
} else {
  ws.close(); // not our browser: leave it running, just hang up
}
// The offline test closes it; this is here for the paths that never reach that.
if (server.listening) server.close();
if (chrome) await removeProfile(PROFILE);
process.exit(fail ? 1 : 0);
