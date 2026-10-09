// tools/generate-icons.mjs — one-off PWA icon generator (design §12)
//
// Zero npm dependencies: uses only Node built-ins (zlib + Buffer + fs/path).
// Builds valid non-empty PNGs by hand (signature, IHDR, single IDAT with raw
// RGBA scanlines each prefixed by filter byte 0, IEND) with a correct CRC32
// per chunk. Draws a rounded-square brand background (#2e7d5b) with a simple
// shopping-basket glyph (trapezoid body + handle arc + slats) via in-JS
// rasterization. Writes icons/icon-192.png and icons/icon-512.png.
//
// Run once: `node tools/generate-icons.mjs`. The two PNGs are committed; this
// script is never shipped to or imported by the app.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'icons');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Brand palette (RGB).
const BRAND = [0x2e, 0x7d, 0x5b];
const GLYPH = [0xff, 0xff, 0xff];

// ---------------- CRC32 ----------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------- PNG chunk assembly ----------------
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.writeUInt8(8, 8); // bit depth
  data.writeUInt8(6, 9); // color type 6 = RGBA
  data.writeUInt8(0, 10); // compression
  data.writeUInt8(0, 11); // filter
  data.writeUInt8(0, 12); // interlace
  return chunk('IHDR', data);
}

// Build a PNG Buffer from an RGBA pixel buffer (width*height*4).
function encodePng(width, height, rgba) {
  // Raw raster: one filter byte (0) per scanline + the RGBA row.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rawOff = y * (stride + 1);
    raw[rawOff] = 0; // filter type 0 (None)
    rgba.copy(raw, rawOff + 1, y * stride, y * stride + stride);
  }
  const idatData = deflateSync(raw);
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- Rasterization ----------------
function makeCanvas(size) {
  // RGBA, fully transparent to start.
  return Buffer.alloc(size * size * 4);
}

function setPixel(buf, size, x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const off = (y * size + x) * 4;
  buf[off] = r;
  buf[off + 1] = g;
  buf[off + 2] = b;
  buf[off + 3] = a;
}

// Filled rounded square covering the whole icon.
function fillRoundedSquare(buf, size, color, radius) {
  const r = radius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = true;
      // Check the four rounded corners.
      if (x < r && y < r) {
        inside = (r - x) ** 2 + (r - y) ** 2 <= r * r;
      } else if (x >= size - r && y < r) {
        const cx = size - r - 1;
        inside = (x - cx) ** 2 + (r - y) ** 2 <= r * r;
      } else if (x < r && y >= size - r) {
        const cy = size - r - 1;
        inside = (r - x) ** 2 + (y - cy) ** 2 <= r * r;
      } else if (x >= size - r && y >= size - r) {
        const cx = size - r - 1;
        const cy = size - r - 1;
        inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      }
      if (inside) setPixel(buf, size, x, y, color);
    }
  }
}

// Draw the shopping-basket glyph (relative coords scaled to `size`).
function drawBasket(buf, size) {
  const u = size / 100; // scale unit: coords expressed on a 0..100 grid
  const px = (v) => Math.round(v * u);

  // Handle arc: a ring segment from ~left to ~right above the basket body.
  const handleCx = 50;
  const handleCy = 42;
  const handleOuter = 24;
  const handleInner = 20;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x / u;
      const gy = y / u;
      const dx = gx - handleCx;
      const dy = gy - handleCy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Upper half ring (handle sits above body line gy <= handleCy).
      if (gy <= handleCy && dist <= handleOuter && dist >= handleInner) {
        setPixel(buf, size, x, y, GLYPH);
      }
    }
  }

  // Basket body: a trapezoid (wider at top, narrower at bottom).
  const topY = 42;
  const bottomY = 76;
  const topHalf = 34; // half-width at top
  const bottomHalf = 24; // half-width at bottom
  for (let gy = topY; gy <= bottomY; gy++) {
    const t = (gy - topY) / (bottomY - topY);
    const half = topHalf + (bottomHalf - topHalf) * t;
    const xStart = px(50 - half);
    const xEnd = px(50 + half);
    const yPix = px(gy);
    for (let x = xStart; x <= xEnd; x++) {
      setPixel(buf, size, x, yPix, GLYPH);
    }
  }

  // Top rim of the basket (a solid bar across the top of the body).
  const rimY0 = px(40);
  const rimY1 = px(44);
  const rimX0 = px(50 - topHalf - 3);
  const rimX1 = px(50 + topHalf + 3);
  for (let y = rimY0; y <= rimY1; y++) {
    for (let x = rimX0; x <= rimX1; x++) {
      setPixel(buf, size, x, y, GLYPH);
    }
  }

  // Vertical slats (cut-outs) by punching brand-colored lines into the body.
  for (const gx of [38, 50, 62]) {
    const xPix = px(gx);
    for (let w = 0; w < Math.max(1, px(1.5)); w++) {
      for (let gy = topY + 4; gy <= bottomY - 2; gy++) {
        setPixel(buf, size, xPix + w, px(gy), BRAND);
      }
    }
  }
}

function generateIcon(size) {
  const buf = makeCanvas(size);
  fillRoundedSquare(buf, size, BRAND, Math.round(size * 0.22));
  drawBasket(buf, size);
  return encodePng(size, size, buf);
}

// ---------------- Main ----------------
function main() {
  mkdirSync(ICONS_DIR, { recursive: true });
  const targets = [
    { size: 192, file: 'icon-192.png' },
    { size: 512, file: 'icon-512.png' },
  ];
  for (const { size, file } of targets) {
    const png = generateIcon(size);
    const out = join(ICONS_DIR, file);
    writeFileSync(out, png);
    console.log(`wrote ${file} (${size}x${size}, ${png.length} bytes)`);
  }
}

main();
