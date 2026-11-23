import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { recordPrice, upsertProduct, addSubscription } from '../src/store.js';
import { checkProduct } from '../src/checker.js';
import { processQueue } from '../src/mailer.js';

const post = (app, url, token) => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${token}` });
const TZ = 'Europe/Madrid';
const day = (s) => new Date(`${s}T12:00:00Z`);
const P = {
  id: 'A111111111-2222222222',
  url: 'https://www.elcorteingles.es/electronica/A111111111-2222222222-pr-x/',
  name: 'Producto X',
};

test('recordPrice detecta bajada respecto al día anterior y no duplica avisos', () => {
  const db = openDb(':memory:');
  upsertProduct(db, P);
  assert.equal(recordPrice(db, P.id, 100, TZ, day('2026-03-01')).dropped, false); // primer precio
  assert.equal(recordPrice(db, P.id, 100, TZ, day('2026-03-02')).dropped, false); // igual
  assert.equal(recordPrice(db, P.id, 90, TZ, day('2026-03-03')).dropped, true); // baja
  assert.equal(recordPrice(db, P.id, 90, TZ, day('2026-03-03')).dropped, false); // recomprobación mismo día
  assert.equal(recordPrice(db, P.id, 95, TZ, day('2026-03-04')).dropped, false); // sube
});

test('bajada de precio => cola de emails => envío a todos los suscriptores', async () => {
  const db = openDb(':memory:');
  const { product } = upsertProduct(db, P);
  addSubscription(db, P.id, 'a@x.com', 'tok-a-0123456789abcdef', { confirmed: true });
  addSubscription(db, P.id, 'b@x.com', 'tok-b-0123456789abcdef', { confirmed: true });
  recordPrice(db, P.id, 100, TZ, new Date(Date.now() - 864e5 * 2)); // antes de hoy

  const r = await checkProduct(db, product, { scrape: async () => ({ price: 80 }), tz: TZ });
  assert.equal(r.ok, true);
  assert.equal(r.dropped, true);

  const queued = db.prepare('SELECT * FROM email_queue').all();
  assert.equal(queued.length, 2);
  assert.match(queued[0].subject, /80,00/);

  const sentTo = [];
  const res = await processQueue(db, { send: async (m) => sentTo.push(m.to_email), delayMs: 0 });
  assert.equal(res.sent, 2);
  assert.deepEqual(sentTo.sort(), ['a@x.com', 'b@x.com']);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM email_queue WHERE status='sent'`).get().n, 2);
});

test('checkProduct guarda categoría/subcategoría y las conserva si luego no vienen', async () => {
  const db = openDb(':memory:');
  const { product } = upsertProduct(db, P);
  const cats = ['Electrónica', 'Móviles', 'Móviles 5G'];
  await checkProduct(db, product, { scrape: async () => ({ price: 10, categories: cats }), tz: TZ });
  let row = db.prepare('SELECT category, subcategory, category_path FROM products').get();
  assert.deepEqual({ ...row }, { category: 'Electrónica', subcategory: 'Móviles', category_path: 'Electrónica › Móviles › Móviles 5G' });
  await checkProduct(db, product, { scrape: async () => ({ price: 10, categories: [] }), tz: TZ });
  assert.equal(db.prepare('SELECT category FROM products').get().category, 'Electrónica');
  const app = await buildApp({ db, serveStatic: false });
  const list = (await app.inject({ url: '/api/products' })).json().products;
  assert.equal(list[0].category, 'Electrónica');
  assert.equal(list[0].subcategory, 'Móviles');
  await app.close();
});

test('un fallo de envío reintenta y acaba en failed', async () => {
  const db = openDb(':memory:');
  upsertProduct(db, P);
  addSubscription(db, P.id, 'a@x.com', 'tok-a-0123456789abcdef');
  db.prepare(`INSERT INTO email_queue (to_email, subject, text, html, created_at) VALUES ('a@x.com','s','t','h','now')`).run();
  for (let i = 0; i < 5; i++) await processQueue(db, { send: async () => { throw new Error('smtp down'); }, delayMs: 0 });
  const m = db.prepare('SELECT status, attempts, error FROM email_queue').get();
  assert.equal(m.status, 'failed');
  assert.equal(m.attempts, 5);
});

test('API /api/tracked devuelve sólo los ids ya seguidos y descarta basura', async () => {
  const db = openDb(':memory:');
  upsertProduct(db, P);
  const app = await buildApp({ db, serveStatic: false });
  const ids = [P.id, 'A999999999-8888888888', "x'); DROP TABLE products;--", 'A123'].map(encodeURIComponent).join(',');
  const r = (await app.inject({ url: `/api/tracked?ids=${ids}` })).json();
  assert.deepEqual(r.tracked, [P.id]);
  assert.deepEqual((await app.inject({ url: '/api/tracked' })).json().tracked, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 1);
  await app.close();
});

test('API: alta, consulta, suscripción y baja', async () => {
  const db = openDb(':memory:');
  const app = await buildApp({ db, serveStatic: false });

  const bad = await app.inject({ method: 'POST', url: '/api/products', payload: { url: 'https://example.com/A12345678-x/' } });
  assert.equal(bad.statusCode, 400);

  const add = await app.inject({
    method: 'POST',
    url: '/api/products',
    payload: { url: P.url + '?utm=1', name: P.name, price: 120, image: 'https://evil.com/x.jpg' },
  });
  assert.equal(add.statusCode, 201);
  assert.equal(add.json().product.id, P.id);

  const again = await app.inject({ method: 'POST', url: '/api/products', payload: { url: P.url } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().created, false);

  const detail = (await app.inject({ url: `/api/products/${P.id}` })).json();
  assert.equal(detail.stats.current, 120);
  assert.equal(detail.product.image, null); // imagen de dominio ajeno descartada
  assert.equal(detail.history.length, 1);

  assert.equal((await app.inject({ url: '/api/products/NOPE' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/products?deals=1' })).json().products.length, 0);
  assert.equal((await app.inject({ url: '/api/products?q=producto' })).json().products.length, 1);
  assert.equal((await app.inject({ url: '/api/products?q=%25' })).json().products.length, 0); // % no es comodín

  const badMail = await app.inject({ method: 'POST', url: `/api/products/${P.id}/subscribe`, payload: { email: 'nope' } });
  assert.equal(badMail.statusCode, 400);
  const sub = await app.inject({ method: 'POST', url: `/api/products/${P.id}/subscribe`, payload: { email: 'A@X.com' } });
  const sub2 = await app.inject({ method: 'POST', url: `/api/products/${P.id}/subscribe`, payload: { email: 'a@x.com' } });
  assert.deepEqual(sub.json(), sub2.json()); // misma respuesta exista o no la suscripción
  const { token, confirmed_at } = db.prepare('SELECT token, confirmed_at FROM subscriptions').get();
  assert.equal(confirmed_at, null); // pendiente hasta confirmar
  assert.equal((await post(app, '/api/unsubscribe', token)).statusCode, 200);
  assert.equal((await post(app, '/api/unsubscribe', token)).statusCode, 404);
  await app.close();
});
