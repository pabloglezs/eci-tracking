// Inyecta un botón "Seguir precio" en las páginas de producto de El Corte Inglés.
(() => {
  const ID_RE = /\/(A\d{6,}(?:-\d{6,})?)(?=-|\/|$)/;
  const HOST_ID = 'eci-tracker-root';
  const ext = globalThis.browser ?? globalThis.chrome;

  // Restos de una instancia anterior (p. ej. extensión recargada con la pestaña abierta):
  // se quitan para no duplicar botones.
  document.getElementById(HOST_ID)?.remove();
  document.querySelectorAll('[data-eci-mini]').forEach((n) => n.remove());

  let dead = false; // la extensión se recargó/desinstaló: este script quedó huérfano
  const timers = [];
  let observer;

  function shutdown() {
    if (dead) return;
    dead = true;
    observer?.disconnect();
    timers.forEach(clearInterval);
    document.getElementById(HOST_ID)?.remove();
    document.querySelectorAll('[data-eci-mini]').forEach((n) => n.remove());
  }

  // Mensaje al background tolerante a "Extension context invalidated".
  async function send(msg) {
    if (dead) return { ok: false, error: 'Recarga la página (la extensión se actualizó)' };
    try {
      if (!ext?.runtime?.id) throw new Error('invalidated');
      return await ext.runtime.sendMessage(msg);
    } catch {
      if (!ext?.runtime?.id) shutdown();
      return { ok: false, error: 'No se pudo contactar con la extensión. Recarga la página.' };
    }
  }

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
        // En navegación SPA el JSON-LD puede ser aún el del producto anterior.
        const ldId = String(n.url ?? '').match(ID_RE)?.[1];
        if (ldId && ldId !== location.pathname.match(ID_RE)?.[1]) continue;
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
    .card { background: #fff; color: #1a1a1a; border-radius: 14px; padding: 12px 14px; min-width: 220px;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
    .card .btn { text-align: center; box-shadow: none; padding: 9px 14px; }
    .badge { color: #0a7d3b; font-weight: 600; }
    .stats { display: flex; gap: 14px; }
    .stats .k { display: block; font-size: 11px; color: #666; text-transform: uppercase; }
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

  const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

  // Producto ya seguido: precios y enlace al historial en lugar del botón.
  function showTracked(info) {
    const st = info.stats;
    const cell = (k, v) => `<div><span class="k">${k}</span><b>${eur(v)}</b></div>`;
    show(`<div class="card"><div class="badge">✓ Siguiendo en ECI Tracker</div>${
      st ? `<div class="stats">${cell('Actual', st.current)}${cell('Mín.', st.min.price)}${cell('Máx.', st.max.price)}</div>` : ''
    }<a class="btn ok" href="${escapeHtml(info.webUrl)}" target="_blank" rel="noopener">Ver historial</a></div>`);
  }

  // Consulta si el producto ya se sigue; ignora la respuesta si mientras tanto se navegó a otro.
  async function refreshStatus(product) {
    const id = new URL(product.url).pathname.match(ID_RE)?.[1];
    if (!id) return;
    const key = currentUrl;
    const info = await send({ type: 'info', id });
    if (dead || key !== currentUrl || !host?.isConnected) return;
    if (info?.ok && info.found) showTracked(info);
    // 404 o error (servidor caído/lento): se deja el botón "Seguir precio".
  }

  function idle(product, checkStatus = true) {
    if (checkStatus) refreshStatus(product);
    show(`<button>📉 Seguir precio</button>`, async () => {
      show(`<button disabled>Guardando…</button>`);
      const res = await send({ type: 'track', payload: product });
      if (res?.ok) {
        const info = await send({ type: 'info', id: new URL(product.url).pathname.match(ID_RE)?.[1] });
        if (info?.ok && info.found) return showTracked(info);
        show(`<a class="btn ok" href="${escapeHtml(res.webUrl)}" target="_blank" rel="noopener">✓ ${
          res.created ? 'Siguiendo' : 'Ya se seguía'
        } · Ver historial</a>`);
      } else {
        show(`<div class="err">${escapeHtml(res?.error || 'Error desconocido')}</div><button>Reintentar</button>`, () =>
          idle(product, false),
        );
      }
    });
  }

  // ECI navega a veces sin recargar la página: revisamos si cambió la URL.
  function tick() {
    if (dead || document.hidden) return;
    const key = location.origin + location.pathname;
    if (key === currentUrl && host?.isConnected) return;
    const product = readProduct();
    if (!product) {
      // Sin ficha (o JSON-LD aún sin cargar en una navegación SPA): se reintenta en el siguiente tick.
      currentUrl = '';
      host?.remove();
      host = null;
      return;
    }
    currentUrl = key;
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
      res = await send({ type: 'track', payload: e.payload });
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
    const data = cardData(card);
    const existing = card.querySelector(':scope > [data-eci-mini]');
    if (existing) {
      // Las tarjetas se reciclan: si ahora muestran otro producto, se actualiza el botón.
      const e = minis.get(existing);
      if (e && data && e.id !== data.id) {
        e.id = data.id;
        e.payload = data.payload;
        paintMini(e, tracked.has(data.id) ? 'ok' : 'idle');
      }
      return;
    }
    if (!data) return;
    // El botón se posiciona sobre la tarjeta (también en modo lista): ésta debe ser su referencia.
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
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
    if (dead || document.hidden) return;
    for (const card of document.querySelectorAll(CARD_SEL)) addMini(card);
    for (const host of minis.keys()) if (!host.isConnected) minis.delete(host);

    // Una sola consulta por tanda para marcar los que ya están en el tracker.
    if (Date.now() < statusBlockedUntil) return;
    const fresh = [...new Set([...minis.values()].map((e) => e.id))].filter((id) => !queried.has(id)).slice(0, 100);
    if (!fresh.length) return;
    fresh.forEach((id) => queried.add(id));
    let res;
    try {
      res = await send({ type: 'status', ids: fresh });
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
  observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();

  // El popup de la extensión pide los datos del producto de la pestaña activa.
  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!dead && msg?.type === 'getProduct') sendResponse(readProduct());
  });

  tick();
  timers.push(setInterval(tick, 1500));
})();
