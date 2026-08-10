// Draws the app icons and writes them as PNGs. Run after changing the mark:
//
//   node tools/gen-icons.mjs
//
// The output is committed, so nothing generates at deploy time - the site is
// still the repository, served verbatim.
//
// Why a PNG writer instead of an image library: this repository takes no
// packages, and the alternative - an SVG in the manifest - installs
// inconsistently. A PNG is a signature, three chunks and a CRC, and Node
// already ships the only hard part (deflate). The CRC is the same CRC-32 the
// badge format uses, so it comes from there rather than being written twice.
//
// The mark is a square wave, drawn on a 32x32 grid because pixels are the
// point. Grid units rather than pixels means one definition renders crisply at
// any size.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../js/core/badge-tune.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// --bg-0 and --accent from css/base.css. Duplicated deliberately: an icon is
// baked bytes, so it cannot read a stylesheet, and pretending otherwise by
// importing something would hide that a colour change needs a regeneration.
const BG = [0x10, 0x12, 0x14];
const FG = [0x4a, 0xde, 0x80];

const GRID = 32;

// Inclusive grid rectangles [x0, y0, x1, y1]. Stroke is 3 units, and the wave
// runs high-low-high-low rather than showing a single trough: one dip reads as
// a bracket, and it takes two full transitions before the eye calls it
// periodic. Runs overlap at the transitions, which is what makes the corners
// square rather than notched.
const SEGMENTS = [
  [2, 10, 9, 12], // high
  [7, 10, 9, 22], // falling edge
  [7, 20, 16, 22], // low
  [14, 10, 16, 22], // rising edge
  [14, 10, 23, 12], // high
  [21, 10, 23, 22], // falling edge
  [21, 20, 29, 22], // low
];

// coverage: how much of the icon the 32x32 grid spans. 1 keeps the grid's own
// margin; a maskable icon needs the mark inside the inner 80% circle, and the
// mark's corners sit at 0.482 of the grid radius, so 0.78 is the largest
// coverage that fits with room to spare.
function render(size, coverage) {
  const span = Math.round(size * coverage);
  const origin = Math.round((size - span) / 2);
  const px = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    px[i * 3] = BG[0];
    px[i * 3 + 1] = BG[1];
    px[i * 3 + 2] = BG[2];
  }
  const edge = (g) => origin + Math.round((g * span) / GRID);
  for (const [x0, y0, x1, y1] of SEGMENTS) {
    for (let y = edge(y0); y < edge(y1 + 1); y++) {
      if (y < 0 || y >= size) continue;
      for (let x = edge(x0); x < edge(x1 + 1); x++) {
        if (x < 0 || x >= size) continue;
        const i = (y * size + x) * 3;
        px[i] = FG[0];
        px[i + 1] = FG[1];
        px[i + 2] = FG[2];
      }
    }
  }
  return px;
}

// ---- PNG ----

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function png(size, rgb) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour, no alpha - the mark is opaque everywhere
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  // One filter byte per scanline. Filter 0 (none) throughout: the image is
  // flat colour, so deflate finds the runs without help.
  const stride = size * 3;
  const raw = new Uint8Array(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---- write ----

export const ICONS = [
  { file: 'assets/icon-192.png', size: 192, coverage: 1 },
  { file: 'assets/icon-512.png', size: 512, coverage: 1 },
  { file: 'assets/icon-maskable-512.png', size: 512, coverage: 0.78 },
];

export function iconBytes({ size, coverage }) {
  return png(size, render(size, coverage));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const icon of ICONS) {
    const bytes = iconBytes(icon);
    writeFileSync(ROOT + icon.file, bytes);
    console.log(`${icon.file}  ${icon.size}x${icon.size}  ${bytes.length} bytes`);
  }
}
