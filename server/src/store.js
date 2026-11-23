import { randomBytes } from 'node:crypto';
import { today } from './db.js';

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

export const NO_CATEGORY = 'Sin categoría';
export const SORTS = {
  drop: 'is_deal DESC, drop_pct IS NULL, drop_pct DESC, created_at DESC',
  recent: 'created_at DESC',
  price_asc: 'price IS NULL, price ASC',
  price_desc: 'price IS NULL, price DESC',
  near_min: 'price IS NULL, (price - min_price) / min_price ASC, is_deal DESC',
};
export const SPARK_DAYS = 30;

// Todo el cálculo (precio actual, mín/máx, última bajada) en SQL: el coste es
// lineal en nº de productos y aprovecha la PK (product_id, day). Equivale a
// computeStats + dealInfo de products.js (hay un test que lo comprueba).
const LISTING_SQL = `
WITH agg AS (
  SELECT product_id, MAX(day) AS last_day, MIN(price) AS min_price, MAX(price) AS max_price
  FROM prices GROUP BY product_id
),
cur AS (
  SELECT a.product_id, a.min_price, a.max_price, pr.price,
    -- último día cuyo precio era distinto al actual (recorre hacia atrás y para al primero)
    (SELECT day FROM prices p WHERE p.product_id = a.product_id AND p.price <> pr.price
      ORDER BY day DESC LIMIT 1) AS pday
  FROM agg a JOIN prices pr ON pr.product_id = a.product_id AND pr.day = a.last_day
),
prev AS (
  SELECT cur.product_id,
    (SELECT price FROM prices WHERE product_id = cur.product_id AND day = cur.pday) AS prev_price,
    (SELECT MIN(day) FROM prices WHERE product_id = cur.product_id AND day > cur.pday) AS drop_day
  FROM cur WHERE pday IS NOT NULL
)
SELECT p.id, p.url, p.name, p.image, p.category, p.subcategory, p.created_at, p.last_checked_at,
  cur.price, cur.min_price, cur.max_price,
  CASE WHEN prev.prev_price > cur.price THEN prev.prev_price END AS prev_price,
  CASE WHEN prev.prev_price > cur.price THEN prev.drop_day END AS drop_day,
  CASE WHEN prev.prev_price > cur.price
    THEN ROUND((prev.prev_price - cur.price) * 100.0 / prev.prev_price, 2) END AS drop_pct,
  CASE WHEN prev.prev_price > cur.price AND julianday(:today) - julianday(prev.drop_day) <= 7
    THEN 1 ELSE 0 END AS is_deal
FROM products p
LEFT JOIN cur ON cur.product_id = p.id
LEFT JOIN prev ON prev.product_id = p.id`;

const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

/**
 * Listado paginado con precio actual, info de oferta y sparkline.
 * Devuelve { products, total, page, limit, pages, categories } donde
 * `categories` (contadores) respeta q y deals pero no cat/sub, para poder pintar
 * los chips sin cargar todo el catálogo en el cliente.
 */
export function listProducts(
  db,
  { q = '', dealsOnly = false, cat = '', sub = '', sort = 'drop', page = 1, limit = 24, tz },
) {
  limit = Math.min(100, Math.max(1, Math.trunc(limit) || 24));
  page = Math.max(1, Math.trunc(page) || 1);
  const todayStr = today(tz);
  // Se materializa una vez por petición y las consultas de abajo (contadores,
  // total y página) leen de la tabla temporal en vez de recalcular los agregados.
  db.exec('DROP TABLE IF EXISTS temp.listing');
  db.prepare(`CREATE TEMP TABLE listing AS ${LISTING_SQL}`).run({ today: todayStr });
  const where = [];
  const params = {};
  if (q) {
    where.push(`(name LIKE :like ESCAPE '\\' OR id LIKE :like ESCAPE '\\')`);
    params.like = `%${escapeLike(q)}%`;
  }
  if (dealsOnly) where.push('is_deal = 1');
  const w = (extra = []) => {
    const all = [...where, ...extra];
    return all.length ? 'WHERE ' + all.join(' AND ') : '';
  };

  const catRows = db
    .prepare(`SELECT category, subcategory, COUNT(*) AS n FROM listing ${w()} GROUP BY 1, 2`)
    .all(params);
  const byCat = new Map();
  for (const r of catRows) {
    const c = r.category || NO_CATEGORY;
    const s = r.subcategory || NO_CATEGORY;
    if (!byCat.has(c)) byCat.set(c, { name: c, count: 0, subs: new Map() });
    const e = byCat.get(c);
    e.count += r.n;
    e.subs.set(s, (e.subs.get(s) ?? 0) + r.n);
  }
  const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es');
  const categories = [...byCat.values()]
    .map((c) => ({
      name: c.name,
      count: c.count,
      subcategories: [...c.subs].map(([name, count]) => ({ name, count })).sort(byCount),
    }))
    .sort((a, b) => (a.name === NO_CATEGORY) - (b.name === NO_CATEGORY) || byCount(a, b));

  const extra = [];
  if (cat) {
    if (cat === NO_CATEGORY) extra.push(`(category IS NULL OR category = '')`);
    else (extra.push('category = :cat'), (params.cat = cat));
    if (sub) {
      if (sub === NO_CATEGORY) extra.push(`(subcategory IS NULL OR subcategory = '')`);
      else (extra.push('subcategory = :sub'), (params.sub = sub));
    }
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM listing ${w(extra)}`).get(params).n;
  const order = SORTS[sort] ?? SORTS.drop;
  const rows = db
    .prepare(`SELECT * FROM listing ${w(extra)} ORDER BY ${order}, id LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset: (page - 1) * limit });

  // Serie ligera (últimos 30 días) sólo de los productos de esta página.
  const spark = new Map();
  if (rows.length) {
    const since = addDays(todayStr, -(SPARK_DAYS - 1));
    const ph = rows.map(() => '?').join(',');
    for (const r of db
      .prepare(`SELECT product_id, price FROM prices WHERE product_id IN (${ph}) AND day >= ? ORDER BY product_id, day`)
      .all(...rows.map((r) => r.id), since)) {
      if (!spark.has(r.product_id)) spark.set(r.product_id, []);
      spark.get(r.product_id).push(r.price);
    }
  }

  const products = rows.map((p) => ({
    id: p.id,
    url: p.url,
    name: p.name,
    image: p.image,
    category: p.category,
    subcategory: p.subcategory,
    createdAt: p.created_at,
    lastCheckedAt: p.last_checked_at,
    price: p.price ?? null,
    minPrice: p.min_price ?? null,
    maxPrice: p.max_price ?? null,
    isDeal: !!p.is_deal,
    previousPrice: p.prev_price ?? null,
    dropPct: p.drop_pct ?? null,
    dropDay: p.drop_day ?? null,
    spark: spark.get(p.id) ?? [],
  }));
  return { products, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), categories };
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
