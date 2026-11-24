import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pendingCheckCount, sweepUnpriced } from '../src/checker.js';

const A = (n) => `https://www.elcorteingles.es/electronica/A${String(100000000 + n)}-pr-x/`;
const MP = (n) => `https://www.elcorteingles.es/moda/MP_0538405_NF0A8FX${n}-pr-x/`;
const bulk = (app, payload, headers = {}) => app.inject({ method: 'POST', url: '/api/products/bulk', payload, headers });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drain = async () => {
  for (let i = 0; i < 100 && pendingCheckCount() > 0; i++) await sleep(20);
};
const insert = (db, id, url = 'u') =>
  db.prepare('INSERT INTO products (id,url,created_at) VALUES (?,?,?)').run(id, url, 'x');

async function withApp(fn, overrides = {}, scrape = async () => ({ price: 10 })) {
  const saved = { ...config };
  Object.assign(config, {
    trackPerMinute: 1000,
    bulkPerMinute: 1000,
    trackPerDay: 1000,
    trackNewPerDay: 0,
    scrapeQueueMax: 300,
    bulkMaxItems: 100,
    requestDelayMs: [0, 0],
    ...overrides,
  });
  const db = openDb(':memory:');
  const app = await buildApp({ db, scrape });
  try {
    await fn(app, db);
  } finally {
    await app.close();
    await drain();
    Object.assign(config, saved);
  }
}

test('bulk: lote mixto A/MP, duplicados, existentes e inválidos, results en orden', async () => {
  await withApp(async (app, db) => {
    insert(db, 'A100000002');
    const items = [
      { url: A(1), name: 'Uno', price: 9.5 },
      { url: MP(1), name: 'Moda' },
      { url: A(2) }, // ya existía
      { url: A(1), name: 'dup' }, // duplicado del primero
      { url: 'https://evil.example/A100000009-x/' }, // url ajena
      { url: A(3), admin: true }, // campo extra
      { url: A(4), price: '10' }, // tipo mal
      'texto', // item que no es objeto
    ];
    const r = await bulk(app, { items });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.deepEqual(
      b.results.map((x) => x.status),
      ['added', 'added', 'existing', 'added', 'invalid', 'invalid', 'invalid', 'invalid'],
    );
    assert.equal(b.results[0].id, 'A100000001');
    assert.equal(b.results[1].id, 'MP_0538405_NF0A8FX1');
    assert.equal(b.results[3].id, 'A100000001');
    assert.match(b.results[4].error, /El Corte Inglés/);
    assert.match(b.results[5].error, /no permitido/);
    assert.match(b.results[6].error, /Tipo/);
    assert.equal(b.added, 3);
    assert.equal(b.existing, 1);
    assert.equal(b.invalid, 4);
    assert.equal(b.queued, 2); // sólo los 2 nuevos distintos
    assert.equal(db.prepare('SELECT COUNT(*) c FROM products').get().c, 3);
    // el precio del cliente es el primer punto de la gráfica
    assert.equal(db.prepare("SELECT price FROM prices WHERE product_id='A100000001'").get().price, 9.5);
    // /api/tracked los devuelve ya
    const t = await app.inject({ url: '/api/tracked?ids=A100000001,MP_0538405_NF0A8FX1,A100000099' });
    assert.deepEqual(t.json().tracked.sort(), ['A100000001', 'MP_0538405_NF0A8FX1']);
  }, {}, async () => {
    throw new Error('stub: sin red');
  });
});

test('bulk: las consultas encoladas acaban dando precio (scrape stub)', async () => {
  await withApp(
    async (app, db) => {
      await bulk(app, { items: [{ url: A(1) }, { url: A(2) }] });
      await drain();
      assert.equal(db.prepare('SELECT COUNT(*) c FROM prices').get().c, 2);
    },
    {},
    async () => ({ price: 42 }),
  );
});

