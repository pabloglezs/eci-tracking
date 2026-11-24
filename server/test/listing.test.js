import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, today } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { listProducts, upsertProduct, NO_CATEGORY } from '../src/store.js';
import { computeStats, dealInfo } from '../src/products.js';

const TZ = 'Europe/Madrid';
// Se resta a las 12:00 UTC del día de hoy: restar 24 h a la hora actual falla cerca de medianoche al cruzar un cambio de hora.
const ago = (n) => today(TZ, new Date(new Date(`${today(TZ)}T12:00:00Z`).getTime() - n * 864e5));

function seed(db, id, series, { category = null, subcategory = null, name = id, created } = {}) {
  upsertProduct(db, { id, url: `https://www.elcorteingles.es/x/${id}-pr/`, name });
  db.prepare('UPDATE products SET category = ?, subcategory = ?, created_at = COALESCE(?, created_at) WHERE id = ?').run(
    category, subcategory, created ?? null, id,
  );
  // series: precios del más antiguo al más reciente, uno por día acabando hoy
  series.forEach((price, i) =>
    db.prepare('INSERT INTO prices (product_id, day, price, checked_at) VALUES (?,?,?,?)').run(
      id, ago(series.length - 1 - i), price, new Date().toISOString(),
    ),
  );
}

function fixture() {
  const db = openDb(':memory:');
  seed(db, 'A100000001-1', [100, 100, 80], { category: 'Electrónica', subcategory: 'Móviles', name: 'Móvil A', created: '2026-01-01' });
  seed(db, 'A100000002-1', [50, 60, 60, 60], { category: 'Electrónica', subcategory: 'Portátiles', name: 'Portátil B', created: '2026-01-02' });
  seed(db, 'A100000003-1', [30, 30, 30], { category: 'Hogar', name: 'Cafetera C', created: '2026-01-03' });
  seed(db, 'A100000004-1', [200, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150], { name: 'Tele D', created: '2026-01-04' }); // bajada antigua
  seed(db, 'A100000005-1', [], { category: 'Hogar', name: 'Sin precio E', created: '2026-01-05' });
  return db;
}

test('el SQL del listado coincide con computeStats + dealInfo', () => {
  const db = fixture();
  const { products } = listProducts(db, { tz: TZ, limit: 100 });
  assert.equal(products.length, 5);
  for (const p of products) {
    const rows = db.prepare('SELECT day, price FROM prices WHERE product_id = ? ORDER BY day').all(p.id);
    const stats = computeStats(rows);
    const deal = dealInfo(rows, today(TZ));
    assert.equal(p.price, stats?.current ?? null, p.id);
    assert.equal(p.minPrice, stats?.min.price ?? null, p.id);
    assert.equal(p.maxPrice, stats?.max.price ?? null, p.id);
    assert.equal(p.isDeal, deal.isDeal, p.id);
    assert.equal(p.previousPrice, deal.previousPrice, p.id);
    assert.equal(p.dropPct, deal.dropPct, p.id);
    assert.equal(p.dropDay, deal.dropDay, p.id);
  }
});

test('paginación: total, páginas y sin solapes', () => {
  const db = fixture();
  const p1 = listProducts(db, { tz: TZ, limit: 2, page: 1 });
  const p2 = listProducts(db, { tz: TZ, limit: 2, page: 2 });
  const p3 = listProducts(db, { tz: TZ, limit: 2, page: 3 });
  assert.equal(p1.total, 5);
  assert.equal(p1.pages, 3);
  assert.deepEqual([p1, p2, p3].map((r) => r.products.length), [2, 2, 1]);
  const ids = [...p1.products, ...p2.products, ...p3.products].map((p) => p.id);
  assert.equal(new Set(ids).size, 5);
});

test('orden: bajada, reciente, precio y cercanía al mínimo', () => {
  const db = fixture();
  const ids = (sort) => listProducts(db, { tz: TZ, sort }).products.map((p) => p.id.slice(0, 10));
  assert.deepEqual(ids('drop').slice(0, 1), ['A100000001']); // única oferta (-20%)
  assert.deepEqual(ids('recent'), ['A100000005', 'A100000004', 'A100000003', 'A100000002', 'A100000001']);
  assert.deepEqual(ids('price_asc'), ['A100000003', 'A100000002', 'A100000001', 'A100000004', 'A100000005']);
  assert.deepEqual(ids('price_desc').slice(0, 2), ['A100000004', 'A100000001']);
  // 1, 3 y 4 están en su mínimo (0%), 2 está un 20% sobre él; sin precio al final
  assert.deepEqual(ids('near_min').slice(-2), ['A100000002', 'A100000005']);
  assert.equal(listProducts(db, { tz: TZ, sort: 'inventado' }).products.length, 5); // cae al orden por defecto
});

test('filtros q / deals / cat / sub y contadores de categorías', () => {
  const db = fixture();
  assert.equal(listProducts(db, { tz: TZ, dealsOnly: true }).total, 1);
  assert.equal(listProducts(db, { tz: TZ, q: 'portátil' }).total, 1);
  assert.equal(listProducts(db, { tz: TZ, q: '%' }).total, 0);
  assert.equal(listProducts(db, { tz: TZ, cat: 'Electrónica' }).total, 2);
  assert.equal(listProducts(db, { tz: TZ, cat: 'Electrónica', sub: 'Móviles' }).total, 1);
  assert.equal(listProducts(db, { tz: TZ, cat: NO_CATEGORY }).total, 1);
  const r = listProducts(db, { tz: TZ, cat: 'Hogar', limit: 1 });
  assert.deepEqual(r.categories.map((c) => [c.name, c.count]), [['Electrónica', 2], ['Hogar', 2], [NO_CATEGORY, 1]]);
  assert.deepEqual(r.categories[0].subcategories.map((s) => s.name).sort(), ['Móviles', 'Portátiles']);
  // los contadores respetan q/deals pero no cat
  const d = listProducts(db, { tz: TZ, dealsOnly: true, cat: 'Hogar' });
  assert.deepEqual(d.categories.map((c) => [c.name, c.count]), [['Electrónica', 1]]);
  assert.equal(d.total, 0);
});

test('sparkline: últimos 30 días sólo de la página', () => {
  const db = openDb(':memory:');
  seed(db, 'A100000009-1', Array.from({ length: 45 }, (_, i) => 100 + i));
  const [p] = listProducts(db, { tz: TZ }).products;
  assert.equal(p.spark.length, 30);
  assert.equal(p.spark.at(-1), 144);
  assert.equal(p.spark[0], 115);
});

test('GET /api/products devuelve products[] + total/page/categories y limita limit', async () => {
  const db = fixture();
  const app = await buildApp({ db, serveStatic: false });
  const j = (await app.inject({ url: '/api/products?limit=2&page=2&sort=price_asc&cat=Electr%C3%B3nica' })).json();
  assert.ok(Array.isArray(j.products));
  assert.equal(j.total, 2);
  assert.equal(j.limit, 2);
  assert.ok(Array.isArray(j.categories));
  const big = (await app.inject({ url: '/api/products?limit=99999' })).json();
  assert.equal(big.limit, 100);
  const junk = (await app.inject({ url: '/api/products?page=-3&limit=abc' })).json();
  assert.equal(junk.page, 1);
  await app.close();
});
