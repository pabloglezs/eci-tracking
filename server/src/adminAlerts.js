// Aviso por email al admin cuando la pasada diaria va mal. Inserta directamente en
// email_queue (el worker de mailer.js lo envía); como máximo un aviso al día.
import { config } from './config.js';
import { today } from './db.js';

const SUBJECT_PREFIX = '[ECI Tracker] Alerta:';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** ¿Es preocupante esta pasada? Devuelve el motivo o null. */
export function runProblem({ ok, failed }, { failPct = config.adminAlertFailPct, minSample = config.adminAlertMinSample } = {}) {
  const attempted = ok + failed;
  if (attempted < minSample) return null;
  if (ok === 0) return `0 éxitos en ${attempted} comprobaciones`;
  const pct = (failed / attempted) * 100;
  if (pct >= failPct) return `${failed} de ${attempted} comprobaciones han fallado (${Math.round(pct)}%)`;
  return null;
}

/** Encola el aviso si procede y no se ha enviado ya hoy. Devuelve true si lo encola. */
export function maybeAlertAdmin(db, stats, { tz = config.timezone, adminEmail = config.adminEmail, now = new Date(), ...limits } = {}) {
  if (!adminEmail) return false;
  const reason = runProblem(stats, limits);
  if (!reason) return false;

  const day = today(tz, now);
  const recent = db
    .prepare('SELECT created_at FROM email_queue WHERE to_email = ? AND subject LIKE ? ORDER BY id DESC LIMIT 5')
    .all(adminEmail, `${SUBJECT_PREFIX}%`);
  if (recent.some((r) => today(tz, new Date(r.created_at)) === day)) return false;

  const lastErrors = db
    .prepare(
      `SELECT id, last_error FROM products WHERE last_error IS NOT NULL AND status != 'gone'
       ORDER BY last_checked_at DESC LIMIT 5`,
    )
    .all();
  const lines = lastErrors.map((p) => `- ${p.id}: ${p.last_error}`);
  const text =
    `La comprobación diaria ha ido mal: ${reason}.\n\nÚltimos errores:\n${lines.join('\n') || '(sin detalle)'}\n\n` +
    `Puede que ECI haya cambiado la página o esté bloqueando las peticiones.\nEstadísticas: ${config.publicUrl}/api/admin/stats (cabecera x-admin-token)\n`;
  const html =
    `<p>La comprobación diaria ha ido mal: <b>${esc(reason)}</b>.</p><p>Últimos errores:</p><ul>` +
    lastErrors.map((p) => `<li>${esc(p.id)}: ${esc(p.last_error)}</li>`).join('') +
    `</ul><p>Puede que ECI haya cambiado la página o esté bloqueando las peticiones.</p>`;
  db.prepare('INSERT INTO email_queue (to_email, subject, text, html, unsub_url, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    adminEmail,
    `${SUBJECT_PREFIX} ${reason}`,
    text,
    html,
    null,
    now.toISOString(),
  );
  return true;
}
