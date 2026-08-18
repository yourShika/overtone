/**
 * Icon generator.
 *
 * Writes every PNG the project needs from code, with nothing but node:zlib.
 * Committing generated binaries would work too, but this way the brand mark is
 * a 20-line function you can tweak instead of an opaque blob — change the
 * gradient or the bars below and re-run `npm run icons`.
 *
 * Usage: node tools/make-icons.mjs
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Supersampling factor for anti-aliasing. 4x4 = 16 samples per pixel. */
const SS = 4;

// ---------------------------------------------------------------- PNG writer

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
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

/** @param {number} width @param {number} height @param {Buffer} rgba */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  // Each scanline is prefixed with a filter byte; 0 = none.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ drawing

/**
 * The Overtone mark: a rounded square with a violet gradient and five white
 * bars of varying height — a level meter, which reads as "media" at 16px where
 * anything more detailed turns to mush.
 */
const BAR_HEIGHTS = [0.42, 0.68, 1.0, 0.74, 0.5];

function sample(u, v, { mono }) {
  // u, v are 0..1 across the icon.
  const radius = 0.22;
  if (!insideRoundedSquare(u, v, radius)) return null;

  const bg = mono
    ? [255, 255, 255, 255]
    : gradient(u, v);

  // Bar geometry, in icon-relative units.
  const barCount = BAR_HEIGHTS.length;
  const areaLeft = 0.235;
  const areaRight = 0.765;
  const areaWidth = areaRight - areaLeft;
  const slot = areaWidth / barCount;
  const barWidth = slot * 0.52;
  const maxHeight = 0.46;

  for (let i = 0; i < barCount; i++) {
    const centreX = areaLeft + slot * (i + 0.5);
    const halfHeight = (maxHeight * BAR_HEIGHTS[i]) / 2;

    if (Math.abs(u - centreX) > barWidth / 2) continue;
    if (Math.abs(v - 0.5) > halfHeight) continue;

    // Round the bar caps: past the straight section, fall back to a circle.
    const capOverflow = Math.abs(v - 0.5) - (halfHeight - barWidth / 2);
    if (capOverflow > 0 && Math.hypot(u - centreX, capOverflow) > barWidth / 2) continue;

    return [255, 255, 255, 255];
  }

  return bg;
}

function insideRoundedSquare(u, v, radius) {
  const dx = Math.max(radius - u, 0, u - (1 - radius));
  const dy = Math.max(radius - v, 0, v - (1 - radius));
  if (dx === 0 || dy === 0) return true;
  return Math.hypot(dx, dy) <= radius;
}

/** Diagonal violet gradient, matching the settings window's accent. */
function gradient(u, v) {
  const t = Math.min(1, Math.max(0, (u + v) / 2));
  const from = [0x63, 0x54, 0xf0];
  const to = [0xc8, 0x6c, 0xf6];
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
    255,
  ];
}

/** Render one icon at `size` px, supersampled and box-filtered down. */
function render(size, options = {}) {
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const px = sample(u, v, options);
          if (!px) continue;
          // Premultiply so partially covered edges blend correctly.
          r += px[0] * px[3];
          g += px[1] * px[3];
          b += px[2] * px[3];
          a += px[3];
        }
      }

      const samples = SS * SS;
      const offset = (y * size + x) * 4;
      if (a === 0) continue;

      rgba[offset] = Math.round(r / a);
      rgba[offset + 1] = Math.round(g / a);
      rgba[offset + 2] = Math.round(b / a);
      rgba[offset + 3] = Math.round(a / samples);
    }
  }

  if (options.desaturate) desaturate(rgba, options.desaturate);
  return encodePng(size, size, rgba);
}

/** Blend towards luminance — used for the "not connected" tray icon. */
function desaturate(rgba, amount) {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const luma = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    rgba[i] = Math.round(rgba[i] + (luma - rgba[i]) * amount);
    rgba[i + 1] = Math.round(rgba[i + 1] + (luma - rgba[i + 1]) * amount);
    rgba[i + 2] = Math.round(rgba[i + 2] + (luma - rgba[i + 2]) * amount);
  }
}

// -------------------------------------------------------------------- output

const TARGETS = [
  ...[16, 32, 48, 128].map((size) => ({
    file: path.join(ROOT, 'extension', 'icons', `icon-${size}.png`),
    size,
    options: {},
  })),
  ...[16, 32, 256].map((size) => ({
    file: path.join(ROOT, 'agent', 'assets', `icon-${size}.png`),
    size,
    options: {},
  })),
  { file: path.join(ROOT, 'agent', 'assets', 'tray-active.png'), size: 32, options: {} },
  {
    file: path.join(ROOT, 'agent', 'assets', 'tray-idle.png'),
    size: 32,
    options: { desaturate: 0.85 },
  },
];

for (const target of TARGETS) {
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, render(target.size, target.options));
  console.log(`✓ ${path.relative(ROOT, target.file)} (${target.size}×${target.size})`);
}

console.log(`\n${TARGETS.length} Icons erzeugt.`);
