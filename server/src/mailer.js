import nodemailer from 'nodemailer';
import { config } from './config.js';
import { getUnsubAllToken, purgePendingSubscriptions } from './store.js';

const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const unsubUrl = (token) => `${config.publicUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`;
export const unsubAllUrl = (token) => `${config.publicUrl}/api/unsubscribe-all?token=${encodeURIComponent(token)}`;
export const confirmUrl = (token) => `${config.publicUrl}/api/confirm?token=${encodeURIComponent(token)}`;

function enqueue(db, { to, subject, text, html, unsub }) {
  db.prepare(
    'INSERT INTO email_queue (to_email, subject, text, html, unsub_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(to, subject, text, html, unsub ?? null, new Date().toISOString());
}

function layout(inner, links) {
  const parts = [];
  if (links?.unsub) parts.push(`<a href="${esc(links.unsub)}">Darme de baja de este producto</a>`);
  if (links?.unsubAll) parts.push(`<a href="${esc(links.unsubAll)}">Darme de baja de todo</a>`);
  const foot = links
    ? `Recibes este email porque te apuntaste a las alertas de este producto en ECI Tracker.<br>${parts.join(' · ')}`
    : 'Si no has sido tú, ignora este email: no se activará nada.';
  return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">${inner}
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="font-size:12px;color:#777">${foot}</p></div>`;
}

const footText = (l) => `\nDarte de baja de este producto: ${l.unsub}\nDarte de baja de todo: ${l.unsubAll}\n`;
const linksFor = (db, email, token) => ({ unsub: unsubUrl(token), unsubAll: unsubAllUrl(getUnsubAllToken(db, email)) });

/**
 * Encola avisos para los suscriptores CONFIRMADOS tras registrar un precio.
 * - Sin precio objetivo: aviso si ha bajado respecto al día anterior (`r.dropped`).
 * - Con precio objetivo: aviso una vez al cruzarlo (precio <= objetivo); se rearma
 *   cuando el precio vuelve a estar por encima.
 * `r` = resultado de recordPrice ({ previous, price, dropped }). Devuelve nº de emails.
 */
export function enqueueAlerts(db, product, r) {
  const subs = db
    .prepare('SELECT id, email, token, target_price, alerted FROM subscriptions WHERE product_id = ? AND confirmed_at IS NOT NULL')
    .all(product.id);
  const name = product.name || product.id;
  const page = `${config.publicUrl}/p/${encodeURIComponent(product.id)}`;
  let n = 0;
  for (const s of subs) {
    let kind = null;
    if (s.target_price == null) {
      if (r.dropped) kind = 'drop';
    } else if (r.price <= s.target_price + 0.0001) {
      if (!s.alerted) {
        kind = 'target';
        db.prepare('UPDATE subscriptions SET alerted = 1 WHERE id = ?').run(s.id);
      }
    } else if (s.alerted) {
      db.prepare('UPDATE subscriptions SET alerted = 0 WHERE id = ?').run(s.id);
    }
    if (!kind) continue;
    const l = linksFor(db, s.email, s.token);
    let subject, text, body;
    if (kind === 'drop') {
      const pct = Math.round(((r.previous - r.price) / r.previous) * 100);
      subject = `📉 ${name} baja a ${eur(r.price)} (-${pct}%)`;
      text = `${name}\n\nHa bajado de ${eur(r.previous)} a ${eur(r.price)} (-${pct}%).`;
      body = `<h2 style="margin:0 0 8px">${esc(name)}</h2>
<p style="font-size:18px"><s style="color:#888">${eur(r.previous)}</s> → <b style="color:#0a7d3b">${eur(r.price)}</b> (-${pct}%)</p>`;
    } else {
      subject = `🎯 ${name} ya está a ${eur(r.price)} (tu objetivo: ${eur(s.target_price)})`;
      text = `${name}\n\nHa llegado a tu precio objetivo: ahora cuesta ${eur(r.price)} (objetivo: ${eur(s.target_price)}).`;
      body = `<h2 style="margin:0 0 8px">${esc(name)}</h2>
<p style="font-size:18px">Ya cuesta <b style="color:#0a7d3b">${eur(r.price)}</b> <span style="color:#777">(tu objetivo: ${eur(s.target_price)})</span></p>`;
    }
    enqueue(db, {
      to: s.email,
      subject,
      text: `${text}\n\nHistorial: ${page}\nEn El Corte Inglés: ${product.url}\n${footText(l)}`,
      html: layout(`${body}<p><a href="${esc(page)}">Ver historial de precios</a> · <a href="${esc(product.url)}">Ir a El Corte Inglés</a></p>`, l),
      unsub: l.unsub,
    });
    n++;
  }
  return n;
}

/** Compatibilidad: aviso de bajada simple (sin precios objetivo). */
export const enqueueDropAlerts = (db, product, oldPrice, newPrice) =>
  enqueueAlerts(db, product, { previous: oldPrice, price: newPrice, dropped: true });

/** Email de doble opt-in: la alerta no se activa hasta pulsar el enlace. */
export function enqueueConfirmation(db, product, email, confirmToken, targetPrice) {
  // Tope por dirección en ventana móvil de 24 h (todos los productos); pasado el tope no se encola.
  const since = new Date(Date.now() - 864e5).toISOString();
  const sentToday = db
    .prepare(`SELECT COUNT(*) AS n FROM email_queue WHERE to_email = ? AND subject LIKE 'Confirma tu alerta:%' AND created_at > ?`)
    .get(email, since).n;
  if (sentToday >= config.confirmMaxPerEmailDay) return false;
  const name = product.name || product.id;
  const url = confirmUrl(confirmToken);
  const goal = targetPrice != null ? ` Te avisaremos cuando baje a ${eur(targetPrice)} o menos.` : ' Te avisaremos cuando baje de precio.';
  enqueue(db, {
    to: email,
    subject: `Confirma tu alerta: ${name}`,
    text: `Alguien (esperamos que tú) ha pedido recibir alertas de precio de "${name}" en ECI Tracker.${goal}\n\nPara activarla, confirma tu email:\n${url}\n\nEl enlace caduca en ${config.confirmTtlDays} días. Si no has sido tú, ignora este email.\n`,
    html: layout(
      `<h2 style="margin:0 0 8px">Confirma tu alerta</h2>
<p>Has pedido recibir alertas de precio de <b>${esc(name)}</b>.${esc(goal)}</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#0a7d3b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Confirmar mi email</a></p>
<p style="font-size:13px;color:#555">El enlace caduca en ${config.confirmTtlDays} días.</p>`,
      null,
    ),
  });
  return true;
}

/** Aviso tras confirmar (la alerta ya está activa). */
export function enqueueWelcome(db, product, email, token, currentPrice, targetPrice = null) {
  const name = product.name || product.id;
  const l = linksFor(db, email, token);
  const page = `${config.publicUrl}/p/${encodeURIComponent(product.id)}`;
  const now = currentPrice ? ` Precio actual: ${eur(currentPrice)}.` : '';
  const goal = targetPrice != null ? ` cuando llegue a ${eur(targetPrice)} o menos` : ' cuando baje el precio';
  enqueue(db, {
    to: email,
    subject: `Alertas activadas: ${name}`,
    text: `Te avisaremos${goal} de "${name}".${now}\n\n${page}\n${footText(l)}`,
    html: layout(
      `<h2 style="margin:0 0 8px">Alertas activadas</h2>
<p>Te avisaremos${esc(goal)} de <b>${esc(name)}</b>.${esc(now)}</p><p><a href="${esc(page)}">Ver historial</a></p>`,
      l,
    ),
    unsub: l.unsub,
  });
}

/** Purga de la cola: enviados y fallidos antiguos. */
export function purgeEmailQueue(
  db,
  { sentDays = config.queueSentRetentionDays, failedDays = config.queueFailedRetentionDays, now = new Date() } = {},
) {
  const cut = (d) => new Date(now - d * 864e5).toISOString();
  const sent = db.prepare(`DELETE FROM email_queue WHERE status = 'sent' AND sent_at < ?`).run(cut(sentDays)).changes;
  const failed = db.prepare(`DELETE FROM email_queue WHERE status = 'failed' AND created_at < ?`).run(cut(failedDays)).changes;
  return { sent, failed };
}

/** Mantenimiento periódico: caduca suscripciones pendientes y purga la cola. */
export function runMaintenance(db) {
  const expired = purgePendingSubscriptions(db, config.confirmTtlDays);
  const q = purgeEmailQueue(db);
  if (expired || q.sent || q.failed) {
    console.log(`[maint] suscripciones sin confirmar caducadas: ${expired}; cola purgada: ${q.sent} enviados, ${q.failed} fallidos`);
  }
}

let transport;
function getTransport() {
  if (!config.smtp.host) return null;
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transport;
}

async function defaultSend(msg) {
  const t = getTransport();
  if (!t) {
    console.log(`[mail:dry-run] to=${msg.to_email} subject="${msg.subject}"`);
    return;
  }
  await t.sendMail({
    from: config.mailFrom,
    to: msg.to_email,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    headers: msg.unsub_url
      ? { 'List-Unsubscribe': `<${msg.unsub_url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      : undefined,
  });
}

