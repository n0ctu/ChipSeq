// Verifies a deployed ChipSeq instance end-to-end in headless Chromium.
// Run: node tests/live-check.mjs [url]
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findChrome } from './util.mjs';

const CHROME = findChrome();
const URL = process.argv[2] || 'https://chipseq.app/';
// os.tmpdir() honours $TMPDIR - see tests/smoke.mjs for why that matters.
const PROFILE = join(tmpdir(), 'chipseq-live-profile-' + Date.now());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CHROME_CDP=127.0.0.1:port attaches to a Chrome started elsewhere instead of
// spawning one - see tests/smoke.mjs for why (a sandbox that allows TCP but
// not the AF_UNIX socket Chromium needs for its singleton lock).
let chrome = null;
let DEBUG_PORT = null;
if (process.env.CHROME_CDP) {
  DEBUG_PORT = Number(process.env.CHROME_CDP.split(':').pop());
} else {
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900',
    // Port 0, not a fixed one - the same trap tests/smoke.mjs fell into. A fixed
    // port silently attaches to whatever browser already holds it, so a leaked
    // instance from an earlier run turns every later run into a check of a stale
    // profile. It looks like a pass either way, which is the dangerous part.
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore' });

  // Chrome writes the port it actually chose here.
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

let targets = null;
for (let i = 0; i < 50; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
    if (targets.length) break;
  } catch {}
  await sleep(200);
}
let page = targets.find((t) => t.type === 'page');
if (!page) page = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
// One-shot waiters for CDP events, so a navigation can be awaited rather than
// slept through.
const eventWaiters = new Map();
function once(method) {
  return new Promise((resolve) => {
    const list = eventWaiters.get(method) || [];
    list.push(resolve);
    eventWaiters.set(method, list);
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method && eventWaiters.has(msg.method)) {
    for (const resolve of eventWaiters.get(msg.method)) resolve(msg.params);
    eventWaiters.delete(msg.method);
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    consoleErrors.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed');
  return res.result.value;
};

let pass = 0, fail = 0;
const check = async (label, expr) => {
  try {
    const v = await evaluate(expr);
    if (v === true) { pass++; console.log('OK  ', label); }
    else { fail++; console.log('FAIL', label, '->', JSON.stringify(v)); }
  } catch (err) {
    fail++;
    console.log('FAIL', label, '->', err.message);
  }
};

// Wait for the load event and then for the app to finish booting, rather than
// for a fixed number of milliseconds. Evaluating while the old document is
// being torn down does not fail - the reply never arrives and the run HANGS -
// and three seconds is a guess about someone else's network besides.
async function waitUntil(expr, { timeout = 30000, every = 200 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v = false;
    try { v = await evaluate(expr); } catch {}
    if (v === true) return true;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

await send('Runtime.enable');
await send('Page.enable');
const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url: URL });
await Promise.race([loaded, sleep(30000)]);
if (!(await waitUntil(`!!window.__chipseq && document.querySelectorAll('#demo-list .demo-item').length > 0`))) {
  console.log('FAIL the app did not finish booting within 30s');
  fail++;
}

await check('live app boots to the start page', `!document.getElementById('screen-start').hidden && !!window.__chipseq`);
await check('title is correct', `document.title.startsWith('ChipSeq - n0ctus chiptune sequencer')`);
await check('demos fetched fresh from the subpath', `(() => {
  const text = document.getElementById('demo-list').textContent;
  return document.querySelectorAll('#demo-list .demo-item').length === 5
    && text.includes('Demo Mono') && text.includes('Bad Apple') || text.slice(0, 100);
})()`);
await evaluate(`[...document.querySelectorAll('#demo-list .demo-item')].find((i) => i.textContent.includes('Demo Mono')).click()`);
await sleep(500);
await check('demo opens in the editor without being stored', `(() => {
  const doc = window.__chipseq.store.getDoc();
  const stored = JSON.parse(localStorage.getItem('chipseq.v1.index') || '[]').length;
  return !document.getElementById('screen-editor').hidden && doc.name === 'Demo Mono'
    && doc.tracks[0].notes.length === 7 && stored === 0 || doc.name + '/stored=' + stored;
})()`);
await check('.h export preview works live', `(async () => {
  const { exportHeader } = await import('./js/core/export-h.js');
  const h = exportHeader(window.__chipseq.store.getDoc());
  return h.text.includes('static const BadgeNote') || h.text.slice(0, 60);
})()`);
await check('.fmf export works live', `(async () => {
  const { exportFmf } = await import('./js/core/export-fmf.js');
  const f = exportFmf(window.__chipseq.store.getDoc());
  return f.text.startsWith('Filetype: Flipper Music Format') || f.text.slice(0, 60);
})()`);
await check('icon sprite loads and buttons render icons', `(async () => {
  const res = await fetch('assets/icons.svg');
  const ct = res.headers.get('content-type') || '';
  const btnSvg = document.querySelector('#btn-play svg.icon use');
  const iconRect = document.querySelector('#btn-play svg.icon').getBoundingClientRect();
  return res.ok && ct.includes('image/svg') && !!btnSvg && iconRect.width > 5
    || 'ct=' + ct + ' svg=' + !!btnSvg;
})()`);
await check('playback engine starts and stops live', `(() => {
  const e = window.__chipseq.engine;
  e.play(0);
  const playing = e.isPlaying();
  e.stop();
  return playing && !e.isPlaying();
})()`);

if (consoleErrors.length) {
  fail++;
  console.log('FAIL console errors/warnings:\n  ' + consoleErrors.join('\n  '));
} else {
  pass++;
  console.log('OK   no console errors or warnings');
}
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

// Wait for Chrome to actually be gone before exiting, then take the profile
// with it. kill() followed straight by process.exit() orphans the tree and
// leaves the profile behind - which is how a leaked browser came to hold a
// debugging port for days.
if (chrome) {
  await new Promise((resolve) => {
    const done = setTimeout(() => { chrome.kill('SIGKILL'); resolve(); }, 5000);
    chrome.once('exit', () => { clearTimeout(done); resolve(); });
    chrome.kill('SIGTERM');
  });
  await removeProfile(PROFILE);
} else {
  ws.close();
}
process.exit(fail ? 1 : 0);
