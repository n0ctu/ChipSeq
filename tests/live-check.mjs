// Verifies a deployed ChipSeq instance end-to-end in headless Chromium.
// Run: node tests/live-check.mjs [url]
import { spawn } from 'node:child_process';
import { findChrome } from './util.mjs';

const CHROME = findChrome();
const URL = process.argv[2] || 'https://n0ctu.github.io/ChipSeq/';
const DEBUG_PORT = 9339;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--user-data-dir=/tmp/chipseq-live-profile-' + Date.now(),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 50; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
    if (targets.length) break;
  } catch {}
  await sleep(200);
}
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

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(3000);

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
console.log(`\n${pass} passed, ${fail} failed`);
chrome.kill();
process.exit(fail ? 1 : 0);
