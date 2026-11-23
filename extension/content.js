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

  // ---------------------------------------------------------------------------
  // Mini botón en las tarjetas de listados, búsquedas y carruseles.
  // Las tarjetas (article.product_preview) se pintan en el cliente y se hidratan
  // después, así que se observa el DOM y se añade el botón cuando ya tienen enlace.
  // ---------------------------------------------------------------------------
  const CARD_SEL = 'article.product_preview';
  const MINI_STYLE = `
    :host { all: initial; }
    button {
      all: unset; box-sizing: border-box; width: 32px; height: 32px; border-radius: 50%;
      display: grid; place-items: center; cursor: pointer; font: 600 15px/1 system-ui, sans-serif;
      background: #fff; color: #2563eb; box-shadow: 0 1px 5px rgba(0,0,0,.35);
    }
    button:hover { background: #eff4ff; }
    button.ok { background: #0a7d3b; color: #fff; }
    button.err { background: #b3261e; color: #fff; }
    button:disabled { opacity: .6; cursor: wait; }
    button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  `;
  const minis = new Map(); // host -> { id, btn, payload, state }
  const tracked = new Set(); // ids que el tracker ya sigue
  const queried = new Set(); // ids ya consultados al servidor
  let webBase = null;

  function cardData(card) {
    const a = card.querySelector('a.product_preview-title');
    if (!a) return null; // tarjeta todavía sin hidratar
    const path = (a.getAttribute('href') || '').split(/[?#]/)[0];
    const m = path.match(ID_RE);
    if (!m) return null;
    const priceText = card.querySelector('.price-omnibus__formatted-price')?.textContent ?? '';
    const pm = priceText.match(/([\d.]+(?:,\d{1,2})?)\s*€/);
    return {
      id: m[1],
      payload: {
        url: location.origin + path,
        name: a.getAttribute('title') || a.textContent.trim(),
        image: card.querySelector('img.js_preview_image')?.src,
        price: pm ? num(pm[1].replace(/\./g, '')) : null,
      },
    };
  }

  function paintMini(e, state, msg) {
    e.state = state;
    e.btn.className = state === 'ok' || state === 'err' ? state : '';
    e.btn.disabled = state === 'busy';
    e.btn.textContent = { ok: '✓', err: '!', busy: '…', idle: '📉' }[state];
    e.btn.title = {
      ok: 'Ya se sigue en ECI Tracker · clic para ver el historial',
      err: `${msg || 'Error'} · clic para reintentar`,
      busy: 'Guardando…',
      idle: 'Seguir el precio con ECI Tracker',
    }[state];
    e.btn.setAttribute('aria-label', e.btn.title);
  }

  async function onMiniClick(e) {
    if (e.state === 'ok' && webBase) {
      window.open(`${webBase}/p/${encodeURIComponent(e.id)}`, '_blank', 'noopener');
      return;
    }
    paintMini(e, 'busy');
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'track', payload: e.payload });
    } catch {
      res = { ok: false, error: 'Recarga la página (la extensión se actualizó)' };
    }
    if (res?.ok) {
      tracked.add(e.id);
      webBase = res.base || webBase;
      for (const other of minis.values()) if (other.id === e.id) paintMini(other, 'ok');
    } else {
      paintMini(e, 'err', res?.error);
    }
  }

  function addMini(card) {
    if (card.querySelector(':scope > [data-eci-mini]')) return;
    const data = cardData(card);
    if (!data) return;
    const host = document.createElement('div');
    host.dataset.eciMini = '1';
    host.style.cssText = 'position:absolute;top:12px;left:12px;z-index:20;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${MINI_STYLE}</style><button type="button"></button>`;
    const entry = { id: data.id, btn: root.querySelector('button'), payload: data.payload, state: 'idle' };
    paintMini(entry, tracked.has(data.id) ? 'ok' : 'idle');
    // El clic no debe llegar a la tarjeta (que abriría el producto).
    for (const ev of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart']) {
      host.addEventListener(ev, (e) => e.stopPropagation());
    }
    entry.btn.addEventListener('click', (e) => {
      e.preventDefault();
      onMiniClick(entry);
    });
    card.appendChild(host);
    minis.set(host, entry);
  }

  let statusBlockedUntil = 0;

  async function scan() {
    for (const card of document.querySelectorAll(CARD_SEL)) addMini(card);
    for (const host of minis.keys()) if (!host.isConnected) minis.delete(host);

    // Una sola consulta por tanda para marcar los que ya están en el tracker.
    if (Date.now() < statusBlockedUntil) return;
    const fresh = [...new Set([...minis.values()].map((e) => e.id))].filter((id) => !queried.has(id)).slice(0, 100);
    if (!fresh.length) return;
    fresh.forEach((id) => queried.add(id));
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'status', ids: fresh });
    } catch {
      return; // extensión recargada: el botón seguirá funcionando tras recargar la página
    }
    if (!res?.ok) {
      fresh.forEach((id) => queried.delete(id));
      statusBlockedUntil = Date.now() + 30_000; // servidor caído: no insistir en cada cambio del DOM
      return;
    }
    webBase = res.base || webBase;
    for (const id of res.tracked) tracked.add(id);
    for (const e of minis.values()) if (tracked.has(e.id) && e.state === 'idle') paintMini(e, 'ok');
  }

  let scanTimer;
  const scheduleScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  };
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();

  // El popup de la extensión pide los datos del producto de la pestaña activa.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'getProduct') sendResponse(readProduct());
  });

  tick();
  setInterval(tick, 1500);
})();
