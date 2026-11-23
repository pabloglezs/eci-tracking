import { config } from './config.js';
import { today } from './db.js';
import { fetchProduct } from './scraper.js';
import { recordPrice } from './store.js';
import { enqueueDropAlerts } from './mailer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Consulta ECI, guarda el precio de hoy y, si ha bajado, encola los avisos. */
export async function checkProduct(db, product, { scrape = fetchProduct, tz = config.timezone } = {}) {
  try {
    const data = await scrape(product.url);
    const cats = data.categories ?? [];
    db.prepare(
      `UPDATE products SET last_checked_at = ?, last_error = NULL, fail_count = 0,
         name = COALESCE(NULLIF(name, ''), ?), image = COALESCE(NULLIF(image, ''), ?),
         category = COALESCE(?, category), subcategory = COALESCE(?, subcategory),
         category_path = COALESCE(?, category_path) WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      data.name ?? null,
      data.image ?? null,
      cats[0] ?? null,
      cats[1] ?? null,
      cats.length ? cats.join(' › ') : null,
      product.id,
    );
    const r = recordPrice(db, product.id, data.price, tz);
    if (r.dropped) {
      const fresh = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id);
      enqueueDropAlerts(db, fresh, r.previous, r.price);
    }
    return { ok: true, ...r };
  } catch (e) {
    db.prepare('UPDATE products SET last_checked_at = ?, last_error = ?, fail_count = fail_count + 1 WHERE id = ?').run(
      new Date().toISOString(),
      String(e.message).slice(0, 300),
      product.id,
    );
    return { ok: false, error: e.message };
  }
}

let running = false;

/** Comprueba todos los productos que aún no tienen precio de hoy. */
export async function runDailyCheck(db, { scrape, tz = config.timezone, delay = config.requestDelayMs } = {}) {
  if (running) return { skipped: true };
  running = true;
  const stats = { checked: 0, failed: 0 };
  try {
    const pending = db
      .prepare('SELECT * FROM products p WHERE NOT EXISTS (SELECT 1 FROM prices WHERE product_id = p.id AND day = ?)')
      .all(today(tz));
    console.log(`[check] ${pending.length} producto(s) por comprobar`);
    for (const [i, p] of pending.entries()) {
      const r = await checkProduct(db, p, { scrape, tz });
      r.ok ? stats.checked++ : stats.failed++;
      if (!r.ok) console.warn(`[check] ${p.id}: ${r.error}`);
      if (i < pending.length - 1 && delay[1] > 0) await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
    }
    console.log(`[check] terminado: ${stats.checked} ok, ${stats.failed} con error`);
    return stats;
  } finally {
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
