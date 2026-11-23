import { $, esc, eur, fmtDay, api } from './common.js';

const id = decodeURIComponent(location.pathname.split('/').pop());
const root = $('#root');
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let chart;
let data;
let range = 90;

function draw() {
  const { history, stats } = data;
  let rows = history;
  if (range !== 0) {
    const cut = new Date(Date.now() - range * 864e5).toISOString().slice(0, 10);
    rows = history.filter((r) => r.day >= cut);
    if (!rows.length) rows = history.slice(-1); // siempre al menos el último precio
  }
  const flat = (v) => rows.map(() => v);
  const line = (label, v, color) => ({
    label, data: flat(v), borderColor: color, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false,
  });
  chart?.destroy();
  chart = new Chart($('#chart'), {
    type: 'line',
    data: {
      labels: rows.map((r) => fmtDay(r.day)),
      datasets: [
        {
          label: 'Precio', data: rows.map((r) => r.price), borderColor: css('--accent'),
          backgroundColor: css('--accent'), borderWidth: 2.5, stepped: true,
          pointRadius: rows.length > 45 ? 0 : 3, pointHoverRadius: 5, fill: false,
        },
        line('Máximo', stats.max.price, css('--bad')),
        line('Medio', stats.avg, css('--muted')),
        line('Mínimo', stats.min.price, css('--good')),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: css('--text'), usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${eur(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: css('--muted'), maxTicksLimit: 8 }, grid: { color: css('--border') } },
        y: { ticks: { color: css('--muted'), callback: (v) => eur(v) }, grid: { color: css('--border') } },
      },
    },
  });
}

function render() {
  const { product: p, stats: s, deal, subscribers } = data;
  document.title = `${p.name || p.id} · ECI Tracker`;
  const img = p.image ? `<img src="${esc(p.image)}" alt="" referrerpolicy="no-referrer">` : '';
  const dealTxt = deal.isDeal
    ? `<span class="down">▼ ${eur(deal.previousPrice)} → ${eur(s.current)} (-${Math.round(deal.dropPct)}%)</span> desde ${fmtDay(deal.dropDay)}`
    : '';
  const atMin = s && s.count > 1 && s.current <= s.min.price ? ' · <b class="down">¡en su mínimo histórico!</b>' : '';

  if (!s) {
    root.innerHTML = `<div class="product-head">${img}<div class="info"><h1>${esc(p.name || p.id)}</h1>
      <p class="muted">Todavía no hay ningún precio registrado. ${p.lastError ? `Último error: ${esc(p.lastError)}` : 'Se consultará en breve.'}</p>
      <p><a href="${esc(p.url)}" target="_blank" rel="noopener">Ver en El Corte Inglés ↗</a></p></div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="product-head">${img}
      <div class="info">
        <h1 style="margin-bottom:6px">${esc(p.name || p.id)}</h1>
        <div class="price" style="font-size:28px">${eur(s.current)}</div>
        <div>${dealTxt}${atMin}</div>
        <p class="muted" style="margin:8px 0 0">${s.count} día(s) de histórico desde ${fmtDay(s.firstDay)} ·
          <a href="${esc(p.url)}" target="_blank" rel="noopener">Ver en El Corte Inglés ↗</a></p>
      </div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="label">Actual</div><div class="value">${eur(s.current)}</div><div class="sub">${fmtDay(s.currentDay)}</div></div>
      <div class="tile"><div class="label">Mínimo</div><div class="value" style="color:var(--good)">${eur(s.min.price)}</div><div class="sub">${fmtDay(s.min.day)}</div></div>
      <div class="tile"><div class="label">Máximo</div><div class="value" style="color:var(--bad)">${eur(s.max.price)}</div><div class="sub">${fmtDay(s.max.day)}</div></div>
      <div class="tile"><div class="label">Medio</div><div class="value">${eur(s.avg)}</div><div class="sub">media de ${s.count} día(s)</div></div>
    </div>
    <div class="panel">
      <div class="ranges" role="group" aria-label="Rango">
        ${[[30, '1 mes'], [90, '3 meses'], [365, '1 año'], [0, 'Todo']]
          .map(([d, l]) => `<button data-range="${d}" aria-pressed="${d === range}">${l}</button>`)
          .join('')}
      </div>
      <div class="chart-box"><canvas id="chart"></canvas></div>
    </div>
    <h2>🔔 Avísame si baja de precio</h2>
    <div class="panel">
      <form class="sub" id="sub">
        <input type="email" name="email" placeholder="tu@email.com" required autocomplete="email" aria-label="Email">
        <button class="primary">Activar alerta</button>
      </form>
      <div class="msg" id="msg"></div>
      <p class="muted" style="margin:8px 0 0;font-size:13px">${subscribers} persona(s) siguen este producto. Cada email incluye un enlace para darte de baja.</p>
    </div>`;

  draw();
  root.querySelectorAll('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      range = Number(b.dataset.range);
      root.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      draw();
    }),
  );
  $('#sub').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#msg');
    msg.className = 'msg';
    try {
      const r = await api(`/api/products/${encodeURIComponent(id)}/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: new FormData(e.target).get('email') }),
      });
      msg.className = 'msg ok';
      msg.textContent = r.created ? '¡Listo! Te avisaremos por email.' : 'Ya estabas apuntado a este producto.';
      e.target.reset();
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = err.message;
    }
  });
}

api(`/api/products/${encodeURIComponent(id)}`)
  .then((d) => {
    data = d;
    render();
  })
  .catch((e) => (root.innerHTML = `<div class="empty">${esc(e.message)} · <a href="/">Volver</a></div>`));
