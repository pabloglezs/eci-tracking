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
  PRODUCT_ID_RE,
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
  confirmSubscription,
  removeAllSubscriptions,
  countSubscribers,
} from './store.js';
import { today } from './db.js';
import { checkSoon, runDailyCheck } from './checker.js';
import { enqueueWelcome, enqueueConfirmation } from './mailer.js';
import { registerAdminRoutes } from './adminRoutes.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');
const CHART_DIR = join(here, '..', 'node_modules', 'chart.js', 'dist');

/**
 * IP del cliente para el rate limit. Detrás de Cloudflare, la IP real llega en
 * CF-Connecting-IP (que el cliente no puede falsear si la app sólo es accesible
 * por el túnel). Sin proxy de confianza se usa la IP de la conexión.
 */
export function clientIp(req, trustProxy = config.trustProxy) {
  const cf = req.headers['cf-connecting-ip'];
  return (trustProxy && typeof cf === 'string' && cf.trim()) || req.ip;
}

// Cabeceras de seguridad. La web sólo carga recursos propios e imágenes de ECI.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // hay atributos style= en el HTML
  "img-src 'self' data: https://*.elcorteingles.es",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'strict-transport-security': 'max-age=15552000',
};

// POST /api/products: campos aceptados y su tipo.
const TRACK_FIELDS = { url: 'string', name: 'string', image: 'string', price: 'number' };
const TRACK_MAX_LEN = { url: 600, name: 1000, image: 1000 };

/** Devuelve un mensaje de error si el cuerpo no es válido, o null. */
export function validateTrackBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Cuerpo no válido';
  for (const [k, v] of Object.entries(body)) {
    if (!(k in TRACK_FIELDS)) return `Campo no permitido: ${k.slice(0, 40)}`;
    if (v === null || v === undefined) continue;
    if (typeof v !== TRACK_FIELDS[k]) return `Tipo no válido en ${k}`;
    if (typeof v === 'string' && v.length > TRACK_MAX_LEN[k]) return `${k} demasiado largo`;
  }
  if (typeof body.url !== 'string' || !body.url.trim()) return 'Falta la url';
  return null;
}

/** Contador diario en memoria por IP (se reinicia al cambiar de día o al reiniciar). */
function dailyCounter(tz) {
  let day = '';
  const m = new Map();
  return {
    get: (key) => {
      const d = today(tz);
      if (d !== day) {
        day = d;
        m.clear();
      }
      return m.get(key) ?? 0;
    },
    inc: (key) => m.set(key, (m.get(key) ?? 0) + 1),
  };
}

const limit = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

