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

export function addSubscription(db, productId, email, token) {
  const existing = db
    .prepare('SELECT token FROM subscriptions WHERE product_id = ? AND email = ?')
    .get(productId, email);
  if (existing) return { created: false, token: existing.token };
  db.prepare('INSERT INTO subscriptions (product_id, email, token, created_at) VALUES (?, ?, ?, ?)').run(
    productId,
    email,
    token,
    new Date().toISOString(),
  );
  return { created: true, token };
}

export function removeSubscription(db, token) {
  const r = db.prepare('DELETE FROM subscriptions WHERE token = ?').run(token);
  return r.changes > 0;
}

export function countSubscribers(db, productId) {
  return db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE product_id = ?').get(productId).n;
}
