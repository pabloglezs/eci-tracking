import { $, esc, eur, api, sparkline } from './common.js';

const PAGE_SIZE = 24;
const SORTS = ['drop', 'recent', 'price_asc', 'price_desc', 'near_min'];

// Estado en la URL (compartible): ?q=&cat=&sub=&sort=&deals=1
const state = (() => {
  const p = new URLSearchParams(location.search);
  const sort = p.get('sort');
  return {
    q: p.get('q') || '',
    cat: p.get('cat') || '',
    sub: p.get('cat') ? p.get('sub') || '' : '',
    sort: SORTS.includes(sort) ? sort : 'drop',
    deals: p.get('deals') === '1',
  };
})();
let page = 1;
let data = null; // última respuesta
let items = []; // tarjetas acumuladas ("Cargar más")
let loadId = 0;

function card(p) {
  const img = p.image
    ? `<img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="noimg">sin imagen</div>`;
  const badge = p.isDeal ? `<span class="badge">-${Math.round(p.dropPct)}%</span>` : '';
  const old = p.isDeal ? `<s>${eur(p.previousPrice)}</s>` : '';
  const atMin = p.price != null && p.minPrice != null && p.price <= p.minPrice && p.maxPrice > p.minPrice;
  return `<a class="card" href="/p/${encodeURIComponent(p.id)}">${badge}${img}
    <div class="name">${esc(p.name || p.id)}</div>
    <div class="price">${p.price == null ? '<span class="muted">pendiente…</span>' : eur(p.price)}${old}</div>
    <div class="spark-row">${sparkline(p.spark) || '<span class="muted small">Sin histórico aún</span>'}${
      atMin ? '<span class="min-tag">mínimo</span>' : ''
    }</div></a>`;
}

const empty = (msg) => `<div class="empty" style="grid-column:1/-1">${msg}</div>`;

const chip = (label, n, active, attrs) =>
  `<button class="chip" aria-pressed="${active}" ${attrs}>${esc(label)} <span class="n">${n}</span></button>`;

function syncUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.cat) p.set('cat', state.cat);
  if (state.cat && state.sub) p.set('sub', state.sub);
  if (state.sort !== 'drop') p.set('sort', state.sort);
  if (state.deals) p.set('deals', '1');
  history.replaceState(null, '', p.size ? `/?${p}` : '/');
}

function renderChips() {
  const cats = data.categories;
  const total = cats.reduce((n, c) => n + c.count, 0);
  $('#cats').innerHTML = cats.length > 1 || state.cat
    ? chip('Todas', total, !state.cat, 'data-cat=""') +
      cats.map((c) => chip(c.name, c.count, state.cat === c.name, `data-cat="${esc(c.name)}"`)).join('')
    : '';
  const cur = cats.find((c) => c.name === state.cat);
  $('#subs').innerHTML = cur && cur.subcategories.length > 1
    ? chip(`Toda ${cur.name}`, cur.count, !state.sub, 'data-sub=""') +
      cur.subcategories.map((s) => chip(s.name, s.count, state.sub === s.name, `data-sub="${esc(s.name)}"`)).join('')
    : '';
}

function render() {
  renderChips();
  $('#title').textContent = state.deals ? '🔥 Ofertas' : 'Productos seguidos';
  $('#sort').value = state.sort;
  $('#deals-only').checked = state.deals;
  if (document.activeElement !== $('#q')) $('#q').value = state.q;

  const { total } = data;
  $('#count').textContent = total
    ? `${total} producto${total === 1 ? '' : 's'}${state.deals ? ' en oferta (bajada en los últimos 7 días)' : ''}`
    : '';
  if (!items.length) {
    const msg = state.deals
      ? 'Ninguna oferta con estos filtros. Los precios se revisan cada día.'
      : state.q || state.cat
        ? 'Ningún producto coincide con estos filtros.'
        : 'Aún no hay productos. Pega arriba la URL de uno de El Corte Inglés o usa la extensión de Chrome.';
    $('#list').innerHTML = empty(msg);
  } else {
    $('#list').innerHTML = items.map(card).join('');
  }
  $('#more').hidden = items.length >= total;
  $('#more').textContent = `Cargar más (${total - items.length} restantes)`;
}

