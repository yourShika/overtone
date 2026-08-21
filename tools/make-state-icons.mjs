/**
 * Generates the little corner badges Discord shows on the artwork.
 *
 * These are served from the repository over raw.githubusercontent.com rather
 * than uploaded to the developer portal, because Discord proxies external
 * asset URLs (verified: it rewrites them to `mp:external/...`). That keeps the
 * badges working for anyone who runs Overtone, without every user having to
 * upload art assets to their own application first.
 *
 *     node tools/make-state-icons.mjs
 *
 * Committed output, so a clone needs no build step to get working badges.
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'img', 'state');
const SIZE = 128;
const SUPERSAMPLE = 4;

// --------------------------------------------------------------- PNG encoding

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- geometry
// Everything works in a -1..1 square, so shapes stay independent of pixel size.

const inCircle = (x, y, r) => x * x + y * y <= r * r;

/** Signed distance to a line segment, for stroked shapes. */
function distanceToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared
    ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared))
    : 0;
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(x - px, y - py);
}

/** Point-in-triangle by consistent winding sign. */
function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const side = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
  const d1 = side(ax, ay, bx, by);
  const d2 = side(bx, by, cx, cy);
  const d3 = side(cx, cy, ax, ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

const GLYPHS = {
  /** Play: a triangle, nudged right so it looks centred rather than measured. */
  playing: (x, y) =>
    x >= -0.30 && x <= 0.42 && Math.abs(y) <= (0.42 - x) * 0.62,

  /** Pause: two bars. */
  paused: (x, y) =>
    Math.abs(y) <= 0.40 && ((x >= -0.34 && x <= -0.10) || (x >= 0.10 && x <= 0.34)),

  /**
   * Loop: a ring broken at the top right, with an arrowhead closing it.
   * A true repeat glyph needs bezier work; an open ring reads the same at the
   * 20-odd pixels Discord actually renders this at.
   */
  loop: (x, y) => {
    const radius = Math.hypot(x, y);
    const onRing = radius > 0.30 && radius < 0.46;
    const angle = Math.atan2(y, x);
    const inGap = angle > -1.30 && angle < -0.20;
    if (onRing && !inGap) return true;
    // A proper arrowhead closing the gap: a stroked stub reads as a stray tab.
    return inTriangle(x, y, 0.16, -0.56, 0.16, -0.18, 0.56, -0.37);
  },

  /** Live: a solid dot. */
  live: (x, y) => inCircle(x, y, 0.30),
};

const BACKGROUND = { playing: [24, 26, 32], paused: [24, 26, 32], loop: [24, 26, 32], live: [200, 40, 40] };

function render(name) {
  const glyph = GLYPHS[name];
  const [br, bg, bb] = BACKGROUND[name];
  const rgba = Buffer.alloc(SIZE * SIZE * 4);

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let inside = 0;
      let mark = 0;

      // Supersample, because a hard circle edge at this size is visibly jagged.
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const u = ((px + (sx + 0.5) / SUPERSAMPLE) / SIZE) * 2 - 1;
          const v = ((py + (sy + 0.5) / SUPERSAMPLE) / SIZE) * 2 - 1;
          if (!inCircle(u, v, 0.98)) continue;
          inside += 1;
          if (glyph(u, v)) mark += 1;
        }
      }

      const total = SUPERSAMPLE * SUPERSAMPLE;
      const coverage = inside / total;
      const glyphShare = mark / total;
      const offset = (py * SIZE + px) * 4;

      if (coverage === 0) continue;

      // Blend white glyph over the badge colour, both weighted by coverage.
      const t = glyphShare / coverage;
      rgba[offset] = Math.round(br + (255 - br) * t);
      rgba[offset + 1] = Math.round(bg + (255 - bg) * t);
      rgba[offset + 2] = Math.round(bb + (255 - bb) * t);
      rgba[offset + 3] = Math.round(coverage * 255);
    }
  }

  return encodePng(SIZE, SIZE, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
for (const name of Object.keys(GLYPHS)) {
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, render(name));
  console.log(`${name.padEnd(9)} -> ${path.relative(process.cwd(), file)}`);
}
