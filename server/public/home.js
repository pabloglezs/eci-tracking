import { $, esc, eur, api } from './common.js';

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

const grid = (el, list, emptyMsg) => {
  el.innerHTML = list.length ? list.map(card).join('') : `<div class="empty" style="grid-column:1/-1">${emptyMsg}</div>`;
};

async function load() {
  const q = $('#q').value.trim();
  const { products } = await api('/api/products?' + new URLSearchParams({ q }));
  const deals = products.filter((p) => p.isDeal);
  grid($('#deals'), deals, 'Ninguna oferta por ahora. Vuelve mañana, los precios se revisan cada día.');
  grid(
    $('#all'),
    products.filter((p) => !p.isDeal),
    products.length
      ? 'Todos los productos están en oferta 🎉'
      : 'Aún no hay productos. Instala la extensión de Chrome y pulsa «Seguir precio» en una página de El Corte Inglés.',
  );
}

let t;
$('#q').addEventListener('input', () => {
  clearTimeout(t);
  t = setTimeout(load, 250);
});
load().catch((e) => ($('#all').innerHTML = `<div class="empty" style="grid-column:1/-1">${esc(e.message)}</div>`));