async function load({ append = false } = {}) {
  const id = ++loadId;
  page = append ? page + 1 : 1;
  const params = new URLSearchParams({ sort: state.sort, page, limit: PAGE_SIZE });
  if (state.q) params.set('q', state.q);
  if (state.cat) params.set('cat', state.cat);
  if (state.cat && state.sub) params.set('sub', state.sub);
  if (state.deals) params.set('deals', '1');
  $('#list').setAttribute('aria-busy', 'true');
  try {
    const res = await api('/api/products?' + params);
    if (id !== loadId) return; // llegó otra petición después
    // Si la categoría del enlace ya no existe, no dejamos la portada vacía.
    if (state.cat && !append && !res.categories.some((c) => c.name === state.cat)) {
      state.cat = state.sub = '';
      syncUrl();
      return load();
    }
    data = res;
    items = append ? [...items, ...res.products] : res.products;
    render();
  } catch (e) {
    if (id !== loadId) return;
    $('#list').innerHTML = empty(esc(e.message));
    $('#more').hidden = true;
  } finally {
    if (id === loadId) $('#list').removeAttribute('aria-busy');
  }
}

function setFilter(patch) {
  Object.assign(state, patch);
  syncUrl();
  load();
}

$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (b) setFilter({ cat: b.dataset.cat, sub: '' });
});
$('#subs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sub]');
  if (b) setFilter({ sub: b.dataset.sub });
});
$('#sort').addEventListener('change', (e) => setFilter({ sort: e.target.value }));
$('#deals-only').addEventListener('change', (e) => setFilter({ deals: e.target.checked }));
$('#more').addEventListener('click', () => load({ append: true }));

let t;
$('#q').addEventListener('input', (e) => {
  clearTimeout(t);
  t = setTimeout(() => setFilter({ q: e.target.value.trim().slice(0, 100) }), 250);
});

// --- Añadir producto pegando la URL (mismo POST /api/products que usa la extensión)
const ECI_HOSTS = ['www.elcorteingles.es', 'elcorteingles.es'];
function validateEciUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return 'Eso no parece una URL. Copia la dirección completa de la página del producto.';
  }
  if (!['https:', 'http:'].includes(u.protocol) || !ECI_HOSTS.includes(u.hostname)) {
    return 'La URL debe ser de elcorteingles.es.';
  }
  if (!/\/A\d{6,}(?:-\d{6,})?(?=-|\/|$)/.test(u.pathname)) {
    return 'Esa página no parece la de un producto concreto (falta su referencia «A…»). Abre el producto y copia su URL.';
  }
  return '';
}

function setAddMsg(html, kind = '') {
  const m = $('#add-msg');
  m.className = 'msg ' + kind;
  m.innerHTML = html;
}

$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#add-url');
  const btn = $('#add-btn');
  const err = validateEciUrl(input.value);
  if (err) {
    input.setAttribute('aria-invalid', 'true');
    return setAddMsg(esc(err), 'err');
  }
  input.removeAttribute('aria-invalid');
  btn.disabled = true;
  btn.textContent = 'Añadiendo…';
  setAddMsg('Añadiendo el producto…');
  try {
    const res = await api('/api/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: input.value.trim() }),
    });
    const link = `/p/${encodeURIComponent(res.product.id)}`;
    setAddMsg(
      res.created
        ? `✓ Producto añadido. Su precio se consultará en unos segundos. <a href="${link}">Ver ficha</a>`
        : `Este producto ya se estaba siguiendo. <a href="${link}">Ver ficha</a>`,
      'ok',
    );
    input.value = '';
    load();
  } catch (e2) {
    setAddMsg(esc(e2.message || 'No se pudo añadir el producto'), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Seguir precio';
  }
});

load();
