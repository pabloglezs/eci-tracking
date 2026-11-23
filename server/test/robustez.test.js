import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { upsertProduct } from '../src/store.js';
import { checkProduct, runDailyCheck } from '../src/checker.js';
import { fetchProduct, parseProductHtml, parseRetryAfter, ScrapeError } from '../src/scraper.js';
import { maybeAlertAdmin, runProblem } from '../src/adminAlerts.js';

const TZ = 'Europe/Madrid';
const P = { id: 'A111111111-2222222222', url: 'https://www.elcorteingles.es/electronica/A111111111-2222222222-pr-x/', name: 'X' };
const mk = (n) => ({ id: `A${String(n).padStart(9, '0')}-1`, url: `https://www.elcorteingles.es/e/A${String(n).padStart(9, '0')}-1-pr-x/`, name: `P${n}` });

const ld = (offers) =>
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Móvil', offers })}</script>`;
const res = (status, body = '', headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});
const OK_HTML = ld({ price: 50, availability: 'https://schema.org/InStock' });

test('parseProductHtml: stock y precio tachado (estructura real de ECI)', () => {
  const offers = (availability) => ({
    '@type': 'Offer',
    availability,
    price: 599.9,
    priceSpecification: [{ '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: 909 }],
  });
  const a = parseProductHtml(ld(offers('https://schema.org/InStock')));
  assert.equal(a.inStock, true);
  assert.equal(a.originalPrice, 909);
  const b = parseProductHtml(ld(offers('https://schema.org/SoldOut')));
  assert.equal(b.inStock, false);
  // sin availability => desconocido; tachado menor o igual al precio => se ignora
  const c = parseProductHtml(ld({ price: 100, priceSpecification: [{ priceType: 'https://schema.org/StrikethroughPrice', price: 80 }] }));
  assert.equal(c.inStock, null);
  assert.equal(c.originalPrice, null);
  // un precio que aparece fuera del JSON-LD (recomendados) no se usa
  const d = parseProductHtml(`${ld({ price: 10 })}<div class="rec"><span>"price":5</span><s>99,00 €</s></div>`);
  assert.equal(d.price, 10);
  assert.equal(d.originalPrice, null);
});

test('fetchProduct reintenta 5xx/429/red con backoff y respeta Retry-After', async () => {
  const waits = [];
  const wait = async (ms) => waits.push(ms);
  const seq = [res(503), res(429, '', { 'retry-after': '30' }), res(200, OK_HTML)];
  let calls = 0;
  const r = await fetchProduct('u', { fetchImpl: async () => seq[calls++], wait, baseDelayMs: 100, retries: 2 });
  assert.equal(r.price, 50);
  assert.equal(calls, 3);
  assert.ok(waits[0] >= 75 && waits[0] <= 125);
  assert.equal(waits[1], 30_000); // Retry-After manda sobre el backoff (200 ms)

  // error de red y luego éxito
  let n = 0;
  const r2 = await fetchProduct('u', {
    fetchImpl: async () => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return res(200, OK_HTML);
    },
    wait,
    retries: 1,
  });
  assert.equal(r2.price, 50);
});

test('fetchProduct: agota reintentos; no reintenta 403/404/410', async () => {
  let calls = 0;
  await assert.rejects(fetchProduct('u', { fetchImpl: async () => (calls++, res(500)), wait: async () => {}, retries: 2 }), /HTTP 500/);
  assert.equal(calls, 3);
  for (const st of [403, 404, 410]) {
    calls = 0;
    const err = await fetchProduct('u', { fetchImpl: async () => (calls++, res(st)), wait: async () => {}, retries: 3 }).catch((e) => e);
    assert.equal(calls, 1);
    assert.equal(err.gone, st !== 403);
  }
  assert.equal(parseRetryAfter('abc'), null);
  assert.equal(parseRetryAfter('9999'), 60_000);
});

test('descatalogados: N días de 404 => gone; no cuenta dos veces el mismo día; 200 reactiva', async () => {
  const db = openDb(':memory:');
  const { product } = upsertProduct(db, P);
  const gone = async () => {
    throw new ScrapeError('HTTP 404', { gone: true });
  };
  const get = () => db.prepare('SELECT status, gone_count FROM products').get();
  await checkProduct(db, product, { scrape: gone, tz: TZ, goneAfter: 2 });
  await checkProduct(db, product, { scrape: gone, tz: TZ, goneAfter: 2 }); // mismo día: no suma
  assert.deepEqual({ ...get() }, { status: 'active', gone_count: 1 });
  db.prepare(`UPDATE products SET gone_day = '2000-01-01'`).run();
  await checkProduct(db, product, { scrape: gone, tz: TZ, goneAfter: 2 });
  assert.equal(get().status, 'gone');

  // la pasada diaria lo omite (recién comprobado) pero conserva el histórico
  const called = [];
  const stats = await runDailyCheck(db, { scrape: async (u) => (called.push(u), { price: 5 }), tz: TZ, delay: [0, 0] });
  assert.equal(called.length, 0);
  assert.equal(stats.checked, 0);
  assert.equal(db.prepare('SELECT skipped FROM check_runs ORDER BY id DESC').get().skipped, 1);

  // un 200 reactiva
  await checkProduct(db, product, { scrape: async () => ({ price: 5 }), tz: TZ });
  assert.deepEqual({ ...get() }, { status: 'active', gone_count: 0 });
});

test('la pasada diaria sondea productos gone cuando toca (recheck)', async () => {
  const db = openDb(':memory:');
  upsertProduct(db, P);
  db.prepare(`UPDATE products SET status = 'gone', last_checked_at = ?`).run(new Date(Date.now() - 10 * 864e5).toISOString());
  const called = [];
  await runDailyCheck(db, { scrape: async (u) => (called.push(u), { price: 5 }), tz: TZ, delay: [0, 0] });
  assert.equal(called.length, 1);
  assert.equal(db.prepare('SELECT status FROM products').get().status, 'active');
});

test('sin stock: no se registra precio, se guarda in_stock y no se repite hoy', async () => {
  const db = openDb(':memory:');
  const { product } = upsertProduct(db, P);
  const scrape = async () => ({ price: 999, inStock: false, originalPrice: 1400 });
  const r = await checkProduct(db, product, { scrape, tz: TZ });
  assert.equal(r.outOfStock, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM prices').get().n, 0);
  const row = db.prepare('SELECT in_stock, original_price, fail_count FROM products').get();
  assert.deepEqual({ ...row }, { in_stock: 0, original_price: 1400, fail_count: 0 });

  let calls = 0;
  await runDailyCheck(db, { scrape: async () => (calls++, { price: 1 }), tz: TZ, delay: [0, 0] });
  assert.equal(calls, 0);

  // vuelve el stock: se registra
  await checkProduct(db, product, { scrape: async () => ({ price: 900, inStock: true, originalPrice: null }), tz: TZ });
  assert.equal(db.prepare('SELECT price FROM prices').get().price, 900);
  assert.equal(db.prepare('SELECT in_stock s, original_price o FROM products').get().s, 1);
});

test('GET /api/products/:id expone status, inStock y originalPrice', async () => {
  const db = openDb(':memory:');
  const { product } = upsertProduct(db, P);
  const app = await buildApp({ db, serveStatic: false });
  let p = (await app.inject({ url: `/api/products/${P.id}` })).json().product;
  assert.equal(p.status, 'active');
  assert.equal(p.inStock, null);
  assert.equal(p.originalPrice, null);
  await checkProduct(db, product, { scrape: async () => ({ price: 10, inStock: true, originalPrice: 20 }), tz: TZ });
  p = (await app.inject({ url: `/api/products/${P.id}` })).json().product;
  assert.deepEqual([p.inStock, p.originalPrice], [true, 20]);
});

test('alerta al admin: umbral, sin éxitos y máximo 1 al día', () => {
  const db = openDb(':memory:');
  const o = { adminEmail: 'admin@x.com', tz: TZ };
  assert.equal(runProblem({ ok: 1, failed: 1 }), null); // muestra pequeña
  assert.match(runProblem({ ok: 0, failed: 5 }), /0 éxitos/);
  assert.equal(runProblem({ ok: 9, failed: 1 }), null);
  assert.match(runProblem({ ok: 4, failed: 6 }), /60%/);

  assert.equal(maybeAlertAdmin(db, { ok: 10, failed: 0 }, o), false);
  assert.equal(maybeAlertAdmin(db, { ok: 0, failed: 5 }, { ...o, adminEmail: '' }), false);
  assert.equal(maybeAlertAdmin(db, { ok: 0, failed: 5 }, o), true);
  assert.equal(maybeAlertAdmin(db, { ok: 0, failed: 5 }, o), false); // ya avisado hoy
  const q = db.prepare('SELECT * FROM email_queue').all();
  assert.equal(q.length, 1);
  assert.equal(q[0].to_email, 'admin@x.com');
  // otro día: vuelve a avisar
  assert.equal(maybeAlertAdmin(db, { ok: 0, failed: 5 }, { ...o, now: new Date(Date.now() + 2 * 864e5) }), true);
});

test('runDailyCheck registra check_runs y avisa al admin si todo falla', async () => {
  const db = openDb(':memory:');
  for (let i = 1; i <= 3; i++) upsertProduct(db, mk(i));
  const prev = config.adminEmail;
  config.adminEmail = 'admin@x.com';
  try {
    const s = await runDailyCheck(db, { scrape: async () => { throw new ScrapeError('HTTP 403'); }, tz: TZ, delay: [0, 0] });
    assert.equal(s.failed, 3);
    const run = db.prepare('SELECT * FROM check_runs').get();
    assert.deepEqual([run.ok, run.failed, run.skipped], [0, 3, 0]);
    assert.ok(run.finished_at);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM email_queue WHERE to_email = 'admin@x.com'`).get().n, 1);
  } finally {
    config.adminEmail = prev;
  }
});

test('GET /api/admin/stats exige ADMIN_TOKEN', async () => {
  const db = openDb(':memory:');
  upsertProduct(db, P);
  db.prepare('INSERT INTO check_runs (started_at, finished_at, ok, failed, skipped) VALUES (?,?,?,?,?)').run('a', 'b', 4, 1, 2);
  const app = await buildApp({ db, serveStatic: false });
  const prev = config.adminToken;
  try {
    config.adminToken = '';
    assert.equal((await app.inject({ url: '/api/admin/stats' })).statusCode, 403);
    config.adminToken = 's3cret';
    assert.equal((await app.inject({ url: '/api/admin/stats', headers: { 'x-admin-token': 'nope' } })).statusCode, 403);
    const r = await app.inject({ url: '/api/admin/stats', headers: { 'x-admin-token': 's3cret' } });
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.equal(j.products.total, 1);
    assert.equal(j.runs[0].ok, 4);
  } finally {
    config.adminToken = prev;
  }
});

// ---- Marketplace (MP_...) ----
const mpHtml = (variants, extra = '') => `<html>${extra}<script type="application/ld+json">${JSON.stringify([
  { '@type': 'BreadcrumbList', itemListElement: [{ position: 1, item: { name: 'Deportes' } }, { position: 2, item: { name: 'Ropa deportiva' } }] },
  { '@type': 'ProductGroup', name: 'Sudadera The North Face - Negro', productGroupID: 'MP_0538405_NF0A8FXA', image: 'https://dam/x.jpg', hasVariant: variants },
])}</script></html>`;
const variant = (size, price, availability, strike) => ({
  '@type': 'Product',
  size,
  offers: {
    '@type': 'Offer',
    availability: `https://schema.org/${availability}`,
    price,
    ...(strike && { priceSpecification: [{ priceType: 'https://schema.org/StrikethroughPrice', price: strike }] }),
  },
});

test('parseProductUrl e ids: catálogo y marketplace', async () => {
  const { parseProductUrl, PRODUCT_ID_RE } = await import('../src/products.js');
  const u = 'https://www.elcorteingles.es/deportes/MP_0538405_NF0A8FXA-negro-pr-sudadera-the-north-face/?x=1';
  assert.deepEqual(parseProductUrl(u), {
    id: 'MP_0538405_NF0A8FXA',
    url: 'https://www.elcorteingles.es/deportes/MP_0538405_NF0A8FXA-negro-pr-sudadera-the-north-face/',
  });
  assert.equal(parseProductUrl('https://www.elcorteingles.es/e/A202047813-8806097827146-pr-x/').id, 'A202047813-8806097827146');
  for (const ok of ['A202047813-8806097827146', 'A12345678', 'MP_0538405_NF0A8FXA']) assert.ok(PRODUCT_ID_RE.test(ok), ok);
  for (const bad of ['MP_0538405', 'MP_x_NF0', 'MP_0538405_NF0A8FXA-negro', 'xA12345678', "A123456'; --"]) assert.ok(!PRODUCT_ID_RE.test(bad), bad);
  // /api/tracked acepta ids de marketplace
  const db = openDb(':memory:');
  upsertProduct(db, { id: 'MP_0538405_NF0A8FXA', url: u });
  const app = await buildApp({ db, serveStatic: false });
  const r = await app.inject({ url: '/api/tracked?ids=MP_0538405_NF0A8FXA,MP_1_ZZZ,basura' });
  assert.deepEqual(r.json().tracked, ['MP_0538405_NF0A8FXA']);
});

test('marketplace: precio, tachado, stock y categorías desde el ProductGroup', () => {
  const r = parseProductHtml(
    mpHtml(
      [variant('XS', 41.99, 'InStock', 69.99), variant('S', 41.99, 'InStock', 69.99)],
      '<div>"price":1.5 "sale_price":9.9 <s>99,00 €</s></div>', // ruido de recomendados
    ),
  );
  assert.deepEqual(
    { ...r },
    { name: 'Sudadera The North Face - Negro', image: 'https://dam/x.jpg', price: 41.99, inStock: true, originalPrice: 69.99, categories: ['Deportes', 'Ropa deportiva'] },
  );
});

test('marketplace: tallas sin stock se ignoran; todas agotadas => inStock false; sin tachado', () => {
  const some = parseProductHtml(mpHtml([variant('XS', 30, 'OutOfStock'), variant('L', 44.99, 'InStock')]));
  assert.deepEqual([some.price, some.inStock, some.originalPrice], [44.99, true, null]);
  const none = parseProductHtml(mpHtml([variant('XS', 44.99, 'OutOfStock'), variant('L', 44.99, 'OutOfStock')]));
  assert.deepEqual([none.price, none.inStock], [44.99, false]);
  assert.throws(() => parseProductHtml(mpHtml([{ '@type': 'Product', offers: {} }])), /No se encontró el precio/);
});