test('bulk: 400 por cuerpo no válido, campos extra, lista vacía o demasiado grande; 413', async () => {
  await withApp(
    async (app) => {
      const bads = [{}, { items: [] }, { items: 'x' }, { items: [{ url: A(1) }], extra: 1 }, [], { items: [1, 2, 3, 4] }];
      for (const bad of bads) assert.equal((await bulk(app, bad)).statusCode, 400, JSON.stringify(bad));
      const item = { url: A(2), name: 'n'.repeat(900) };
      const big = await bulk(app, { items: Array(300).fill(item) });
      assert.equal(big.statusCode, 413);
    },
    { bulkMaxItems: 3 },
  );
});

test('bulk: límite por minuto por IP (CF-Connecting-IP no comparte contador)', async () => {
  await withApp(
    async (app) => {
      const go = (ip) => bulk(app, { items: [{ url: A(1) }] }, { 'cf-connecting-ip': ip });
      assert.equal((await go('1.1.1.1')).statusCode, 200);
      assert.equal((await go('1.1.1.1')).statusCode, 200);
      assert.equal((await go('1.1.1.1')).statusCode, 429);
      assert.equal((await go('2.2.2.2')).statusCode, 200);
    },
    { bulkPerMinute: 2, trustProxy: true },
  );
});

test('bulk: cada item cuenta para el tope diario', async () => {
  await withApp(
    async (app, db) => {
      let r = await bulk(app, { items: [1, 2, 3, 4, 5].map((n) => ({ url: A(n) })) });
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.json().results.map((x) => x.status), ['added', 'added', 'added', 'invalid', 'invalid']);
      assert.match(r.json().results[3].error, /Límite diario/);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM products').get().c, 3);
      // ya no cabe ninguno => 429, también por la ruta individual
      r = await bulk(app, { items: [{ url: A(6) }] });
      assert.equal(r.statusCode, 429);
      const single = await app.inject({ method: 'POST', url: '/api/products', payload: { url: A(1) } });
      assert.equal(single.statusCode, 429);
    },
    { trackPerDay: 3 },
  );
});

test('bulk: tope de productos nuevos; los existentes no lo consumen', async () => {
  await withApp(
    async (app, db) => {
      insert(db, 'A100000001');
      const r = await bulk(app, { items: [1, 2, 3, 4].map((n) => ({ url: A(n) })) });
      assert.deepEqual(r.json().results.map((x) => x.status), ['existing', 'added', 'added', 'invalid']);
      // un lote sólo de nuevos que no caben => 429
      assert.equal((await bulk(app, { items: [{ url: A(9) }] })).statusCode, 429);
      // pero uno de existentes sí pasa
      assert.equal((await bulk(app, { items: [{ url: A(1) }] })).statusCode, 200);
    },
    { trackNewPerDay: 2 },
  );
});

test('bulk: cola de ECI llena => 429 y no se inserta nada (todo o nada)', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  await withApp(
    async (app, db) => {
      assert.equal((await bulk(app, { items: [{ url: A(1) }, { url: A(2) }] })).statusCode, 200);
      assert.equal(pendingCheckCount(), 2);
      const r = await bulk(app, { items: [{ url: A(3) }] });
      assert.equal(r.statusCode, 429);
      assert.match(r.json().error, /cola de comprobación está llena/);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM products').get().c, 2);
      // un lote de existentes no encola nada y sigue pasando
      assert.equal((await bulk(app, { items: [{ url: A(1) }] })).statusCode, 200);
      release();
    },
    { scrapeQueueMax: 2 },
    async () => {
      await gate;
      return { price: 5 };
    },
  );
});

test('sweepUnpriced encola los productos sin ningún precio (reinicio con cola a medias)', async () => {
  await withApp(async (app, db) => {
    insert(db, 'A100000001', A(1));
    insert(db, 'A100000002', A(2));
    db.prepare("INSERT INTO prices VALUES ('A100000002','2026-01-01',5,'x')").run();
    assert.equal(sweepUnpriced(db, { scrape: async () => ({ price: 7 }) }), 1);
    await drain();
    assert.equal(db.prepare("SELECT COUNT(*) c FROM prices WHERE product_id='A100000001'").get().c, 1);
  });
});

test('bulk: mantiene las cabeceras de seguridad', async () => {
  await withApp(async (app) => {
    const r = await bulk(app, { items: [{ url: A(1) }] });
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.headers['content-security-policy']);
  });
});