export async function buildApp({ db, logger = false, serveStatic = true }) {
  const app = Fastify({ logger, trustProxy: config.trustProxy });

  // CORS abierto: la extensión de Chrome llama a la API desde otro origen.
  await app.register(cors, { origin: true });
  // Formularios HTML sin JS (confirmar/baja): application/x-www-form-urlencoded -> objeto.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute', keyGenerator: (req) => clientIp(req) });

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });
  const trackReqs = dailyCounter(config.timezone);
  const trackNew = dailyCounter(config.timezone);

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/products', async (req) => {
    const { q = '', deals, cat = '', sub = '', sort = 'drop', page, limit } = req.query;
    return listProducts(db, {
      q: String(q).slice(0, 100),
      dealsOnly: deals === '1' || deals === 'true',
      cat: String(cat).slice(0, 100),
      sub: String(sub).slice(0, 100),
      sort: String(sort),
      page: Number(page) || 1,
      limit: Number(limit) || 24,
      tz: config.timezone,
    });
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
        category: product.category,
        subcategory: product.subcategory,
        categoryPath: product.category_path,
        createdAt: product.created_at,
        lastCheckedAt: product.last_checked_at,
        lastError: product.last_error,
        status: product.status ?? 'active',
        inStock: product.in_stock == null ? null : product.in_stock === 1,
        originalPrice: product.original_price ?? null,
      },
      stats: computeStats(history),
      deal: dealInfo(history, today(config.timezone)),
      history,
      subscribers: countSubscribers(db, product.id),
    };
  });

  // Alta de producto (la usa la extensión de Chrome).
  app.post('/api/products', { ...limit(config.trackPerMinute), bodyLimit: 8192 }, async (req, reply) => {
    const ip = clientIp(req);
    if (trackReqs.get(ip) >= config.trackPerDay) {
      return reply.code(429).send({ error: 'Has superado el límite diario de peticiones' });
    }
    trackReqs.inc(ip);
    const invalid = validateTrackBody(req.body);
    if (invalid) return reply.code(400).send({ error: invalid });
    const body = req.body;
    const parsed = parseProductUrl(body.url);
    if (!parsed) return reply.code(400).send({ error: 'La URL no es un producto de El Corte Inglés' });

    if (!getProduct(db, parsed.id) && trackNew.get(ip) >= config.trackNewPerDay) {
      return reply.code(429).send({ error: 'Has superado el límite diario de productos nuevos' });
    }
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
    if (created) trackNew.inc(ip);
    // Un producto descatalogado que alguien vuelve a seguir: se re-sondea (máx. 1 vez al día).
    const recheckGone =
      !created && product.status === 'gone' && Date.parse(product.last_checked_at ?? 0) < Date.now() - 864e5;
    if (created || recheckGone) checkSoon(db, product);
    return reply.code(created ? 201 : 200).send({ created, product: { id: product.id, name: product.name } });
  });

  // Qué productos de una lista de ids ya están en el tracker (lo usa la extensión
  // para marcar con ✓ las tarjetas de los listados de ECI).
  app.get('/api/tracked', limit(120), async (req) => {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .filter((s) => PRODUCT_ID_RE.test(s))
      .slice(0, 100);
    if (!ids.length) return { tracked: [] };
    const rows = db.prepare(`SELECT id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    return { tracked: rows.map((r) => r.id) };
  });

  // Doble opt-in: la suscripción queda pendiente hasta confirmar por email. La
  // respuesta es idéntica exista ya la suscripción o no (no se filtra si un email
  // ya estaba apuntado).
  app.post('/api/products/:id/subscribe', limit(config.subscribePerMinute), async (req, reply) => {
    const product = getProduct(db, req.params.id);
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado' });
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!isValidEmail(email)) return reply.code(400).send({ error: 'Email no válido' });
    const rawTarget = req.body?.targetPrice;
    let targetPrice = null;
    if (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') {
      const n = Number(String(rawTarget).replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0 || n >= 1e6) return reply.code(400).send({ error: 'Precio objetivo no válido' });
      targetPrice = Math.round(n * 100) / 100;
    }
    const sub = addSubscription(db, product.id, email, randomBytes(24).toString('hex'), { targetPrice });
    if (sub.sendConfirmation) enqueueConfirmation(db, product, email, sub.confirmToken, targetPrice);
    return { ok: true, pending: true };
  });

  const page = (title, msg, code = 200) => (reply) => {
    reply.type('text/html; charset=utf-8').code(code);
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><body style="font-family:system-ui;max-width:480px;margin:15vh auto;padding:0 16px">
<h2>${title}</h2><p>${msg}</p><p><a href="/">Volver a ECI Tracker</a></p></body>`;
  };

  // Los enlaces de los emails (GET) sólo muestran una página con un botón: un
  // escáner de enlaces no debe poder confirmar ni dar de baja. El cambio de
  // estado ocurre en el POST (formulario sin JS, o baja en un clic RFC 8058).
  const confirmPage = (action, token, title, msg, button) => (reply) =>
    page(title, `${msg}</p><form method="post" action="${action}"><input type="hidden" name="token" value="${escHtml(token)}"><button type="submit" style="font-size:16px;padding:10px 18px">${button}</button></form><p>`)(reply);
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Token: del cuerpo (form o JSON) o, para el POST one-click, de la query.
  const tokenOf = (req) => String(req.body?.token ?? req.query?.token ?? '');

  app.get('/api/confirm', limit(30), async (req, reply) =>
    confirmPage('/api/confirm', String(req.query.token ?? '').slice(0, 200), 'Confirmar alerta', 'Pulsa el botón para activar tu alerta de precio.', 'Confirmar alerta')(reply));

  app.post('/api/confirm', limit(30), async (req, reply) => {
    const r = confirmSubscription(db, tokenOf(req), { ttlDays: config.confirmTtlDays });
    if (r.status === 'ok') {
      const product = getProduct(db, r.sub.product_id);
      const cur = getHistory(db, r.sub.product_id).at(-1)?.price ?? null;
      enqueueWelcome(db, product, r.sub.email, r.sub.token, cur, r.sub.target_price);
      return page('¡Alerta confirmada!', 'Te avisaremos por email cuando haya novedades de precio.')(reply);
    }
    if (r.status === 'already') return page('Alerta ya confirmada', 'Esta alerta ya estaba activa.')(reply);
    if (r.status === 'expired') return page('Enlace caducado', 'Vuelve a apuntarte desde la ficha del producto.', 410)(reply);
    return page('Enlace no válido', 'Puede que haya caducado o que ya lo hubieras usado.', 404)(reply);
  });

  app.get('/api/unsubscribe', limit(30), async (req, reply) =>
    confirmPage('/api/unsubscribe', String(req.query.token ?? '').slice(0, 200), 'Baja de alertas', 'Pulsa el botón para dejar de recibir avisos de este producto.', 'Darme de baja')(reply));

  app.post('/api/unsubscribe', limit(30), async (req, reply) => {
    const token = tokenOf(req);
    const removed = token.length >= 16 && removeSubscription(db, token);
    return removed
      ? page('Te has dado de baja', 'No recibirás más avisos de este producto.')(reply)
      : page('Enlace no válido', 'Puede que ya te hubieras dado de baja.', 404)(reply);
  });

  app.get('/api/unsubscribe-all', limit(30), async (req, reply) =>
    confirmPage('/api/unsubscribe-all', String(req.query.token ?? '').slice(0, 200), 'Baja de todas las alertas', 'Pulsa el botón para darte de baja de todas tus alertas de ECI Tracker.', 'Darme de baja de todo')(reply));

  app.post('/api/unsubscribe-all', limit(30), async (req, reply) => {
    const n = removeAllSubscriptions(db, tokenOf(req));
    return n === null
      ? page('Enlace no válido', 'El enlace no es correcto.', 404)(reply)
      : page('Te has dado de baja de todo', `No recibirás más avisos (${n} suscripción(es) eliminadas).`)(reply);
  });

  // Lanzar la comprobación diaria a mano (sólo si hay ADMIN_TOKEN).
  app.post('/api/admin/check', async (req, reply) => {
    if (!config.adminToken || req.headers['x-admin-token'] !== config.adminToken) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    runDailyCheck(db).catch((e) => console.error('[check]', e));
    return { started: true };
  });

  registerAdminRoutes(app, db);

  if (serveStatic) {
    await app.register(fstatic, { root: PUBLIC_DIR });
    await app.register(fstatic, { root: CHART_DIR, prefix: '/vendor/chartjs/', decorateReply: false });
    app.get('/p/:id', (req, reply) => reply.sendFile('product.html'));
  }

  return app;
}