const MAX_ATTEMPTS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Envía hasta `batch` emails pendientes, con pausa entre cada uno. */
export async function processQueue(db, { send = defaultSend, batch = 20, delayMs = config.mailDelayMs } = {}) {
  if (!config.smtp.host && !config.mailDryRun && send === defaultSend) return { sent: 0, failed: 0, skipped: true };
  const pending = db
    .prepare(`SELECT * FROM email_queue WHERE status = 'pending' ORDER BY id LIMIT ?`)
    .all(batch);
  let sent = 0;
  let failed = 0;
  for (const msg of pending) {
    try {
      await send(msg);
      db.prepare(`UPDATE email_queue SET status = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?`).run(
        new Date().toISOString(),
        msg.id,
      );
      sent++;
    } catch (e) {
      const status = msg.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending';
      db.prepare('UPDATE email_queue SET status = ?, attempts = attempts + 1, error = ? WHERE id = ?').run(
        status,
        String(e.message).slice(0, 500),
        msg.id,
      );
      failed++;
    }
    if (delayMs) await sleep(delayMs);
  }
  return { sent, failed, skipped: false };
}

export function startMailWorker(db) {
  if (!config.smtp.host && !config.mailDryRun) {
    console.warn('[mail] SMTP_HOST no configurado: los emails quedarán en cola (usa MAIL_DRY_RUN=1 para verlos en el log).');
  }
  let busy = false;
  const safeMaint = () => {
    try { runMaintenance(db); } catch (e) { console.error('[maint]', e); }
  };
  safeMaint();
  setInterval(safeMaint, 6 * 3600_000).unref();
  return setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await processQueue(db);
    } catch (e) {
      console.error('[mail] error en la cola:', e);
    } finally {
      busy = false;
    }
  }, 30_000);
}
