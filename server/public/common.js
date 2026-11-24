export const $ = (s, el = document) => el.querySelector(s);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
export const eur = (n) => (n == null ? '—' : fmt.format(n));

export const fmtDay = (d) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

/** Sparkline SVG inline (sin librerías) a partir de una serie de precios. */
export function sparkline(series) {
  if (!series || series.length < 2) return '';
  const W = 100, H = 28, PAD = 3;
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => [
    (i / (series.length - 1)) * (W - 2 * PAD) + PAD,
    H - PAD - ((v - min) / span) * (H - 2 * PAD),
  ]);
  const first = series[0], last = series.at(-1);
  const cls = last < first ? 'down' : last > first ? 'up' : 'flat';
  const word = cls === 'down' ? 'bajada' : cls === 'up' ? 'subida' : 'sin cambios';
  const label = `Últimos ${series.length} días: de ${eur(first)} a ${eur(last)} (${word}); mínimo ${eur(min)}, máximo ${eur(max)}`;
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts.at(-1);
  return `<svg class="spark ${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">` +
    `<polyline points="${line}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2" fill="currentColor"/></svg>`;
}

/** Botón «Instalar extensión» de la cabecera + modal con las instrucciones (Chrome y Firefox). */
export function initInstall() {
  const header = $('header.top .wrap');
  if (!header) return;
  const origin = location.origin;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'install-btn';
  btn.textContent = '🧩 Instalar extensión';
  header.append(btn);

  const dlg = document.createElement('dialog');
  dlg.className = 'install-dlg';
  dlg.setAttribute('aria-labelledby', 'install-h');
  dlg.innerHTML = `
    <form method="dialog" class="install-head">
      <h2 id="install-h">Instalar la extensión</h2>
      <button class="install-x" aria-label="Cerrar">✕</button>
    </form>
    <p class="muted">La extensión añade el botón «Seguir precio» en elcorteingles.es. Elige tu navegador:</p>
    <div class="install-tabs" role="tablist">
      <button type="button" role="tab" id="tab-chrome" aria-controls="pane-chrome" aria-selected="true">Chrome · Edge · Brave</button>
      <button type="button" role="tab" id="tab-firefox" aria-controls="pane-firefox" aria-selected="false">Firefox</button>
    </div>
    <div role="tabpanel" id="pane-chrome" aria-labelledby="tab-chrome">
      <p><a class="dl" href="/downloads/eci-tracker-chrome.zip" download>⬇ Descargar eci-tracker-chrome.zip</a></p>
      <ol>
        <li><b>Descomprime</b> el .zip en una carpeta que no vayas a borrar.</li>
        <li>Abre <code>chrome://extensions</code> (en Edge <code>edge://extensions</code>) y activa el <b>Modo desarrollador</b>.</li>
        <li>Pulsa <b>Cargar descomprimida</b> y elige esa carpeta.</li>
        <li>Fija la extensión desde el icono de puzle 🧩 de la barra del navegador.</li>
      </ol>
    </div>
    <div role="tabpanel" id="pane-firefox" aria-labelledby="tab-firefox" hidden>
      <p><a class="dl" href="/downloads/eci-tracker-firefox.zip" download>⬇ Descargar eci-tracker-firefox.zip</a></p>
      <ol>
        <li>Abre <code>about:debugging#/runtime/this-firefox</code>.</li>
        <li>Pulsa <b>Cargar complemento temporal…</b> y elige el .zip descargado (no hace falta descomprimirlo).</li>
      </ol>
      <p class="muted small">Firefox solo permite complementos sin firmar de forma temporal: se quitan al cerrar el navegador y hay que repetir el paso.</p>
    </div>
    <hr>
    <p><b>Después, configura el servidor.</b> En las opciones de la extensión (clic derecho en su icono → <i>Opciones</i>) pon esta URL:</p>
    <div class="install-url"><input id="install-url" readonly value="${esc(origin)}" aria-label="URL del servidor"><button type="button" id="install-copy">Copiar</button></div>`;
  document.body.append(dlg);

  const tabs = [...dlg.querySelectorAll('[role=tab]')];
  const pick = (t) =>
    tabs.forEach((x) => {
      const on = x === t;
      x.setAttribute('aria-selected', String(on));
      $('#' + x.getAttribute('aria-controls'), dlg).hidden = !on;
    });
  tabs.forEach((t) => t.addEventListener('click', () => pick(t)));
  if (/firefox/i.test(navigator.userAgent)) pick(tabs[1]);

  $('#install-copy', dlg).addEventListener('click', async (e) => {
    const input = $('#install-url', dlg);
    try {
      await navigator.clipboard.writeText(input.value);
      e.target.textContent = '¡Copiada!';
    } catch {
      input.select();
    }
    setTimeout(() => (e.target.textContent = 'Copiar'), 1500);
  });
  btn.addEventListener('click', () => dlg.showModal());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // clic en el fondo
}
