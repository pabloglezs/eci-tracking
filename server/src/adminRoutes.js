import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

function tokenOk(given) {
  if (!config.adminToken || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rutas de administración de métricas (protegidas por ADMIN_TOKEN). */
export function registerAdminRoutes(app, db) {
  app.get('/api/admin/stats', async (req, reply) => {
    if (!tokenOk(req.headers['x-admin-token'])) return reply.code(403).send({ error: 'forbidden' });
    const one = (sql) => db.prepare(sql).get();
    return {
      products: {
        total: one('SELECT COUNT(*) n FROM products').n,
        active: one(`SELECT COUNT(*) n FROM products WHERE status = 'active'`).n,
        gone: one(`SELECT COUNT(*) n FROM products WHERE status = 'gone'`).n,
        outOfStock: one('SELECT COUNT(*) n FROM products WHERE in_stock = 0').n,
        failing: one(`SELECT COUNT(*) n FROM products WHERE fail_count > 0 AND status = 'active'`).n,
      },
      emailQueue: Object.fromEntries(
        db.prepare('SELECT status, COUNT(*) n FROM email_queue GROUP BY status').all().map((r) => [r.status, r.n]),
      ),
      runs: db
        .prepare('SELECT id, started_at AS startedAt, finished_at AS finishedAt, ok, failed, skipped FROM check_runs ORDER BY id DESC LIMIT 30')
        .all(),
      failingProducts: db
        .prepare(
          `SELECT id, fail_count AS failCount, last_error AS lastError, last_checked_at AS lastCheckedAt
           FROM products WHERE fail_count > 0 AND status = 'active' ORDER BY fail_count DESC LIMIT 20`,
        )
        .all(),
    };
  });
}
