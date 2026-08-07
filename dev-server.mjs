// Static file server for development. No dependencies, no build step - the
// only thing it does that `python3 -m http.server` does not is refuse to be
// cached.
//
//   node dev-server.mjs          serves . on http://localhost:8000
//   node dev-server.mjs 8080     ...on another port
//
// Why it exists: the tool cards load lazily, so `import('./instrument.js')`
// runs when a card is first expanded - AFTER the page has finished loading.
// A hard reload (Ctrl+Shift+R) bypasses the cache for the navigation and the
// resources fetched during it, but a later runtime import is an ordinary
// fetch obeying the ordinary cache. python's http.server sends no
// Cache-Control at all, so the browser falls back to HEURISTIC caching from
// Last-Modified and can serve a stale tool module for minutes - with the
// statically imported core already updated around it. That mix is very hard
// to diagnose from the outside: the app looks broken rather than stale.
//
// `no-store` removes the guesswork.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2]) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
};

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  // Contain the path inside ROOT: a static dev server still should not hand
  // out ../../.ssh because someone typed it into the address bar.
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, rel);
  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(path);
    const file = info.isDirectory() ? join(path, 'index.html') : path;
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      // The whole point of this file.
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`ChipSeq dev server: http://localhost:${PORT}/  (no-store, so reloads are honest)`);
});
