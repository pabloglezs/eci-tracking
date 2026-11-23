const ext = globalThis.browser ?? globalThis.chrome;
const view = document.getElementById('view');
const DEFAULT_API = 'http://localhost:3000';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eur = (n) => (n == null ? '' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n));

async function apiUrl() {
  const { apiUrl } = await ext.storage.sync.get('apiUrl');
  return (apiUrl || DEFAULT_API).replace(/\/+$/, '');
}

const openTracker = async () => {
  ext.tabs.create({ url: await apiUrl() });
  window.close();
};

function notProduct(msg) {
  view.innerHTML = `<p class="muted">${msg}</p>
    <button id="open">Abrir ECI Tracker</button>
    <button id="opts" class="secondary">Opciones</button>`;
  document.getElementById('open').onclick = openTracker;
  document.getElementById('opts').onclick = () => ext.runtime.openOptionsPage();
}

const ID_RE = /\/(A\d{6,}(?:-\d{6,})?)(?=-|\/|$)/;

// Producto que ya se sigue: precios y enlace al historial en lugar del botón.
function showTracked(product, info) {
  const st = info.stats;
  const cell = (label, v) => `<div><div class="k">${label}</div><div class="v">${eur(v)}</div></div>`;
  view.innerHTML = `<div class="name">${esc(product.name)}</div>
    <p class="badge">✓ Ya lo sigues</p>
    ${
      st
        ? `<div class="stats">${cell('Actual', st.current)}${cell('Mínimo', st.min.price)}${cell('Máximo', st.max.price)}</div>`
        : '<p class="muted">Aún sin precios registrados.</p>'
    }
    <a class="btn ok" id="hist" href="#">Ver historial</a>`;
  document.getElementById('hist').onclick = (e) => {
    e.preventDefault();
    ext.tabs.create({ url: info.webUrl });
    window.close();
  };
}

function showProduct(product, note) {
  view.innerHTML = `<div class="name">${esc(product.name)}</div>
    <div class="price">${eur(product.price)}</div>
    <button id="track">Seguir precio</button>
    <button id="open" class="secondary">Abrir ECI Tracker</button>
    <div id="err" class="err">${esc(note || '')}</div>`;
  document.getElementById('open').onclick = openTracker;
  const btn = document.getElementById('track');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    const res = await ext.runtime.sendMessage({ type: 'track', payload: product });
    if (res?.ok) {
      btn.outerHTML = `<a class="btn ok" id="done" href="#">✓ ${res.created ? 'Siguiendo' : 'Ya se seguía'} · Ver historial</a>`;
      document.getElementById('done').onclick = (e) => {
        e.preventDefault();
        ext.tabs.create({ url: res.webUrl });
        window.close();
      };
    } else {
      btn.disabled = false;
      btn.textContent = 'Reintentar';
      document.getElementById('err').textContent = res?.error || 'Error desconocido';
    }
  };
}

(async () => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:\/\/(www\.)?elcorteingles\.es\//.test(tab.url)) {
    return notProduct('Abre la ficha de un producto en elcorteingles.es para seguir su precio.');
  }
  let product;
  try {
    product = await ext.tabs.sendMessage(tab.id, { type: 'getProduct' });
  } catch {
    return notProduct('Recarga la página de El Corte Inglés y vuelve a abrir esto.');
  }
  if (!product) return notProduct('Esta página no parece la ficha de un producto.');
  view.innerHTML = '<p class="muted">Consultando…</p>';
  const id = new URL(product.url).pathname.match(ID_RE)?.[1];
  let info = null;
  try {
    info = id ? await ext.runtime.sendMessage({ type: 'info', id }) : null;
  } catch {
    // background no disponible: se ofrece seguir igualmente
  }
  if (info?.ok && info.found) return showTracked(product, info);
  // 404 = aún no se sigue; error de red o lentitud: se ofrece seguir igualmente, avisando.
  showProduct(product, info && !info.ok ? `${info.error} · no se pudo comprobar si ya lo sigues.` : '');
})();
