const input = document.getElementById('api');
const status = document.getElementById('status');

chrome.storage.sync.get('apiUrl').then(({ apiUrl }) => {
  input.value = apiUrl || 'http://localhost:3000';
});

document.getElementById('save').addEventListener('click', async () => {
  const url = input.value.trim().replace(/\/+$/, '');
  try {
    new URL(url);
  } catch {
    status.textContent = 'URL no válida';
    return;
  }
  await chrome.storage.sync.set({ apiUrl: url });
  try {
    const res = await fetch(`${url}/api/health`);
    status.textContent = res.ok ? '✓ Guardado y servidor accesible' : `Guardado, pero el servidor respondió ${res.status}`;
  } catch {
    status.textContent = 'Guardado, pero no se pudo conectar con el servidor.';
  }
});
