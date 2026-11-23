const DEFAULT_API = 'http://localhost:3000';

async function getApi() {
  const { apiUrl } = await chrome.storage.sync.get('apiUrl');
  return (apiUrl || DEFAULT_API).replace(/\/+$/, '');
}

async function track(payload) {
  const api = await getApi();
  try {
    const res = await fetch(`${api}/api/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `Error ${res.status}` };
    return { ok: true, created: data.created, webUrl: `${api}/p/${encodeURIComponent(data.product.id)}` };
  } catch {
    return { ok: false, error: `No se pudo conectar con ${api}. Revisa la URL en las opciones de la extensión.` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'track') {
    track(msg.payload).then(sendResponse);
    return true; // respuesta asíncrona
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
