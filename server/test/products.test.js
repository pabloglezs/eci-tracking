import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProductUrl, computeStats, dealInfo } from '../src/products.js';
import { parseProductHtml } from '../src/scraper.js';

test('parseProductUrl extrae id y limpia query', () => {
  const r = parseProductUrl(
    'https://www.elcorteingles.es/electronica/A202047813-8806097827146-pr-movil-samsung/?parentCategoryId=1#x',
  );
  assert.equal(r.id, 'A202047813-8806097827146');
  assert.equal(r.url, 'https://www.elcorteingles.es/electronica/A202047813-8806097827146-pr-movil-samsung/');
});

test('parseProductUrl acepta ids sin variante y rechaza otros dominios/rutas', () => {
  assert.equal(parseProductUrl('https://www.elcorteingles.es/moda/A12345678-camisa/').id, 'A12345678');
  assert.equal(parseProductUrl('https://evil.com/electronica/A12345678-x/'), null);
  assert.equal(parseProductUrl('https://www.elcorteingles.es/electronica/'), null);
  assert.equal(parseProductUrl('no es una url'), null);
});

const rows = (...pairs) => pairs.map(([day, price]) => ({ day, price }));

test('computeStats', () => {
  const s = computeStats(rows(['2026-01-01', 100], ['2026-01-02', 80], ['2026-01-03', 120], ['2026-01-04', 100]));
  assert.equal(s.current, 100);
  assert.deepEqual(s.min, { price: 80, day: '2026-01-02' });
  assert.deepEqual(s.max, { price: 120, day: '2026-01-03' });
  assert.equal(s.avg, 100);
  assert.equal(computeStats([]), null);
});

test('dealInfo: bajada reciente = oferta', () => {
  const d = dealInfo(rows(['2026-01-01', 100], ['2026-01-02', 100], ['2026-01-03', 80]), '2026-01-04');
  assert.equal(d.isDeal, true);
  assert.equal(d.previousPrice, 100);
  assert.equal(d.dropPct, 20);
  assert.equal(d.dropDay, '2026-01-03');
});

test('dealInfo: bajada antigua, subida o sin cambios = no oferta', () => {
  assert.equal(dealInfo(rows(['2026-01-01', 100], ['2026-01-02', 80]), '2026-02-01').isDeal, false);
  assert.equal(dealInfo(rows(['2026-01-01', 80], ['2026-01-02', 100]), '2026-01-03').isDeal, false);
  assert.equal(dealInfo(rows(['2026-01-01', 80], ['2026-01-02', 80]), '2026-01-03').isDeal, false);
  assert.equal(dealInfo(rows(['2026-01-01', 80]), '2026-01-03').isDeal, false);
});

test('parseProductHtml lee JSON-LD de Product', () => {
  const html = `<html><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Móvil &quot;X&quot;',
    image: ['https://dam.elcorteingles.es/a.jpg'],
    offers: { '@type': 'Offer', priceCurrency: 'EUR', price: 2149 },
  })}</script></html>`;
  assert.deepEqual(parseProductHtml(html), {
    name: 'Móvil "X"',
    image: 'https://dam.elcorteingles.es/a.jpg',
    price: 2149,
    categories: [],
  });
});

test('parseProductHtml lee las categorías del BreadcrumbList (otro bloque, desordenadas)', () => {
  const crumbs = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 3, item: { '@id': 'x', name: 'Móviles 5G' } },
      { '@type': 'ListItem', position: 0, item: { name: 'Inicio' } },
      { '@type': 'ListItem', position: 1, item: { '@id': 'y', name: 'Electr&amp;ónica' } },
      { '@type': 'ListItem', position: 2, item: { '@id': 'z', name: 'Móviles y Smartphones' } },
    ],
  };
  const prod = { '@type': 'Product', name: 'P', offers: { price: 10 } };
  const wrap = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  const r = parseProductHtml(wrap(crumbs) + wrap(prod));
  assert.deepEqual(r.categories, ['Electr&ónica', 'Móviles y Smartphones', 'Móviles 5G']);
});

test('parseProductHtml soporta @graph, precio string y falla sin precio', () => {
  const graph = `<script type="application/ld+json">${JSON.stringify({
    '@graph': [{ '@type': 'WebPage' }, { '@type': ['Product'], name: 'P', offers: [{ price: '19,95' }] }],
  })}</script>`;
  assert.equal(parseProductHtml(graph).price, 19.95);
  assert.throws(() => parseProductHtml('<html>nada</html>'), /precio/);
});
