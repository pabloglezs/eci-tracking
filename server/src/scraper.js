// Descarga una página de producto de ECI y extrae nombre, imagen y precio.
// ECI rechaza (403) las peticiones sin cabeceras de navegador, por eso las enviamos.

import { config } from './config.js';

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'es-ES,es;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
};

export class ScrapeError extends Error {
  constructor(message, { gone = false, retryable = false } = {}) {
    super(message);
    this.gone = gone;
    this.retryable = retryable;
  }
}

const ENTITIES = { '&quot;': '"', '&amp;': '&', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };
const decode = (s) => (typeof s === 'string' ? s.replace(/&(quot|amp|#39|apos|lt|gt);/g, (m) => ENTITIES[m]) : s);

function parsePrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function* walk(node) {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (node && typeof node === 'object') {
    yield node;
    if (node['@graph']) yield* walk(node['@graph']);
  }
}

const isProduct = (n) => [].concat(n['@type'] ?? []).includes('Product');

function offerPrice(offers) {
  for (const o of [].concat(offers ?? [])) {
    const p = parsePrice(o?.price) ?? parsePrice(o?.lowPrice);
    if (p) return p;
    const nested = o?.offers ? offerPrice(o.offers) : null;
    if (nested) return nested;
  }
  return null;
}

/** true/false según schema.org availability; null si no consta. */
export function parseAvailability(offers) {
  const v = [].concat(offers ?? [])
    .map((o) => String(o?.availability ?? '').replace(/^.*\//, '').toLowerCase())
    .filter(Boolean);
  if (v.some((x) => ['instock', 'limitedavailability', 'onlineonly', 'instoreonly', 'preorder', 'presale', 'backorder'].includes(x))) return true;
  if (v.some((x) => ['outofstock', 'soldout', 'discontinued'].includes(x))) return false;
  return null;
}

/** Precio tachado de ECI: offers.priceSpecification con priceType StrikethroughPrice/ListPrice. */
function strikethroughPrice(offers) {
  for (const o of [].concat(offers ?? [])) {
    for (const spec of [].concat(o?.priceSpecification ?? [])) {
      if (/(StrikethroughPrice|ListPrice)$/i.test(String(spec?.priceType ?? ''))) {
        const p = parsePrice(spec.price);
        if (p) return p;
      }
    }
  }
  return null;
}

const isBreadcrumb =(n) => [].concat(n['@type'] ?? []).includes('BreadcrumbList');

/** Nombres del breadcrumb en orden, sin el "Inicio" inicial. */
function breadcrumbNames(node) {
  return [].concat(node.itemListElement ?? [])
    .map((i) => ({ pos: Number(i?.position) || 0, name: decode(i?.item?.name ?? i?.name) }))
    .filter((i) => typeof i.name === 'string' && i.name.trim() && !/^(inicio|home)$/i.test(i.name.trim()))
    .sort((a, b) => a.pos - b.pos)
    .map((i) => i.name.trim());
}

/** Extrae {name, image, price, categories} del HTML de una página de producto. */
export function parseProductHtml(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let product = null;
  let categories = [];
  for (const b of blocks) {
    let json;
    try {
      json = JSON.parse(b[1]);
    } catch {
      continue;
    }
    for (const node of walk(json)) {
      if (!product && isProduct(node)) {
        const price = offerPrice(node.offers);
        if (!price) continue;
        const img = [].concat(node.image ?? [])[0];
        product = {
          name: decode(node.name) || null,
          image: typeof img === 'string' ? img : (img?.url ?? null),
          price,
          inStock: parseAvailability(node.offers),
          originalPrice: ((o) => (o && o > price ? o : null))(strikethroughPrice(node.offers)),
        };
      } else if (!categories.length && isBreadcrumb(node)) {
        categories = breadcrumbNames(node);
      }
    }
  }
  if (product) return { ...product, categories };
  // Plan B: microdatos / meta tags.
  const meta = html.match(/<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["']/i);
  const price = parsePrice(meta?.[1]);
  if (price) {
    const og = (p) => html.match(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1];
    return { name: decode(og('title')) || null, image: og('image') || null, price, inStock: null, originalPrice: null, categories };
  }
  throw new ScrapeError('No se encontró el precio en la página');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry-After (segundos o fecha) -> ms acotados a 60 s, o null. */
export function parseRetryAfter(v, now = Date.now()) {
  if (!v) return null;
  const n = Number(v);
  const ms = Number.isFinite(n) ? n * 1000 : Date.parse(v) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : null;
}

/**
 * Descarga y parsea una ficha. Reintenta con backoff exponencial (con jitter) los
 * 429/5xx, timeouts y errores de red, respetando Retry-After. No reintenta 403/404/410
 * ni errores de parseo. `fetchImpl` y `wait` son inyectables para los tests.
 */
export async function fetchProduct(
  url,
  { retries = config.scrapeRetries, baseDelayMs = config.scrapeBackoffMs, fetchImpl = fetch, wait = sleep } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfter = null;
    try {
      const res = await fetchImpl(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (res.status === 404 || res.status === 410) throw new ScrapeError(`HTTP ${res.status}`, { gone: true });
      if (!res.ok) {
        retryAfter = parseRetryAfter(res.headers?.get?.('retry-after'));
        throw new ScrapeError(`HTTP ${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
      }
      return parseProductHtml(await res.text());
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof ScrapeError ? e.retryable : true; // red / timeout
      if (!retryable || attempt === retries) break;
      await wait(Math.max(baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5), retryAfter ?? 0));
    }
  }
  if (lastErr instanceof ScrapeError) throw lastErr;
  throw new ScrapeError(`Error de red: ${lastErr?.cause?.code ?? lastErr?.name ?? lastErr?.message}`);
}
