// Firefox expone `browser` (promesas) y también `chrome`; Chrome MV3 sólo `chrome`, que ya devuelve promesas.
const ext = globalThis.browser ?? globalThis.chrome;
const DEFAULT_API = 'http://localhost:3000';
const TIMEOUT_MS = 8000;

// fetch con tiempo máximo: un servidor lento no debe dejar colgado el popup ni el botón.
async function fetchT(url, opts = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getApi() {
  const { apiUrl } = await ext.storage.sync.get('apiUrl');
  return (apiUrl || DEFAULT_API).replace(/\/+$/, '');
}

async function track(payload) {
  const api = await getApi();
  try {
    const res = await fetchT(`${api}/api/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    // `status` (HTTP) y `network` permiten al alta masiva distinguir 429, 400, 5xx y red caída.
    if (!res.ok) return { ok: false, status: res.status, error: data.error || `Error ${res.status}` };
    return { ok: true, created: data.created, base: api, webUrl: `${api}/p/${encodeURIComponent(data.product.id)}` };
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, network: true, error: `${api} tarda demasiado en responder. Inténtalo de nuevo.` };
    return { ok: false, network: true, error: `No se pudo conectar con ${api}. Revisa la URL en las opciones de la extensión.` };
  }
}

// Alta masiva: una sola petición con hasta 100 items (el servidor las procesa a su ritmo).
async function trackBulk(items) {
  const api = await getApi();
  try {
    const res = await fetchT(
      `${api}/api/products/bulk`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) },
      20000,
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: data.error || `Error ${res.status}` };
    return { ok: true, data, base: api };
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, network: true, error: `${api} tarda demasiado en responder.` };
    return { ok: false, network: true, error: `No se pudo conectar con ${api}. Revisa la URL en las opciones de la extensión.` };
  }
}

// Qué ids de una lista ya están en el tracker (para marcar las tarjetas de los listados).
async function status(ids) {
  const api = await getApi();
  try {
    const res = await fetchT(`${api}/api/tracked?ids=${ids.map(encodeURIComponent).join(',')}`);
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, tracked: data.tracked ?? [], base: api };
  } catch {
    return { ok: false };
  }
}

// Estado de un producto concreto: precio actual, mínimo, máximo. 404 = no se sigue todavía.
async function info(id) {
  const api = await getApi();
  if (!/^(?:A\d{6,}(?:-\d{6,})?|MP_\d+_[A-Z0-9]+)$/.test(String(id))) return { ok: false, error: 'Id de producto no válido' };
  try {
    const res = await fetchT(`${api}/api/products/${encodeURIComponent(id)}`);
    if (res.status === 404) return { ok: true, found: false, base: api };
    if (!res.ok) return { ok: false, error: `El servidor respondió ${res.status}`, base: api };
    const d = await res.json();
    return {
      ok: true,
      found: true,
      base: api,
      webUrl: `${api}/p/${encodeURIComponent(id)}`,
      stats: d.stats ?? null,
      lastError: d.product?.lastError ?? null,
    };
  } catch (e) {
    const slow = e?.name === 'AbortError';
    return { ok: false, base: api, error: slow ? 'El servidor tarda demasiado en responder' : `No se pudo conectar con ${api}` };
  }
}

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = { track: () => track(msg.payload), trackBulk: () => trackBulk(msg.items),status: () => status(msg.ids), info: () => info(msg.id) }[msg?.type];
  if (!handler) return;
  handler().then(sendResponse);
  return true; // respuesta asíncrona
});

ext.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') ext.runtime.openOptionsPage();
});
