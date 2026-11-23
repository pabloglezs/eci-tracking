// Descarga una página de producto de ECI y extrae nombre, imagen y precio.
// ECI rechaza (403) las peticiones sin cabeceras de navegador, por eso las enviamos.

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
  constructor(message, { gone = false } = {}) {
    super(message);
    this.gone = gone;
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

/** Extrae {name, image, price} del HTML de una página de producto. */
export function parseProductHtml(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let json;
    try {
      json = JSON.parse(b[1]);
    } catch {
      continue;
    }
    for (const node of walk(json)) {
      if (!isProduct(node)) continue;
      const price = offerPrice(node.offers);
      if (!price) continue;
      const img = [].concat(node.image ?? [])[0];
      return {
        name: decode(node.name) || null,
        image: typeof img === 'string' ? img : (img?.url ?? null),
        price,
      };
    }
  }
  // Plan B: microdatos / meta tags.
  const meta = html.match(/<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["']/i);
  const price = parsePrice(meta?.[1]);
  if (price) {
    const og = (p) => html.match(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1];
    return { name: decode(og('title')) || null, image: og('image') || null, price };
  }
  throw new ScrapeError('No se encontró el precio en la página');
}

export async function fetchProduct(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (res.status === 404 || res.status === 410) throw new ScrapeError(`HTTP ${res.status}`, { gone: true });
  if (!res.ok) throw new ScrapeError(`HTTP ${res.status}`);
  return parseProductHtml(await res.text());
}
