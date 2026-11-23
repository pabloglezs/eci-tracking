import { $, esc, eur, api } from './common.js';

const NONE = 'Sin categoría';
let products = [];
const state = (() => {
  const p = new URLSearchParams(location.search);
  return { cat: p.get('cat') || '', sub: p.get('sub') || '' };
})();

function card(p) {
  const img = p.image
    ? `<img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="noimg">sin imagen</div>`;
  const badge = p.isDeal ? `<span class="badge">-${Math.round(p.dropPct)}%</span>` : '';
  const old = p.isDeal ? `<s>${eur(p.previousPrice)}</s>` : '';
  return `<a class="card" href="/p/${encodeURIComponent(p.id)}">${badge}${img}
    <div class="name">${esc(p.name || p.id)}</div>
    <div class="price">${p.price == null ? '<span class="muted">pendiente…</span>' : eur(p.price)}${old}</div></a>`;
}

const empty = (msg) => `<div class="empty" style="grid-column:1/-1">${msg}</div>`;

/** Cuenta productos por clave, ordenado por nº descendente. */
function count(list, key) {
  const m = new Map();
  for (const p of list) m.set(key(p), (m.get(key(p)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
}

const chip = (label, n, active, attrs) =>
  `<button class="chip" aria-pressed="${active}" ${attrs}>${esc(label)} <span class="n">${n}</span></button>`;

function setFilter(cat, sub = '') {
  state.cat = cat;
  state.sub = sub;
  const p = new URLSearchParams();
  if (cat) p.set('cat', cat);
  if (sub) p.set('sub', sub);
  history.replaceState(null, '', p.size ? `/?${p}` : '/');
  render();
}

function render() {
  const catOf = (p) => p.category || NONE;
  const cats = count(products, catOf);
  // Si la categoría del enlace ya no existe, no dejamos la portada vacía.
  if (state.cat && !cats.some(([c]) => c === state.cat)) state.cat = state.sub = '';

  $('#cats').innerHTML = cats.length > 1 || state.cat
    ? chip('Todas', products.length, !state.cat, 'data-cat=""') +
      cats.map(([c, n]) => chip(c, n, state.cat === c, `data-cat="${esc(c)}"`)).join('')
    : '';

  const inCat = state.cat ? products.filter((p) => catOf(p) === state.cat) : products;
  const subOf = (p) => p.subcategory || NONE;
  const subs = state.cat ? count(inCat, subOf) : [];
  if (state.sub && !subs.some(([s]) => s === state.sub)) state.sub = '';
  $('#subs').innerHTML = subs.length > 1
    ? chip(`Toda ${state.cat}`, inCat.length, !state.sub, 'data-sub=""') +
      subs.map(([s, n]) => chip(s, n, state.sub === s, `data-sub="${esc(s)}"`)).join('')
    : '';

  const shown = state.sub ? inCat.filter((p) => subOf(p) === state.sub) : inCat;

  const deals = shown.filter((p) => p.isDeal);
  $('#deals').innerHTML = deals.length
    ? deals.map(card).join('')
    : empty('Ninguna oferta por ahora. Vuelve mañana, los precios se revisan cada día.');

  const rest = shown.filter((p) => !p.isDeal);
  if (!rest.length) {
    $('#all').innerHTML = `<div class="grid">${empty(
      products.length
        ? 'Todos los productos están en oferta 🎉'
        : 'Aún no hay productos. Instala la extensión de Chrome y pulsa «Seguir precio» en una página de El Corte Inglés.',
    )}</div>`;
    return;
  }
  // Agrupado por categoría; si ya hay una elegida, por subcategoría.
  const groupOf = state.cat ? subOf : catOf;
  const groups = new Map();
  for (const p of rest) {
    const g = groupOf(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const names = [...groups.keys()].sort((a, b) =>
    a === NONE ? 1 : b === NONE ? -1 : groups.get(b).length - groups.get(a).length || a.localeCompare(b, 'es'),
  );
  $('#all').innerHTML = names
    .map((g) => `<section class="group"><h3>${esc(g)} <span class="n">${groups.get(g).length}</span></h3>
      <div class="grid">${groups.get(g).map(card).join('')}</div></section>`)
    .join('');
}

$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (b) setFilter(b.dataset.cat);
});
$('#subs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sub]');
  if (b) setFilter(state.cat, b.dataset.sub);
});

async function load() {
  const q = $('#q').value.trim();
  ({ products } = await api('/api/products?' + new URLSearchParams({ q })));
  render();
}

let t;
$('#q').addEventListener('input', () => {
  clearTimeout(t);
  t = setTimeout(load, 250);
});
load().catch((e) => ($('#all').innerHTML = `<div class="grid">${empty(esc(e.message))}</div>`));
