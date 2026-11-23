// Genera extension/icons/icon{16,48,128}.png sin dependencias (PNG escrito a mano con zlib).
// Diseño: cuadrado redondeado azul con una línea blanca descendente y flecha (📉).
// Uso: node extension/tools/icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];
const SS = 4; // supersampling para bordes suaves

const distSeg = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// Coordenadas normalizadas 0..1
const LINE = [[0.2, 0.3], [0.42, 0.52], [0.55, 0.42], [0.78, 0.68]];
const HEAD = [[0.8, 0.8], [0.8, 0.62], [0.62, 0.8]]; // punta de flecha (triángulo)

function inTri(p, [a, b, c]) {
  const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function shade(x, y, size) {
  // devuelve [r,g,b,a] 0..1 para el punto normalizado (x,y)
  const r = 0.22; // radio de esquina
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  if (Math.hypot(x - cx, y - cy) > r) return null; // fuera del cuadrado redondeado
  const w = size <= 16 ? 0.13 : 0.085; // grosor de línea
  let white = inTri([x, y], HEAD);
  for (let i = 0; i < LINE.length - 1 && !white; i++) white = distSeg(x, y, LINE[i], LINE[i + 1]) <= w / 2;
  return white ? WHITE : BLUE;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let j = 0; j < size; j++) {
    raw[o++] = 0; // filtro none
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((i + (sx + 0.5) / SS) / size, (j + (sy + 0.5) / SS) / size, size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const n = SS * SS;
      raw[o++] = a ? Math.round(r / a) : 0;
      raw[o++] = a ? Math.round(g / a) : 0;
      raw[o++] = a ? Math.round(b / a) : 0;
      raw[o++] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(out, { recursive: true });
for (const s of [16, 48, 128]) {
  writeFileSync(join(out, `icon${s}.png`), png(s));
  console.log(`icons/icon${s}.png`);
}
