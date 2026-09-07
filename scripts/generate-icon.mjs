// Generates assets/argocd.png. Deliberately an abstract sync mark, not the upstream
// ArgoCD logo, so the repository carries no third-party trademark asset.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 512;
const CENTER = SIZE / 2;
const RADIUS = 168;
const THICKNESS = 52;
const GAP_START = -0.45; // radians, opening where the arrow head sits
const GAP_END = 0.62;
const FG = [239, 123, 77];
const DOT = [51, 116, 186];

function coverage(x, y) {
  // Supersample 3x3 so the curves do not alias on a 512px canvas.
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      const dx = px - CENTER;
      const dy = py - CENTER;
      const dist = Math.hypot(dx, dy);
      const inRing = Math.abs(dist - RADIUS) <= THICKNESS / 2;
      const angle = Math.atan2(dy, dx);
      const inGap = angle > GAP_START && angle < GAP_END;
      if (inRing && !inGap) hits++;
    }
  }
  return hits / 9;
}

function arrowCoverage(x, y) {
  // Triangle closing the ring, pointing clockwise.
  const tip = [CENTER + RADIUS * Math.cos(GAP_END) + 6, CENTER + RADIUS * Math.sin(GAP_END) + 46];
  const a = [CENTER + (RADIUS + THICKNESS) * Math.cos(GAP_START), CENTER + (RADIUS + THICKNESS) * Math.sin(GAP_START)];
  const b = [CENTER + (RADIUS - THICKNESS) * Math.cos(GAP_START), CENTER + (RADIUS - THICKNESS) * Math.sin(GAP_START)];
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const p = [x + (sx + 0.5) / 3, y + (sy + 0.5) / 3];
      const s = sign(p, a, b);
      const t = sign(p, b, tip);
      const u = sign(p, tip, a);
      const hasNeg = s < 0 || t < 0 || u < 0;
      const hasPos = s > 0 || t > 0 || u > 0;
      if (!(hasNeg && hasPos)) hits++;
    }
  }
  return hits / 9;
}

function sign(p, q, r) {
  return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
}

function dotCoverage(x, y) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const dx = x + (sx + 0.5) / 3 - CENTER;
      const dy = y + (sy + 0.5) / 3 - CENTER;
      if (Math.hypot(dx, dy) <= 62) hits++;
    }
  }
  return hits / 9;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let offset = 0;
for (let y = 0; y < SIZE; y++) {
  raw[offset++] = 0; // filter type none
  for (let x = 0; x < SIZE; x++) {
    const ring = Math.min(1, coverage(x, y) + arrowCoverage(x, y));
    const dot = dotCoverage(x, y);
    let color = [0, 0, 0];
    let alpha = 0;
    if (dot > 0) {
      color = DOT;
      alpha = dot;
    }
    if (ring > alpha) {
      color = FG;
      alpha = ring;
    }
    raw[offset++] = color[0];
    raw[offset++] = color[1];
    raw[offset++] = color[2];
    raw[offset++] = Math.round(alpha * 255);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../assets/argocd.png", import.meta.url), png);
console.log(`assets/argocd.png ${png.length} bytes`);
