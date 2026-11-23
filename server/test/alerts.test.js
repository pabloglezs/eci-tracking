import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { upsertProduct, addSubscription, countSubscribers, purgePendingSubscriptions } from '../src/store.js';
import { checkProduct } from '../src/checker.js';
import { purgeEmailQueue } from '../src/mailer.js';

const P = { id: 'A111111111-2222222222', url: 'https://www.elcorteingles.es/electronica/A111111111-2222222222-pr-x/', name: 'Producto X' };
const sub = (app, payload) => app.inject({ method: 'POST', url: `/api/products/${P.id}/subscribe`, payload });
const post = (app, url, token) => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${token}` });
const mails = (db) => db.prepare('SELECT * FROM email_queue ORDER BY id').all();
const tokenOf = (text, name) => text.match(new RegExp(`/api/${name}\\?token=([0-9a-f]+)`))[1];

async function setup() {
  const db = openDb(':memory:');
  upsertProduct(db, P);
  const app = await buildApp({ db, serveStatic: false });
  return { db, app };
}

/** Simula la comprobación de "hoy" con ese precio (borra el precio de hoy para poder repetir). */
async function check(db, price) {
  const product = db.prepare('SELECT * FROM products').get();
  db.prepare('DELETE FROM prices WHERE day = ?').run(new Date().toISOString().slice(0, 10));
  return checkProduct(db, product, { scrape: async () => ({ price }), tz: 'UTC' });
}

test('doble opt-in: pendiente no recibe avisos; confirmar activa; baja global', async () => {
  const { db, app } = await setup();
  db.prepare("INSERT INTO prices (product_id, day, price, checked_at) VALUES (?, '2020-01-01', 100, 'x')").run(P.id);
  assert.equal((await sub(app, { email: 'a@x.com' })).statusCode, 200);
  assert.equal(countSubscribers(db, P.id), 0);
  const [conf] = mails(db);
  assert.match(conf.subject, /Confirma/);
  assert.equal(conf.unsub_url, null);

  await check(db, 80);
  assert.equal(mails(db).length, 1, 'pendiente: sin aviso de bajada');

  const ct = tokenOf(conf.text, 'confirm');
  assert.equal((await post(app, '/api/confirm', 'zzzz')).statusCode, 404);
  assert.equal((await post(app, '/api/confirm', ct)).statusCode, 200);
  assert.match((await post(app, '/api/confirm', ct)).body, /ya estaba/);
  assert.equal(countSubscribers(db, P.id), 1);
  const welcome = mails(db).at(-1);
  assert.match(welcome.subject, /activadas/);
  assert.match(welcome.text, /unsubscribe-all/);

  await check(db, 70);
  const alert = mails(db).at(-1);
  assert.match(alert.subject, /70,00/);

  const all = tokenOf(alert.text, 'unsubscribe-all');
  assert.equal(all.length, 48);
  assert.equal((await post(app, '/api/unsubscribe-all', 'nope')).statusCode, 404);
  assert.equal((await post(app, '/api/unsubscribe-all', all)).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 0);
  await app.close();
});

test('suscribirse dos veces responde igual y no reenvía confirmación al instante', async () => {
  const { db, app } = await setup();
  const a = await sub(app, { email: 'a@x.com' });
  const b = await sub(app, { email: 'a@x.com' });
  assert.deepEqual(a.json(), b.json());
  assert.equal(mails(db).length, 1);
  await app.close();
});

test('precio objetivo: avisa una vez al cruzar y se rearma al subir', async () => {
  const { db, app } = await setup();
  addSubscription(db, P.id, 'a@x.com', 'tok-a-0123456789abcdef', { confirmed: true, targetPrice: 75 });
  addSubscription(db, P.id, 'b@x.com', 'tok-b-0123456789abcdef', { confirmed: true }); // sin objetivo
  db.prepare("INSERT INTO prices (product_id, day, price, checked_at) VALUES (?, '2020-01-01', 100, 'x')").run(P.id);
  await check(db, 100);
  assert.equal(mails(db).length, 0);
  await check(db, 70); // cruza el objetivo (y baja)
  let m = mails(db);
  assert.deepEqual(m.map((x) => x.to_email).sort(), ['a@x.com', 'b@x.com']);
  assert.match(m.find((x) => x.to_email === 'a@x.com').subject, /objetivo/);
  await check(db, 60); // sigue por debajo: a no repite
  assert.equal(mails(db).filter((x) => x.to_email === 'a@x.com').length, 1);
  await check(db, 90); // sube por encima: rearma
  await check(db, 74); // vuelve a cruzar
  assert.equal(mails(db).filter((x) => x.to_email === 'a@x.com').length, 2);
  await app.close();
});

test('targetPrice inválido => 400; válido con coma se guarda', async () => {
  const { db, app } = await setup();
  assert.equal((await sub(app, { email: 'a@x.com', targetPrice: 'abc' })).statusCode, 400);
  assert.equal((await sub(app, { email: 'a@x.com', targetPrice: -3 })).statusCode, 400);
  assert.equal((await sub(app, { email: 'a@x.com', targetPrice: '49,90' })).statusCode, 200);
  assert.equal(db.prepare('SELECT target_price t FROM subscriptions').get().t, 49.9);
  await app.close();
});

test('las pendientes caducan y se purgan; las confirmadas no', async () => {
  const { db, app } = await setup();
  const old = new Date(Date.now() - 8 * 864e5);
  addSubscription(db, P.id, 'old@x.com', 'tok-o-0123456789abcdef', { now: old });
  addSubscription(db, P.id, 'conf@x.com', 'tok-c-0123456789abcdef', { confirmed: true, now: old });
  const ct = db.prepare("SELECT confirm_token t FROM subscriptions WHERE email='old@x.com'").get().t;
  assert.equal((await post(app, '/api/confirm', ct)).statusCode, 410);
  addSubscription(db, P.id, 'old2@x.com', 'tok-p-0123456789abcdef', { now: old });
  assert.equal(purgePendingSubscriptions(db, 7), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 1);
  await app.close();
});

test('migración: suscripciones existentes pasan a confirmadas', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'eci-mig-')), 'old.db');
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT, image TEXT, created_at TEXT NOT NULL, last_checked_at TEXT, last_error TEXT, fail_count INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, email TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, UNIQUE (product_id, email));
  INSERT INTO products VALUES ('A1','u',NULL,NULL,'t',NULL,NULL,0);
  INSERT INTO subscriptions (product_id,email,token,created_at) VALUES ('A1','a@x.com','tok','2025-01-01T00:00:00Z');`);
  raw.close();
  const db = openDb(path);
  const s = db.prepare('SELECT confirmed_at, alerted FROM subscriptions').get();
  assert.equal(s.confirmed_at, '2025-01-01T00:00:00Z');
  assert.equal(s.alerted, 0);
  db.close();
  openDb(path).close(); // idempotente
});

