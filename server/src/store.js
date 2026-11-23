import { randomBytes } from 'node:crypto';
import { today } from './db.js';
import { computeStats, dealInfo } from './products.js';

export function getProduct(db, id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

export function upsertProduct(db, { id, url, name, image }) {
  if (getProduct(db, id)) {
    // Si ya existía, sólo rellenamos metadatos que faltaran.
    db.prepare(
      `UPDATE products SET name = COALESCE(NULLIF(name, ''), ?), image = COALESCE(NULLIF(image, ''), ?) WHERE id = ?`,
    ).run(name ?? null, image ?? null, id);
    return { product: getProduct(db, id), created: false };
  }
  db.prepare('INSERT INTO products (id, url, name, image, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    url,
    name ?? null,
    image ?? null,
    new Date().toISOString(),
  );
  return { product: getProduct(db, id), created: true };
}

export function getHistory(db, productId) {
  return db.prepare('SELECT day, price FROM prices WHERE product_id = ? ORDER BY day ASC').all(productId);
}

export function hasPrices(db, productId) {
  return !!db.prepare('SELECT 1 AS x FROM prices WHERE product_id = ? LIMIT 1').get(productId);
}

/**
 * Guarda el precio del día (uno por producto y día; si se repite, se sobrescribe).
 * `dropped` es true si baja respecto al último día registrado anterior a hoy
 * y no se había avisado ya de un precio igual o menor hoy.
 */
export function recordPrice(db, productId, price, tz, now = new Date()) {
  const day = today(tz, now);
  const prev = db
    .prepare('SELECT day, price FROM prices WHERE product_id = ? AND day < ? ORDER BY day DESC LIMIT 1')
    .get(productId, day);
  const cur = db.prepare('SELECT price FROM prices WHERE product_id = ? AND day = ?').get(productId, day);
  db.prepare(
    `INSERT INTO prices (product_id, day, price, checked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (product_id, day) DO UPDATE SET price = excluded.price, checked_at = excluded.checked_at`,
  ).run(productId, day, price, now.toISOString());
  const dropped = !!prev && price < prev.price - 0.005 && !(cur && cur.price <= price);
  return { day, previous: prev?.price ?? null, price, dropped };
}

/** Listado con precio actual e info de oferta. */
export function listProducts(db, { q = '', dealsOnly = false, tz }) {
  const products = q
    ? db
        .prepare(`SELECT * FROM products WHERE name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' ORDER BY created_at DESC`)
        .all(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`)
    : db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();

  const byProduct = new Map();
  for (const r of db.prepare('SELECT product_id, day, price FROM prices ORDER BY product_id, day').iterate()) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push({ day: r.day, price: r.price });
  }

  const todayStr = today(tz);
  const out = [];
  for (const p of products) {
    const rows = byProduct.get(p.id) ?? [];
    const stats = computeStats(rows);
    const deal = dealInfo(rows, todayStr);
    if (dealsOnly && !deal.isDeal) continue;
    out.push({
      id: p.id,
      url: p.url,
      name: p.name,
      image: p.image,
      category: p.category,
      subcategory: p.subcategory,
      createdAt: p.created_at,
      lastCheckedAt: p.last_checked_at,
      price: stats?.current ?? null,
      minPrice: stats?.min.price ?? null,
      maxPrice: stats?.max.price ?? null,
      ...deal,
    });
  }
  out.sort((a, b) => (b.dropPct ?? 0) - (a.dropPct ?? 0) || 0);
  return dealsOnly ? out : out.sort((a, b) => Number(b.isDeal) - Number(a.isDeal));
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

const RESEND_CONFIRM_MS = 10 * 60 * 1000;
const DAY_MS = 864e5;

/**
 * Crea una suscripción PENDIENTE de confirmar (o confirmada si `confirmed`).
 * Si ya existía no se toca nada visible: `sendConfirmation` indica si hay que
 * (re)enviar el email de confirmación (como mucho cada 10 min por pendiente).
 */
export function addSubscription(db, productId, email, token, { targetPrice = null, confirmed = false, now = new Date() } = {}) {
  const ex = db
    .prepare('SELECT token, confirm_token, confirmed_at, created_at FROM subscriptions WHERE product_id = ? AND email = ?')
    .get(productId, email);
  if (ex) {
    if (ex.confirmed_at) return { created: false, token: ex.token, confirmed: true, sendConfirmation: false };
    const stale = now - Date.parse(ex.created_at) > RESEND_CONFIRM_MS;
    if (stale) {
      db.prepare('UPDATE subscriptions SET created_at = ?, target_price = ? WHERE product_id = ? AND email = ?').run(
        now.toISOString(), targetPrice, productId, email,
      );
    }
    return { created: false, token: ex.token, confirmToken: ex.confirm_token, confirmed: false, sendConfirmation: stale };
  }
  const confirmToken = randomBytes(24).toString('hex');
  const iso = now.toISOString();
  db.prepare(
    'INSERT INTO subscriptions (product_id, email, token, created_at, confirmed_at, confirm_token, target_price) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(productId, email, token, iso, confirmed ? iso : null, confirmToken, targetPrice);
  return { created: true, token, confirmToken, confirmed, sendConfirmation: !confirmed };
}

/** Confirma por token. status: ok | already | expired | invalid. */
export function confirmSubscription(db, confirmToken, { ttlDays = 7, now = new Date() } = {}) {
  if (typeof confirmToken !== 'string' || confirmToken.length < 16) return { status: 'invalid' };
  const s = db.prepare('SELECT * FROM subscriptions WHERE confirm_token = ?').get(confirmToken);
  if (!s) return { status: 'invalid' };
  if (s.confirmed_at) return { status: 'already', sub: s };
  if (now - Date.parse(s.created_at) > ttlDays * DAY_MS) {
    db.prepare('DELETE FROM subscriptions WHERE id = ?').run(s.id);
    return { status: 'expired' };
  }
  db.prepare('UPDATE subscriptions SET confirmed_at = ? WHERE id = ?').run(now.toISOString(), s.id);
  return { status: 'ok', sub: { ...s, confirmed_at: now.toISOString() } };
}

/** Borra las suscripciones pendientes que superan la caducidad. */
export function purgePendingSubscriptions(db, ttlDays = 7, now = new Date()) {
  const cut = new Date(now - ttlDays * DAY_MS).toISOString();
  return db.prepare('DELETE FROM subscriptions WHERE confirmed_at IS NULL AND created_at < ?').run(cut).changes;
}

export function removeSubscription(db, token) {
  const r = db.prepare('DELETE FROM subscriptions WHERE token = ?').run(token);
  return r.changes > 0;
}

/** Token (estable, uno por email) para darse de baja de todas las suscripciones. */
export function getUnsubAllToken(db, email) {
  const ex = db.prepare('SELECT token FROM email_tokens WHERE email = ?').get(email);
  if (ex) return ex.token;
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO email_tokens (email, token) VALUES (?, ?)').run(email, token);
  return token;
}

/** Da de baja todas las suscripciones del email dueño del token. null si el token no existe. */
export function removeAllSubscriptions(db, token) {
  const row = typeof token === 'string' && token.length >= 16 ? db.prepare('SELECT email FROM email_tokens WHERE token = ?').get(token) : null;
  if (!row) return null;
  return db.prepare('DELETE FROM subscriptions WHERE email = ?').run(row.email).changes;
}

/** Sólo cuenta las confirmadas. */
export function countSubscribers(db, productId) {
  return db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE product_id = ? AND confirmed_at IS NOT NULL').get(productId).n;
}
