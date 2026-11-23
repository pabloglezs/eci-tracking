const env = process.env;
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());
const port = Number(env.PORT) || 3000;

export const config = {
  port,
  host: env.HOST || '0.0.0.0',
  dbPath: env.DB_PATH || './data/eci.db',
  // URL pública del tracker; se usa en los enlaces de los emails.
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  timezone: env.TZ || 'Europe/Madrid',
  // Cron de la comprobación diaria (zona horaria = TZ).
  checkCron: env.CHECK_CRON || '0 7 * * *',
  checkOnStart: bool(env.CHECK_ON_START),
  // Pausa aleatoria entre peticiones a ECI, para no ir a ráfagas.
  requestDelayMs: [Number(env.REQUEST_DELAY_MIN_MS) || 2000, Number(env.REQUEST_DELAY_MAX_MS) || 6000],
  trustProxy: bool(env.TRUST_PROXY),
  adminToken: env.ADMIN_TOKEN || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    secure: bool(env.SMTP_SECURE),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
  },
  mailFrom: env.MAIL_FROM || 'ECI Tracker <no-reply@localhost>',
  // Sin SMTP, los emails se quedan en cola; con MAIL_DRY_RUN se escriben en el log.
  mailDryRun: bool(env.MAIL_DRY_RUN),
  mailDelayMs: Number(env.MAIL_DELAY_MS) || 1000,
  // --- Robustez del scraper ---
  scrapeRetries: env.SCRAPE_RETRIES === undefined ? 2 : Math.max(0, Number(env.SCRAPE_RETRIES) || 0),
  scrapeBackoffMs: Number(env.SCRAPE_BACKOFF_MS) || 3000,
  // 404/410 en tantos días de comprobación distintos => producto descatalogado ('gone').
  goneAfter: Number(env.GONE_AFTER) || 3,
  // Cada cuántos días se sondea un producto 'gone' por si vuelve (0 = nunca).
  goneRecheckDays: env.GONE_RECHECK_DAYS === undefined ? 7 : Number(env.GONE_RECHECK_DAYS) || 0,
  // Aviso al admin si una pasada diaria falla en >= ese % (o 0 éxitos), con al menos N intentos.
  adminEmail: env.ADMIN_EMAIL || '',
  adminAlertFailPct: Number(env.ADMIN_ALERT_FAIL_PCT) || 50,
  adminAlertMinSample: Number(env.ADMIN_ALERT_MIN_SAMPLE) || 3,
};