test('purga de email_queue: enviados >30d y fallidos >60d', () => {
  const db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO email_queue (to_email, subject, text, html, status, created_at, sent_at) VALUES (?,?,?,?,?,?,?)');
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  ins.run('a', 's', 't', 'h', 'sent', ago(40), ago(40));
  ins.run('b', 's', 't', 'h', 'sent', ago(5), ago(5));
  ins.run('c', 's', 't', 'h', 'failed', ago(70), null);
  ins.run('d', 's', 't', 'h', 'failed', ago(40), null);
  ins.run('e', 's', 't', 'h', 'pending', ago(90), null);
  assert.deepEqual(purgeEmailQueue(db), { sent: 1, failed: 1 });
  assert.deepEqual(db.prepare('SELECT to_email FROM email_queue ORDER BY id').all().map((r) => r.to_email), ['b', 'd', 'e']);
});

test('GET de confirmar/baja sólo muestra una página; el POST cambia el estado', async () => {
  const { db, app } = await setup();
  await sub(app, { email: 'a@x.com' });
  const ct = tokenOf(mails(db)[0].text, 'confirm');
  const g = await app.inject({ url: `/api/confirm?token=${ct}` });
  assert.equal(g.statusCode, 200);
  assert.match(g.body, /<form method="post" action="\/api\/confirm">/);
  assert.match(g.body, new RegExp(`name="token" value="${ct}"`));
  assert.equal(db.prepare('SELECT confirmed_at c FROM subscriptions').get().c, null); // GET no confirma
  assert.equal(countSubscribers(db, P.id), 0);
  assert.equal((await post(app, '/api/confirm', ct)).statusCode, 200);
  assert.equal(countSubscribers(db, P.id), 1);
  // JSON también vale
  const { token, } = db.prepare('SELECT token FROM subscriptions').get();
  const uall = db.prepare('SELECT token FROM email_tokens').get().token;

  // GET de bajas: no cambia nada
  assert.equal((await app.inject({ url: `/api/unsubscribe?token=${token}` })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/unsubscribe-all?token=${uall}` })).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 1);

  // One-click RFC 8058: POST a la URL de la cabecera, cuerpo List-Unsubscribe=One-Click
  const oc = await app.inject({
    method: 'POST', url: `/api/unsubscribe?token=${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click',
  });
  assert.equal(oc.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 0);
  assert.equal((await post(app, '/api/unsubscribe', token)).statusCode, 404);
  // baja global con JSON
  addSubscription(db, P.id, 'a@x.com', 'tok-z-0123456789abcdef', { confirmed: true });
  const j = await app.inject({ method: 'POST', url: '/api/unsubscribe-all', payload: { token: uall } });
  assert.equal(j.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 0);
  await app.close();
});
