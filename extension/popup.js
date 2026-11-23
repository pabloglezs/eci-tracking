const view = document.getElementById('view');
const DEFAULT_API = 'http://localhost:3000';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eur = (n) => (n == null ? '' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n));

async function apiUrl() {
  const { apiUrl } = await chrome.storage.sync.get('apiUrl');
  return (apiUrl || DEFAULT_API).replace(/\/+$/, '');
}

const openTracker = async () => {
  chrome.tabs.create({ url: await apiUrl() });
  window.close();
};

function notProduct(msg) {
  view.innerHTML = `<p class="muted">${msg}</p>
    <button id="open">Abrir ECI Tracker</button>
    <button id="opts" class="secondary">Opciones</button>`;
  document.getElementById('open').onclick = openTracker;
  document.getElementById('opts').onclick = () => chrome.runtime.openOptionsPage();
}

function showProduct(product) {
  view.innerHTML = `<div class="name">${esc(product.name)}</div>
    <div class="price">${eur(product.price)}</div>
    <button id="track">Seguir precio</button>
    <button id="open" class="secondary">Abrir ECI Tracker</button>
    <div id="err" class="err"></div>`;
  document.getElementById('open').onclick = openTracker;
  const btn = document.getElementById('track');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    const res = await chrome.runtime.sendMessage({ type: 'track', payload: product });
    if (res?.ok) {
      btn.outerHTML = `<a class="btn ok" id="done" href="#">✓ ${res.created ? 'Siguiendo' : 'Ya se seguía'} · Ver historial</a>`;
      document.getElementById('done').onclick = (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: res.webUrl });
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:\/\/(www\.)?elcorteingles\.es\//.test(tab.url)) {
    return notProduct('Abre la ficha de un producto en elcorteingles.es para seguir su precio.');
  }
  let product;
  try {
    product = await chrome.tabs.sendMessage(tab.id, { type: 'getProduct' });
  } catch {
    return notProduct('Recarga la página de El Corte Inglés y vuelve a abrir esto.');
  }
  if (!product) return notProduct('Esta página no parece la ficha de un producto.');
  showProduct(product);
})();
