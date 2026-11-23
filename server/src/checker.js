import { config } from './config.js';
import { today } from './db.js';
import { fetchProduct } from './scraper.js';
import { recordPrice } from './store.js';
import { enqueueDropAlerts } from './mailer.js';
import { maybeAlertAdmin } from './adminAlerts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Consulta ECI y guarda el precio de hoy; si ha bajado, encola los avisos.
 * - Sin stock (availability SoldOut/OutOfStock): no se registra precio.
 * - 404/410 en `goneAfter` días distintos seguidos: status='gone' (se conserva el histórico).
 * - Un 200 reactiva un producto 'gone'.
 */
export async function checkProduct(db, product, { scrape = fetchProduct, tz = config.timezone, goneAfter = config.goneAfter } = {}) {
  try {
    const data = await scrape(product.url);
    const cats = data.categories ?? [];
    const inStock = data.inStock === true ? 1 : data.inStock === false ? 0 : null;
    db.prepare(
      `UPDATE products SET last_checked_at = ?, last_error = NULL, fail_count = 0,
         status = 'active', gone_count = 0, gone_day = NULL, in_stock = ?, original_price = ?,
         name = COALESCE(NULLIF(name, ''), ?), image = COALESCE(NULLIF(image, ''), ?),
         category = COALESCE(?, category), subcategory = COALESCE(?, subcategory),
         category_path = COALESCE(?, category_path) WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      inStock,
      data.originalPrice ?? null,
      data.name ?? null,
      data.image ?? null,
      cats[0] ?? null,
      cats[1] ?? null,
      cats.length ? cats.join(' › ') : null,
      product.id,
    );
    if (inStock === 0) return { ok: true, outOfStock: true };
    const r = recordPrice(db, product.id, data.price, tz);
    if (r.dropped) {
      const fresh = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id);
      enqueueDropAlerts(db, fresh, r.previous, r.price);
    }
    return { ok: true, ...r };
  } catch (e) {
    const now = new Date();
    db.prepare('UPDATE products SET last_checked_at = ?, last_error = ?, fail_count = fail_count + 1 WHERE id = ?').run(
      now.toISOString(),
      String(e.message).slice(0, 300),
      product.id,
    );
    if (e.gone) {
      // Cuenta como máximo una vez por día, para que las comprobaciones extra no adelanten el 'gone'.
      const day = today(tz, now);
      const row = db.prepare('SELECT gone_count, gone_day FROM products WHERE id = ?').get(product.id);
      if (row && row.gone_day !== day) {
        const n = row.gone_count + 1;
        db.prepare(`UPDATE products SET gone_count = ?, gone_day = ?, status = CASE WHEN ? >= ? THEN 'gone' ELSE status END WHERE id = ?`)
          .run(n, day, n, goneAfter, product.id);
      }
    }
    return { ok: false, error: e.message, gone: !!e.gone };
  }
}

/** Productos a consultar en la pasada diaria + cuántos se omiten. */
export function pendingProducts(db, { tz = config.timezone, now = new Date(), goneRecheckDays = config.goneRecheckDays } = {}) {
  const day = today(tz, now);
  const all = db
    .prepare(
      `SELECT p.*, EXISTS (SELECT 1 FROM prices WHERE product_id = p.id AND day = ?) AS has_today FROM products p`,
    )
    .all(day);
  const recheckBefore = now.getTime() - goneRecheckDays * 864e5;
  const pending = all.filter((p) => {
    if (p.status === 'gone') {
      // Sondeo ocasional por si vuelve a estar disponible.
      return goneRecheckDays > 0 && (!p.last_checked_at || Date.parse(p.last_checked_at) <= recheckBefore);
    }
    if (p.has_today) return false;
    // Sin stock y ya comprobado hoy: no repetir (no genera precio, así que no cuenta como "hecho").
    if (p.in_stock === 0 && p.last_checked_at && today(tz, new Date(p.last_checked_at)) === day) return false;
    return true;
  });
  return { pending, skipped: all.length - pending.length, total: all.length };
}

let running = false;

/** Comprueba todos los productos que aún no tienen precio de hoy. */
export async function runDailyCheck(db, { scrape, tz = config.timezone, delay = config.requestDelayMs } = {}) {
  if (running) return { skipped: true };
  running = true;
  const stats = { checked: 0, failed: 0 };
  let runId;
  try {
    const { pending, skipped } = pendingProducts(db, { tz });
    runId = Number(
      db.prepare('INSERT INTO check_runs (started_at, skipped) VALUES (?, ?)').run(new Date().toISOString(), skipped).lastInsertRowid,
    );
    console.log(`[check] ${pending.length} producto(s) por comprobar (${skipped} omitidos)`);
    for (const [i, p] of pending.entries()) {
      const r = await checkProduct(db, p, { scrape, tz });
      r.ok ? stats.checked++ : stats.failed++;
      if (!r.ok) console.warn(`[check] ${p.id}: ${r.error}`);
      if (i < pending.length - 1 && delay[1] > 0) await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
    }
    console.log(`[check] terminado: ${stats.checked} ok, ${stats.failed} con error`);
    return { ...stats, runId };
  } finally {
    if (runId) {
      db.prepare('UPDATE check_runs SET finished_at = ?, ok = ?, failed = ? WHERE id = ?').run(
        new Date().toISOString(),
        stats.checked,
        stats.failed,
        runId,
      );
      try {
        maybeAlertAdmin(db, { ok: stats.checked, failed: stats.failed, runId }, { tz });
      } catch (e) {
        console.error('[admin-alert]', e);
      }
    }
    running = false;
  }
}

// Cola serie para las comprobaciones inmediatas de productos recién añadidos.
let chain = Promise.resolve();
export function checkSoon(db, product) {
  chain = chain
    .then(() => checkProduct(db, product))
    .then(() => sleep(config.requestDelayMs[0]))
    .catch((e) => console.error('[check]', e));
}
