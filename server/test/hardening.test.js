import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { backupDb, listBackups, pruneBackups } from '../src/backup.js';

const URL1 = 'https://www.elcorteingles.es/electronica/A111111111-2222222222-pr-x/';
const post = (app, payload, headers = {}) =>
  app.inject({ method: 'POST', url: '/api/products', payload, headers });

async function withApp(fn, overrides = {}) {
  const saved = { ...config };
  Object.assign(config, { trackPerDay: 1000, trackNewPerDay: 1000, trackPerMinute: 1000, ...overrides });
  const db = openDb(':memory:');
  const app = await buildApp({ db });
  try {
    await fn(app, db);
  } finally {
    await app.close();
    Object.assign(config, saved);
  }
}

test('POST /api/products: payload de la extensión sigue funcionando (name/image/price opcionales)', async () => {
  await withApp(async (app, db) => {
    db.prepare("INSERT INTO products (id,url,created_at) VALUES ('A111111111-2222222222','u','x')").run();
    const r = await post(app, { url: URL1, name: 'X', image: undefined, price: null });
    assert.equal(r.statusCode, 200);
    const r2 = await post(app, { url: URL1 });
    assert.equal(r2.statusCode, 200);
  });
});

test('POST /api/products: rechaza campos inesperados, tipos y longitudes', async () => {
  await withApp(async (app) => {
    for (const bad of [
      { url: URL1, admin: true },
      { url: 123 },
      { url: URL1, price: '10' },
      { url: URL1, name: { a: 1 } },
      { url: 'https://www.elcorteingles.es/' + 'a'.repeat(700) },
      { url: URL1, name: 'n'.repeat(1001) },
      {},
      [],
    ]) {
      const r = await post(app, bad);
      assert.equal(r.statusCode, 400, JSON.stringify(bad).slice(0, 60));
    }
    const big = await post(app, { url: URL1, name: 'n'.repeat(20000) });
    assert.equal(big.statusCode, 413);
  });
});

test('POST /api/products: tope diario de peticiones y de productos nuevos por IP', async () => {
  await withApp(
    async (app, db) => {
      const mk = (i) => `https://www.elcorteingles.es/x/A${String(100000 + i)}-pr-x/`;
      for (const i of [1, 2, 3]) {
        db.prepare('INSERT INTO products (id,url,created_at) VALUES (?,?,?)').run(`A${100000 + i}`, mk(i), 'x');
      }
      // existentes: no consumen el tope de nuevos
      for (const i of [1, 2, 3]) assert.equal((await post(app, { url: mk(i) })).statusCode, 200);
      // 4.ª petición del día => 429 por límite diario (trackPerDay = 3)
      assert.equal((await post(app, { url: mk(1) })).statusCode, 429);
    },
    { trackPerDay: 3, trackNewPerDay: 1 },
  );
});

const NEW_URL = (i) => `https://www.elcorteingles.es/electronica/A${300000 + i}-pr-x/`;

test('tope de productos nuevos: bloquea con 429 antes de crear', async () => {
  await withApp(
    async (app, db) => {
      assert.equal((await post(app, { url: NEW_URL(1) })).statusCode, 201); // 1.º nuevo: cabe
      const r = await post(app, { url: NEW_URL(2) }); // 2.º nuevo: supera el tope (1)
      assert.equal(r.statusCode, 429);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM products').get().c, 1);
    },
    { trackNewPerDay: 1, trackPerDay: 10 },
  );
});

test('trackNewPerDay = 0 significa sin límite de productos nuevos', async () => {
  await withApp(
    async (app, db) => {
      for (const i of [1, 2, 3, 4, 5]) assert.equal((await post(app, { url: NEW_URL(i) })).statusCode, 201);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM products').get().c, 5);
    },
    { trackNewPerDay: 0, trackPerDay: 100 },
  );
});

test('cabeceras de seguridad en web y API', async () => {
  await withApp(async (app) => {
    for (const url of ['/', '/api/health', '/p/A111111111-2222222222']) {
      const r = await app.inject({ url });
      assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
      assert.match(r.headers['content-security-policy'], /default-src 'self'/);
      assert.match(r.headers['content-security-policy'], /img-src[^;]*elcorteingles\.es/);
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.ok(r.headers['referrer-policy']);
    }
  });
});

test('backup: VACUUM INTO produce una BD válida, y la retención borra las antiguas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eci-bk-'));
  try {
    const dbFile = join(dir, 'live.db');
    const db = openDb(dbFile);
    db.prepare("INSERT INTO products (id,url,created_at) VALUES ('A111111','u','x')").run();
    for (let i = 0; i < 5; i++) {
      backupDb(db, { dir: join(dir, 'bk'), keep: 3, now: new Date(2026, 0, 1 + i, 3, 30) });
    }
    const files = listBackups(join(dir, 'bk'));
    assert.equal(files.length, 3);
    assert.match(files.at(-1), /^eci-20260105-033000\.db$/);
    assert.equal(readdirSync(join(dir, 'bk')).filter((f) => f.endsWith('.tmp')).length, 0);
    // restauración: abrir la copia y leer
    const copy = new DatabaseSync(join(dir, 'bk', files.at(-1)));
    assert.equal(copy.prepare('SELECT COUNT(*) c FROM products').get().c, 1);
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    copy.close();
    assert.deepEqual(pruneBackups(join(dir, 'bk'), 3), []);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
