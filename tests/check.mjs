// Imports every ES module the app can load, to catch syntax errors and broken
// import bindings. Run: node tests/check.mjs
//
// The list is not written here. It comes from the same walk that builds the
// service worker's precache list, so it is whatever index.html actually
// reaches - including a tool card that is only ever loaded by a dynamic
// import, which a broken build would otherwise reveal as an empty card at
// runtime rather than as a failure here.
//
// It used to be a hand-kept array, and it had quietly lost core/badge-tune.js
// and net/badge-upload.js. That is the argument for deriving it.

import { walk } from '../tools/gen-precache.mjs';

const base = new URL('../', import.meta.url).href;

// Everything except the entry point, which wires the DOM as a side effect of
// being imported and so cannot load outside a browser. tests/smoke.mjs runs it
// in a real one, which is the only place that check means anything anyway.
const modules = walk().filter(
  (path) => path.startsWith('js/') && path.endsWith('.js') && path !== 'js/main.js'
);

let failed = 0;
for (const m of modules) {
  try {
    await import(base + m);
    console.log('OK  ', m);
  } catch (err) {
    failed++;
    console.log('FAIL', m, '-', err.message);
  }
}
console.log(`${modules.length - failed}/${modules.length} modules import cleanly`);
process.exit(failed ? 1 : 0);
