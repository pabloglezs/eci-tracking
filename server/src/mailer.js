import nodemailer from 'nodemailer';
import { config } from './config.js';

const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const unsubUrl = (token) => `${config.publicUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`;

function enqueue(db, { to, subject, text, html, unsub }) {
  db.prepare(
    'INSERT INTO email_queue (to_email, subject, text, html, unsub_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(to, subject, text, html, unsub, new Date().toISOString());
}

function layout(inner, unsub) {
  return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">${inner}
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="font-size:12px;color:#777">Recibes este email porque te apuntaste a las alertas de este producto en ECI Tracker.
<a href="${esc(unsub)}">Darme de baja</a></p></div>`;
}

/** Encola un email por cada suscriptor del producto cuando baja de precio. */
export function enqueueDropAlerts(db, product, oldPrice, newPrice) {
  const subs = db.prepare('SELECT email, token FROM subscriptions WHERE product_id = ?').all(product.id);
  const name = product.name || product.id;
  const pct = Math.round(((oldPrice - newPrice) / oldPrice) * 100);
  const page = `${config.publicUrl}/p/${encodeURIComponent(product.id)}`;
  for (const s of subs) {
    const unsub = unsubUrl(s.token);
    enqueue(db, {
      to: s.email,
      subject: `📉 ${name} baja a ${eur(newPrice)} (-${pct}%)`,
      text: `${name}\n\nHa bajado de ${eur(oldPrice)} a ${eur(newPrice)} (-${pct}%).\n\nHistorial: ${page}\nEn El Corte Inglés: ${product.url}\n\nDarte de baja: ${unsub}\n`,
      html: layout(
        `<h2 style="margin:0 0 8px">${esc(name)}</h2>
<p style="font-size:18px"><s style="color:#888">${eur(oldPrice)}</s> → <b style="color:#0a7d3b">${eur(newPrice)}</b> (-${pct}%)</p>
<p><a href="${esc(page)}">Ver historial de precios</a> · <a href="${esc(product.url)}">Ir a El Corte Inglés</a></p>`,
        unsub,
      ),
      unsub,
    });
  }
  return subs.length;
}

export function enqueueWelcome(db, product, email, token, currentPrice) {
  const name = product.name || product.id;
  const unsub = unsubUrl(token);
  const page = `${config.publicUrl}/p/${encodeURIComponent(product.id)}`;
  const now = currentPrice ? ` Precio actual: ${eur(currentPrice)}.` : '';
  enqueue(db, {
    to: email,
    subject: `Alertas activadas: ${name}`,
    text: `Te avisaremos cuando baje el precio de "${name}".${now}\n\n${page}\n\nDarte de baja: ${unsub}\n`,
    html: layout(
      `<h2 style="margin:0 0 8px">Alertas activadas</h2>
<p>Te avisaremos cuando baje el precio de <b>${esc(name)}</b>.${esc(now)}</p><p><a href="${esc(page)}">Ver historial</a></p>`,
      unsub,
    ),
    unsub,
  });
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
    headers: msg.unsub_url ? { 'List-Unsubscribe': `<${msg.unsub_url}>` } : undefined,
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
