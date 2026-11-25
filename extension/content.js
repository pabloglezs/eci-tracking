// Inyecta un botón "Seguir precio" en las páginas de producto de El Corte Inglés.
(() => {
  // Ids de producto: A123456[-123456] (catálogo ECI) o MP_<vendedor>_<sku> (marketplace).
  const ID_RE = /\/((?:A\d{6,}(?:-\d{6,})?)|(?:MP_\d+_[A-Z0-9]+))(?=-|\/|$)/;
  const HOST_ID = 'eci-tracker-root';
  const ext = globalThis.browser ?? globalThis.chrome;

  // Restos de una instancia anterior (p. ej. extensión recargada con la pestaña abierta):
  // se quitan para no duplicar botones.
  document.getElementById(HOST_ID)?.remove();
  document.getElementById('eci-tracker-bulk')?.remove();
  document.querySelectorAll('[data-eci-mini]').forEach((n) => n.remove());
  document.querySelectorAll('[data-eci-card]').forEach((n) => delete n.dataset.eciCard);

  let dead = false; // la extensión se recargó/desinstaló: este script quedó huérfano
  const timers = [];
  let observer;

  function shutdown() {
    if (dead) return;
    dead = true;
    observer?.disconnect();
    timers.forEach(clearInterval);
    document.getElementById(HOST_ID)?.remove();
  document.getElementById('eci-tracker-bulk')?.remove();
    document.querySelectorAll('[data-eci-mini]').forEach((n) => n.remove());
  document.querySelectorAll('[data-eci-card]').forEach((n) => delete n.dataset.eciCard);
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
    return readMarketplaceProduct();
  }

  // Las fichas de marketplace (MP_<vendedor>_<sku>) no traen un Product con precio en el JSON-LD:
  // se toma el nombre del <h1>/og:title, la imagen de og:image y el precio de venta del texto accesible.
  function readMarketplaceProduct() {
    const pathId = location.pathname.match(ID_RE)?.[1];
    if (!pathId?.startsWith('MP_')) return null;
    // En navegación SPA los metadatos pueden ser aún los de la ficha anterior.
    const canonId = document.querySelector('link[rel="canonical"]')?.href.match(ID_RE)?.[1];
    if (canonId && canonId !== pathId) return null;
    const meta = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content;
    const name = (document.querySelector('h1')?.textContent || meta('og:title') || '')
      .replace(/\s*·\s*El Corte Inglés\s*$/, '')
      .trim();
    if (!name) return null;
    // Precio de venta de la ficha (no el de tarjetas de recomendados, ni «Precio original»/PVPR).
    let price = null;
    for (const e of document.querySelectorAll('.sr-only')) {
      if (e.closest('article.product_preview, [class*="carousel" i]')) continue;
      const t = e.textContent;
      if (!/precio de venta/i.test(t) || /original|pvp|antes|anterior/i.test(t)) continue;
      const m = t.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*€/);
      if (m) {
        price = num(m[1].replace(/\./g, ''));
        break;
      }
    }
    return { url: location.origin + location.pathname, name, image: meta('og:image') || undefined, price };
  }

  const STYLE = `
    :host { all: initial; }
    .box { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; font: 14px/1.4 system-ui, sans-serif; }
    button, a.btn {
      display: inline-block; cursor: pointer; border: 0; border-radius: 999px; padding: 12px 18px;
      font: inherit; font-weight: 600; color: #fff; background: #007a4d; text-decoration: none;
      box-shadow: 0 4px 14px rgba(0,0,0,.25);
    }
    button:disabled { opacity: .7; cursor: wait; }
    .ok, a.btn.ok { background: #005c3a; }
    .err { background: #fff; color: #b3261e; border: 1px solid #b3261e; border-radius: 12px; padding: 10px 14px;
      max-width: 280px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .card { background: #fff; color: #1a1a1a; border-radius: 14px; padding: 12px 14px; min-width: 220px;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
    .card .btn { text-align: center; box-shadow: none; padding: 9px 14px; }
    .badge { color: #005c3a; font-weight: 600; }
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
    if (dead) return;
    // Navegación SPA a otra página: se cancela/limpia el alta masiva.
    if (bulk.mode !== 'idle' && bulk.url && bulk.url !== pageKey()) cancelBulk();
    if (document.hidden) return;
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
      background: #fff; color: #007a4d; box-shadow: 0 1px 5px rgba(0,0,0,.35);
    }
    button:hover { background: #e8f5ee; }
    button.ok { background: #005c3a; color: #fff; }
    button.err { background: #b3261e; color: #fff; }
    button:disabled { opacity: .6; cursor: wait; }
    button:focus-visible { outline: 2px solid #007a4d; outline-offset: 2px; }
  `;
  const minis = new Map(); // host -> { id, btn, payload, state }
  const tracked = new Set(); // ids que el tracker ya sigue
  const queried = new Set(); // ids ya consultados al servidor
  const answered = new Set(); // ids cuya respuesta de /api/tracked ya llegó
  let webBase = null;

  // Enlaces que no son tarjetas de producto (menús, migas, cabecera, pie).
  const EXCLUDE = 'header, nav, footer, [role="navigation"], [class*="breadcrumb" i], [class*="megamenu" i], [data-eci-mini]';
  const STOP_TAGS = new Set(['BODY', 'MAIN', 'HTML', 'UL', 'OL', 'HEADER', 'NAV', 'FOOTER', 'FORM']);
  const idOf = (a) => (a.getAttribute('href') || '').split(/[?#]/)[0].match(ID_RE)?.[1] ?? null;

  // Detección independiente de las clases de ECI: se parte de los enlaces a producto y se sube
  // mientras el ancestro siga conteniendo UN solo producto (las variantes de color comparten el
  // prefijo A\d+ del id). La tarjeta es el último ancestro antes de abarcar otro producto o de
  // llegar a UL/OL/MAIN/BODY/FORM; basta con que tenga una imagen (agotados y sin precio incluidos).
  // En marketplace las variantes cambian el final del SKU: se agrupa por vendedor + 6 primeros caracteres.
  const baseId = (id) => id.match(/^A\d+|^MP_\d+_[A-Z0-9]{1,6}/)[0];
  const MAX_CARD_H = 1100; // un contenedor más alto no es una tarjeta (p. ej. una rejilla con un solo producto)

  function climbToCard(a) {
    const base = baseId(idOf(a));
    let card = null;
    let el = a;
    for (let d = 0; d < 10 && el.parentElement; d++) {
      el = el.parentElement;
      if (STOP_TAGS.has(el.tagName) || el.matches(EXCLUDE)) break;
      let other = false;
      for (const l of el.querySelectorAll('a[href]')) {
        const i = idOf(l);
        if (i && baseId(i) !== base) { other = true; break; }
      }
      if (other || el.querySelector('h1')) break;
      if (el.offsetHeight > MAX_CARD_H) break;
      card = el;
    }
    return card?.querySelector('img') ? card : null;
  }

  function findCards() {
    const cards = new Set(document.querySelectorAll(`${CARD_SEL}, [data-eci-card]`));
    for (const a of document.querySelectorAll('a[href]')) {
      const id = idOf(a);
      if (!id || a.closest(EXCLUDE) || a.closest(CARD_SEL) || a.closest('[data-eci-card]')) continue;
      const card = climbToCard(a);
      // Donde existe el marcado conocido (article.product_preview, verificado en listados y
      // búsquedas) se prefiere esa tarjeta a su contenedor, para no cambiar la posición del botón.
      if (card) cards.add(card.querySelector(CARD_SEL) ?? card);
    }
    // Si dos candidatos se anidan (enlace del título y de la imagen), se queda el exterior.
    for (const c of cards) for (const o of cards) if (c !== o && c.contains(o)) cards.delete(o);
    return cards;
  }

  const AMOUNT = /(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*€/g;
  const toNum = (t) => num(t.replace(/\./g, ''));
  // Elementos de precio "no vigente": tachado, PVPR, antes, promos.
  const OLD_PRICE =
    's, del, strike, [class*="recommended" i], [class*="strike" i], [class*="crossed" i], [class*="old-price" i], [class*="price-old" i], [class*="previous" i], [class*="original" i], [class*="pvp" i], [class*="promo" i], [class*="badge" i], [class*="discount" i]';

  // Precio actual (de venta) de la tarjeta; null si no se puede determinar con fiabilidad.
  function currentPrice(card) {
    const sale = [...card.querySelectorAll('.sr-only, [class*="sr-only" i], [class*="visually-hidden" i]')]
      .map((e) => e.textContent)
      .find((t) => /precio de venta|precio actual|ahora/i.test(t) && !/pvp|antes|anterior|recomendado/i.test(t));
    const sm = sale && [...sale.matchAll(AMOUNT)][0];
    if (sm) return toNum(sm[1]);
    const clone = card.cloneNode(true);
    clone.querySelectorAll(OLD_PRICE).forEach((n) => n.remove());
    const scope = clone.querySelector('[class*="pric" i]') ?? clone;
    const found = new Set();
    for (const m of scope.textContent.matchAll(AMOUNT)) found.add(toNum(m[1]));
    found.delete(null);
    return found.size === 1 ? [...found][0] : null;
  }

  function cardData(card) {
    const links = [...card.querySelectorAll('a[href]')].filter((l) => idOf(l));
    const a = card.querySelector('a.product_preview-title') ?? links.find((l) => l.getAttribute('title') || l.textContent.trim()) ?? links[0];
    if (!a) return null; // tarjeta todavía sin hidratar
    const id = idOf(a);
    if (!id) return null;
    const path = a.getAttribute('href').split(/[?#]/)[0];
    const img = card.querySelector('img.js_preview_image') ?? card.querySelector('img');
    const name =
      a.getAttribute('title') || a.textContent.trim() || img?.getAttribute('alt') || card.querySelector('h2,h3,h4')?.textContent.trim();
    if (!name) return null;
    return {
      id,
      payload: {
        url: location.origin + path,
        name,
        image: img?.currentSrc || img?.src || undefined,
        price: currentPrice(card),
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
    card.dataset.eciCard = '1';
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

  // ---------------------------------------------------------------------------
  // «Seguir todos»: alta de los productos visibles de la página con un solo clic.
  // Coexistencia con el botón de la ficha: en fichas de producto (botón flotante de la ficha
  // montado) este widget no se muestra, aunque haya carruseles de recomendados.
  // Se envía UNA sola petición con todo el lote (el servidor da de alta y consulta a su ritmo),
  // así que el usuario puede cerrar la página en cuanto se envía.
  // ---------------------------------------------------------------------------
  const BULK_MAX = 100; // tope por clic (una sola petición POST /api/products/bulk)
  const BULK_HOST_ID = 'eci-tracker-bulk';
  const BULK_STYLE = `
    :host { all: initial; }
    .box { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; font: 14px/1.4 system-ui, sans-serif; }
    .panel { background: #fff; color: #1a1a1a; border-radius: 14px; padding: 12px 14px; max-width: 290px;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
    button { font: inherit; font-weight: 600; cursor: pointer; border-radius: 999px; padding: 10px 16px;
      border: 1px solid #007a4d; background: #007a4d; color: #fff; box-shadow: 0 4px 14px rgba(0,0,0,.2); }
    button.secondary { background: #fff; color: #007a4d; box-shadow: none; }
    button:focus-visible { outline: 3px solid #005c3a; outline-offset: 2px; }
    .main { display: block; }
    .note { font-size: 12px; color: #555; margin: 0; }
    .row { display: flex; gap: 8px; }
    .row button { flex: 1; }
    .warn { color: #b3261e; font-weight: 600; margin: 0; }
    p { margin: 0; }
  `;
  const bulk = { mode: 'idle', key: '', url: '', list: [] };
  let bulkHost;
  let bulkShadow;
  const pageKey = () => location.origin + location.pathname + location.search;
  function bulkCandidates() {
    const seen = new Set();
    const out = [];
    for (const e of minis.values()) {
      // Sólo ids ya consultados al servidor (si no, se contarían los ya seguidos).
      if (!e.btn.isConnected || e.state === 'busy' || !answered.has(e.id) || tracked.has(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, payload: { ...e.payload } });
    }
    return out;
  }

  function removeBulk() {
    bulkHost?.remove();
    bulkHost = null;
    bulk.key = '';
  }

  function renderBulk(html, acts = {}, focus = false) {
    if (!bulkHost?.isConnected) {
      bulkHost = document.createElement('div');
      bulkHost.id = BULK_HOST_ID;
      bulkShadow = bulkHost.attachShadow({ mode: 'closed' });
      document.documentElement.appendChild(bulkHost);
    }
    bulkShadow.innerHTML = `<style>${BULK_STYLE}</style><div class="box"><div class="panel" role="region" aria-label="ECI Tracker">${html}</div></div>`;
    for (const [act, fn] of Object.entries(acts)) bulkShadow.querySelector(`[data-act="${act}"]`)?.addEventListener('click', fn);
    if (focus) bulkShadow.querySelector('button')?.focus?.({ preventScroll: true });
  }

  function updateBulk() {
    if (dead || bulk.mode !== 'idle') return;
    const list = bulkCandidates();
    if (list.length < 2 || host?.isConnected) return removeBulk();
    const n = list.length;
    if (bulkHost?.isConnected && bulk.key === String(n)) return;
    bulk.key = String(n);
    const label = n > BULK_MAX ? `Seguir los primeros ${BULK_MAX} de ${n}` : `Seguir todos (${n})`;
    const note =
      n > BULK_MAX ? '<p class="note">Puedes repetir el clic o desplazarte para cargar más productos.</p>' : '';
    renderBulk(`<button class="main" data-act="start">📉 ${label}</button>${note}`, {
      start: () => confirmBulk(list.slice(0, BULK_MAX), n),
    });
  }

  function confirmBulk(list, total) {
    bulk.mode = 'confirm';
    bulk.url = pageKey();
    bulk.list = list;
    const extra = total > list.length ? ` (de ${total} sin seguir)` : '';
    renderBulk(
      `<p>¿Seguir ${list.length} productos${extra}? Se consultará su precio cada día.</p>
       <div class="row"><button data-act="ok">Confirmar</button><button class="secondary" data-act="no">Cancelar</button></div>`,
      { ok: () => sendBulk(list), no: () => resetBulk() },
      true,
    );
  }

  function resetBulk() {
    bulk.mode = 'idle';
    bulk.list = [];
    removeBulk();
    updateBulk();
  }

  // Navegación a otra página: se limpia el widget (un envío en curso termina por su cuenta).
  function cancelBulk() {
    if (bulk.mode !== 'idle' && bulk.mode !== 'sending') resetBulk();
  }

  const paintId = (id, state, msg) => {
    for (const e of minis.values()) if (e.id === id && e.btn.isConnected) paintMini(e, state, msg);
  };

  // Item del lote: sólo los campos del contrato de POST /api/products (nulos/undefined se omiten).
  const bulkItem = ({ url, name, image, price }) => {
    const item = { url, name };
    if (image) item.image = image;
    if (price != null) item.price = price;
    return item;
  };

  // Una sola petición con todo el lote: el servidor da de alta y consulta los precios a su ritmo.
  async function sendBulk(list) {
    if (bulk.mode === 'sending') return; // sin dobles envíos
    bulk.mode = 'sending';
    const key = pageKey();
    bulk.url = key;
    renderBulk(`<p role="status" aria-live="polite">Enviando ${list.length} productos…</p>`);
    for (const it of list) paintId(it.id, 'busy');
    const res = await send({ type: 'trackBulk', items: list.map((it) => bulkItem(it.payload)) });
    if (dead) return;
    if (!res?.ok) {
      for (const it of list) paintId(it.id, tracked.has(it.id) ? 'ok' : 'idle');
      if (pageKey() !== key) return resetBulk();
      const msg =
        res?.status === 404
          ? 'Tu servidor aún no admite el alta masiva: actualízalo.'
          : res?.error || 'No se pudo conectar con el servidor.';
      bulk.mode = 'summary';
      renderBulk(
        `<p class="warn" role="status" aria-live="polite">${escapeHtml(msg)}</p>
         <div class="row">${res?.status ? '' : '<button data-act="retry">Reintentar</button>'}<button class="secondary" data-act="close">Cerrar</button></div>`,
        { retry: () => { bulk.mode = 'idle'; sendBulk(list); }, close: () => resetBulk() },
        true,
      );
      return;
    }
    const d = res.data ?? {};
    const results = Array.isArray(d.results) ? d.results : [];
    list.forEach((it, i) => {
      const st = results[i]?.status;
      if (st === 'added' || st === 'existing') {
        tracked.add(it.id);
        paintId(it.id, 'ok');
      } else if (st === 'invalid') {
        paintId(it.id, 'err', results[i]?.error || 'Producto no válido');
      } else {
        paintId(it.id, 'idle');
      }
    });
    webBase = res.base || webBase;
    if (pageKey() !== key) return resetBulk();
    const count = (s) => results.filter((r) => r?.status === s).length;
    const added = d.added ?? count('added');
    const existing = d.existing ?? count('existing');
    const invalid = d.invalid ?? count('invalid');
    bulk.mode = 'summary';
    renderBulk(
      `<p role="status" aria-live="polite">Enviados ${list.length}: ${added} nuevos, ${existing} ya seguidos, ${invalid} no válidos. El servidor consultará sus precios en unos minutos; puedes cerrar la página.</p>
       <button class="secondary" data-act="close">Cerrar</button>`,
      { close: () => resetBulk() },
      true,
    );
  }

  let statusBlockedUntil = 0;

  async function scan() {
    await scanCards();
    updateBulk();
  }

  async function scanCards() {
    if (dead || document.hidden) return;
    for (const card of findCards()) addMini(card);
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
    fresh.forEach((id) => answered.add(id));
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
    if (dead) return;
    if (msg?.type === 'getProduct') sendResponse(readProduct());
    if (msg?.type === 'getBulkCount') sendResponse(host?.isConnected ? 0 : bulkCandidates().length);
  });

  tick();
  timers.push(setInterval(tick, 1500));
})();
