// Siembra datos sintéticos en una BD (para probar la web y medir el listado).
// Uso: node scripts/seed-demo.js <ruta.db> [productos=200] [días=90]
import { openDb, today } from '../src/db.js';

const [path, nArg, dArg] = process.argv.slice(2);
if (!path) throw new Error('Uso: node scripts/seed-demo.js <ruta.db> [productos] [días]');
const N = Number(nArg) || 200;
const DAYS = Number(dArg) || 90;
const TZ = process.env.TZ_APP || 'Europe/Madrid';

const CATS = {
  Electrónica: ['Móviles', 'Portátiles', 'Televisores', 'Auriculares'],
  Hogar: ['Cocina', 'Electrodomésticos', 'Decoración'],
  Moda: ['Zapatillas', 'Camisetas'],
  Deportes: ['Running', 'Fitness'],
  Juguetes: ['Construcción'],
};
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const db = openDb(path);
const ins = db.prepare(
  'INSERT OR REPLACE INTO products (id, url, name, image, category, subcategory, created_at, last_checked_at) VALUES (?,?,?,?,?,?,?,?)',
);
const insP = db.prepare('INSERT OR REPLACE INTO prices (product_id, day, price, checked_at) VALUES (?,?,?,?)');
const cats = Object.keys(CATS);
db.exec('BEGIN');
for (let i = 0; i < N; i++) {
  const id = `A${String(100000000 + i)}-${String(2000000000 + i)}`;
  const withCat = rnd() > 0.1;
  const cat = withCat ? cats[Math.floor(rnd() ** 2 * cats.length)] : null;
  const sub = withCat && rnd() > 0.15 ? CATS[cat][Math.floor(rnd() * CATS[cat].length)] : null;
  const created = new Date(Date.now() - rnd() * DAYS * 864e5).toISOString();
  ins.run(id, `https://www.elcorteingles.es/demo/${id}-pr-x/`, `Producto demo ${i} ${cat ?? ''} ${sub ?? ''}`.trim(),
    null, cat, sub, created, new Date().toISOString());
  let price = Math.round((20 + rnd() * 900) * 100) / 100;
  const start = rnd() < 0.15 ? 0 : 1; // algunos sin precio aún
  if (!start && rnd() < 0.5) continue;
  for (let d = DAYS - 1; d >= 0; d--) {
    const r = rnd();
    if (r < 0.06) price = Math.round(price * (0.8 + rnd() * 0.15) * 100) / 100;
    else if (r < 0.1) price = Math.round(price * (1.03 + rnd() * 0.1) * 100) / 100;
    const day = today(TZ, new Date(Date.now() - d * 864e5));
    insP.run(id, day, price, new Date().toISOString());
  }
}
db.exec('COMMIT');
console.log(`Sembrados ${N} productos x ${DAYS} días en ${path}`);
