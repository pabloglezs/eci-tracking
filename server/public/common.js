export const $ = (s, el = document) => el.querySelector(s);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
export const eur = (n) => (n == null ? '—' : fmt.format(n));

export const fmtDay = (d) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

/** Sparkline SVG inline (sin librerías) a partir de una serie de precios. */
export function sparkline(series) {
  if (!series || series.length < 2) return '';
  const W = 100, H = 28, PAD = 3;
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => [
    (i / (series.length - 1)) * (W - 2 * PAD) + PAD,
    H - PAD - ((v - min) / span) * (H - 2 * PAD),
  ]);
  const first = series[0], last = series.at(-1);
  const cls = last < first ? 'down' : last > first ? 'up' : 'flat';
  const word = cls === 'down' ? 'bajada' : cls === 'up' ? 'subida' : 'sin cambios';
  const label = `Últimos ${series.length} días: de ${eur(first)} a ${eur(last)} (${word}); mínimo ${eur(min)}, máximo ${eur(max)}`;
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts.at(-1);
  return `<svg class="spark ${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">` +
    `<polyline points="${line}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2" fill="currentColor"/></svg>`;
}
