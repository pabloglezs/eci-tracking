// Inyecta un botón "Seguir precio" en las páginas de producto de El Corte Inglés.
(() => {
  const ID_RE = /\/(A\d{6,}(?:-\d{6,})?)(?=-|\/|$)/;
  const HOST_ID = 'eci-tracker-root';

  function* walk(node) {
    if (Array.isArray(node)) for (const n of node) yield* walk(n);
    else if (node && typeof node === 'object') {
      yield node;
      if (node['@graph']) yield* walk(node['@graph']);
    }
  }

  const num = (v) => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  function readProduct() {
    if (!ID_RE.test(location.pathname)) return null;
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let json;
      try {
        json = JSON.parse(s.textContent);
      } catch {
        continue;
      }
      for (const n of walk(json)) {
        if (![].concat(n['@type'] ?? []).includes('Product')) continue;
        const offer = [].concat(n.offers ?? [])[0];
        const img = [].concat(n.image ?? [])[0];
        return {
          url: location.origin + location.pathname,
          name: n.name || document.title,
          image: typeof img === 'string' ? img : img?.url,
          price: num(offer?.price ?? offer?.lowPrice),
        };
      }
    }
    return null;
  }

  const STYLE = `
    :host { all: initial; }
    .box { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; font: 14px/1.4 system-ui, sans-serif; }
    button, a.btn {
      display: inline-block; cursor: pointer; border: 0; border-radius: 999px; padding: 12px 18px;
      font: inherit; font-weight: 600; color: #fff; background: #2563eb; text-decoration: none;
      box-shadow: 0 4px 14px rgba(0,0,0,.25);
    }
    button:disabled { opacity: .7; cursor: wait; }
    .ok { background: #0a7d3b; }
    .err { background: #fff; color: #b3261e; border: 1px solid #b3261e; border-radius: 12px; padding: 10px 14px;
      max-width: 280px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .row { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  `;

  let host;
  let shadow;
  let currentUrl = '';

  function mount() {
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
  }

  function show(html, onClick) {
    shadow.innerHTML = `<style>${STYLE}</style><div class="box"><div class="row">${html}</div></div>`;
    if (onClick) shadow.querySelector('button')?.addEventListener('click', onClick);
  }

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function idle(product) {
    show(`<button>📉 Seguir precio</button>`, async () => {
      show(`<button disabled>Guardando…</button>`);
      const res = await chrome.runtime.sendMessage({ type: 'track', payload: product });
      if (res?.ok) {
        show(`<a class="btn ok" href="${escapeHtml(res.webUrl)}" target="_blank" rel="noopener">✓ ${
          res.created ? 'Siguiendo' : 'Ya se seguía'
        } · Ver historial</a>`);
      } else {
        show(`<div class="err">${escapeHtml(res?.error || 'Error desconocido')}</div><button>Reintentar</button>`, () =>
          idle(product),
        );
      }
    });
  }

  // ECI navega a veces sin recargar la página: revisamos si cambió la URL.
  function tick() {
    const key = location.origin + location.pathname;
    if (key === currentUrl) return;
    currentUrl = key;
    const product = readProduct();
    if (!product) {
      host?.remove();
      host = null;
      return;
    }
    if (!host?.isConnected) mount();
    idle(product);
  }

  tick();
  setInterval(tick, 1500);
})();
