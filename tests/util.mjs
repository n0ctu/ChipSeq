// Shared helpers for the browser-based test suites.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Locate a Chrome/Chromium binary: CHROME_BIN env var, Playwright's cache,
// then common system paths.
export function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const pw = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(pw)) {
    const dirs = readdirSync(pw)
      .filter((d) => d.startsWith('chromium'))
      .sort()
      .reverse();
    for (const dir of dirs) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const p = join(pw, dir, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]) {
    if (existsSync(p)) return p;
  }
  throw new Error('No Chromium found - set CHROME_BIN to a Chrome/Chromium binary.');
}
