import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import { config } from './config.js';
import {
  parseProductUrl,
  computeStats,
  dealInfo,
  isValidEmail,
  sanitizeImage,
  sanitizeName,
  isValidPrice,
} from './products.js';
import {
  getProduct,
  upsertProduct,
  getHistory,
  hasPrices,
  recordPrice,
  listProducts,
  addSubscription,
  removeSubscription,
  countSubscribers,
} from './store.js';
import { today } from './db.js';
import { checkSoon, runDailyCheck } from './checker.js';
import { enqueueWelcome } from './mailer.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');
const CHART_DIR = join(here, '..', 'node_modules', 'chart.js', 'dist');

const limit = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

export async function buildApp({ db, logger = false, serveStatic = true }) {
  const app = Fastify({ logger, trustProxy: config.trustProxy });

  // CORS abierto: la extensión de Chrome llama a la API desde otro origen.
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/products', async (req) => {
    const { q = '', deals } = req.query;
    return {
      products: listProducts(db, {
        q: String(q).slice(0, 100),
        dealsOnly: deals === '1' || deals === 'true',
        tz: config.timezone,
      }),
    };
  });

  app.get('/api/products/:id', async (req, reply) => {
    const product = getProduct(db, req.params.id);
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado' });
    const history = getHistory(db, product.id);
    return {
      product: {
        id: product.id,
        url: product.url,
        name: product.name,
        image: product.image,
        createdAt: product.created_at,
        lastCheckedAt: product.last_checked_at,
        lastError: product.last_error,
      },
      stats: computeStats(history),
      deal: dealInfo(history, today(config.timezone)),
      history,
      subscribers: countSubscribers(db, product.id),
    };
  });

  // Alta de producto (la usa la extensión de Chrome).
  app.post('/api/products', limit(30), async (req, reply) => {
    const body = req.body ?? {};
    const parsed = parseProductUrl(body.url);
    if (!parsed) return reply.code(400).send({ error: 'La URL no es un producto de El Corte Inglés' });

    const { product, created } = upsertProduct(db, {
      ...parsed,
      name: sanitizeName(body.name),
      image: sanitizeImage(body.image),
    });
    // Primer punto de la gráfica con el precio que vio el usuario; el scraper lo
    // confirma enseguida. Después de eso, sólo se fían los precios del scraper.
    if (isValidPrice(body.price) && !hasPrices(db, product.id)) {
      recordPrice(db, product.id, body.price, config.timezone);
    }
    if (created) checkSoon(db, product);
    return reply.code(created ? 201 : 200).send({ created, product: { id: product.id, name: product.name } });
  });

  app.post('/api/products/:id/subscribe', limit(10), async (req, reply) => {
    const product = getProduct(db, req.params.id);
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado' });
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!isValidEmail(email)) return reply.code(400).send({ error: 'Email no válido' });
    const sub = addSubscription(db, product.id, email, randomBytes(24).toString('hex'));
    if (sub.created) {
      const cur = getHistory(db, product.id).at(-1)?.price ?? null;
      enqueueWelcome(db, product, email, sub.token, cur);
    }
    return { ok: true, created: sub.created };
  });

  app.get('/api/unsubscribe', async (req, reply) => {
    const token = String(req.query.token ?? '');
    const removed = token.length >= 16 && removeSubscription(db, token);
    reply.type('text/html; charset=utf-8').code(removed ? 200 : 404);
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Baja de alertas</title><body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 16px">
<h2>${removed ? 'Te has dado de baja' : 'Enlace no válido'}</h2>
<p>${removed ? 'No recibirás más avisos de este producto.' : 'Puede que ya te hubieras dado de baja.'}</p>
<p><a href="/">Volver a ECI Tracker</a></p></body>`;
  });

  // Lanzar la comprobación diaria a mano (sólo si hay ADMIN_TOKEN).
  app.post('/api/admin/check', async (req, reply) => {
    if (!config.adminToken || req.headers['x-admin-token'] !== config.adminToken) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    runDailyCheck(db).catch((e) => console.error('[check]', e));
    return { started: true };
  });

  if (serveStatic) {
    await app.register(fstatic, { root: PUBLIC_DIR });
    await app.register(fstatic, { root: CHART_DIR, prefix: '/vendor/chartjs/', decorateReply: false });
    app.get('/p/:id', (req, reply) => reply.sendFile('product.html'));
  }

  return app;
}
