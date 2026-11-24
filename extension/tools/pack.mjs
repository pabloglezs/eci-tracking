// Empaqueta la extensión para Chrome y Firefox en extension/dist/.
// El manifest.json del repo es la variante Chrome (service worker); la de Firefox
// se deriva aquí (background.scripts + browser_specific_settings).
// Uso: node extension/tools/pack.mjs   (sin dependencias)
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const FILES = ['background.js', 'content.js', 'popup.html', 'popup.js', 'options.html', 'options.js', 'icons'];
const base = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

const variants = {
  chrome: (m) => m,
  firefox: (m) => {
    const { service_worker, ...rest } = m.background;
    return {
      ...m,
      background: { ...rest, scripts: [service_worker] },
      browser_specific_settings: { gecko: { id: 'eci-tracker@selfhosted.invalid', strict_min_version: '115.0' } },
    };
  },
};

// Zip mínimo (deflate) sin dependencias: funciona igual en Windows, macOS y Linux.
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

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((x, y) => x.name.localeCompare(y.name))
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

function zip(dir, file) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const name of listFiles(dir)) {
    const data = readFileSync(join(dir, name));
    const comp = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión
    local.writeUInt16LE(0x0800, 6); // nombres UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0x21, 12); // fecha fija (1980-01-01) para builds reproducibles
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(file, Buffer.concat([...parts, cdBuf, end]));
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const [name, build] of Object.entries(variants)) {
  const stage = join(dist, `.stage-${name}`);
  mkdirSync(stage, { recursive: true });
  for (const f of FILES) cpSync(join(root, f), join(stage, f), { recursive: true });
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(build(structuredClone(base)), null, 2) + '\n');
  const out = join(dist, `eci-tracker-${name}.zip`);
  zip(stage, out);
  rmSync(stage, { recursive: true, force: true });
  console.log(`dist/eci-tracker-${name}.zip`);
}
