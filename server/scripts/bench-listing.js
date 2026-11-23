// Mide listProducts sobre una BD sembrada. Uso: node scripts/bench-listing.js <ruta.db>
import { openDb } from '../src/db.js';
import { listProducts } from '../src/store.js';

const db = openDb(process.argv[2]);
const tz = 'Europe/Madrid';
const n = db.prepare('SELECT COUNT(*) n FROM products').get().n;
const cases = {
  'página 1 (drop)': {},
  'página 50': { page: 50 },
  'sólo ofertas': { dealsOnly: true },
  'q=demo 1 + sort price': { q: 'demo 1', sort: 'price_asc' },
  'cat+sub, near_min': { cat: 'Electrónica', sub: 'Móviles', sort: 'near_min' },
};
console.log(`${n} productos`);
for (const [name, opts] of Object.entries(cases)) {
  listProducts(db, { tz, ...opts });
  const t = performance.now();
  const R = 5;
  let r;
  for (let i = 0; i < R; i++) r = listProducts(db, { tz, ...opts });
  console.log(`${name.padEnd(26)} ${((performance.now() - t) / R).toFixed(1)} ms  total=${r.total}`);
}
