// Lógica pura (sin I/O) sobre productos y precios.

const HOSTS = new Set(['www.elcorteingles.es', 'elcorteingles.es']);

/**
 * Valida una URL de producto de El Corte Inglés y extrae su id.
 * /electronica/A202047813-8806097827146-pr-movil-... -> id "A202047813-8806097827146"
 * Cada variante (color, talla...) tiene su propio id.
 */
export function parseProductUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(u.protocol) || !HOSTS.has(u.hostname)) return null;
  const m = u.pathname.match(/\/(A\d{6,}(?:-\d{6,})?)(?=-|\/|$)/);
  if (!m) return null;
  return { id: m[1], url: `https://www.elcorteingles.es${u.pathname}` };
}

const round2 = (n) => Math.round(n * 100) / 100;

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/** rows: [{day, price}] ordenadas por día ascendente. */
export function computeStats(rows) {
  if (!rows.length) return null;
  let min = rows[0];
  let max = rows[0];
  let sum = 0;
  for (const r of rows) {
    if (r.price < min.price) min = r;
    if (r.price > max.price) max = r;
    sum += r.price;
  }
  const cur = rows[rows.length - 1];
  return {
    current: cur.price,
    currentDay: cur.day,
    min: { price: min.price, day: min.day },
    max: { price: max.price, day: max.day },
    avg: round2(sum / rows.length),
    count: rows.length,
    firstDay: rows[0].day,
  };
}

/**
 * Una "oferta" es un producto cuyo precio ha bajado en los últimos `windowDays`
 * días y aún no ha vuelto a subir. Devuelve el precio anterior y el % de bajada.
 */
export function dealInfo(rows, todayStr, windowDays = 7) {
  const none = { isDeal: false, previousPrice: null, dropPct: null, dropDay: null };
  if (rows.length < 2) return none;
  const cur = rows[rows.length - 1];
  let i = rows.length - 2;
  while (i >= 0 && rows[i].price === cur.price) i--;
  if (i < 0) return none; // el precio nunca ha cambiado
  const previousPrice = rows[i].price;
  if (previousPrice <= cur.price) return none; // el último cambio fue una subida
  const dropDay = rows[i + 1].day;
  return {
    isDeal: daysBetween(dropDay, todayStr) <= windowDays,
    previousPrice,
    dropPct: round2(((previousPrice - cur.price) / previousPrice) * 100),
    dropDay,
  };
}

const isValidEmail = (s) =>
  typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
export { isValidEmail };

/** Sólo aceptamos imágenes https de dominios de ECI. */
export function sanitizeImage(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol === 'https:' && /(^|\.)elcorteingles\.es$/.test(u.hostname)) return u.toString();
  } catch {
    /* ignore */
  }
  return null;
}

export const sanitizeName = (s) =>
  typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, 300) : null;

export const isValidPrice = (p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 1_000_000;
