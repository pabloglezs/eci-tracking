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
  // Alertas: caducidad de suscripciones sin confirmar y purga de email_queue.
  confirmMaxPerEmailDay: Number(env.CONFIRM_MAX_PER_EMAIL_DAY) || 5,
  confirmTtlDays: Number(env.CONFIRM_TTL_DAYS) || 7,
  queueSentRetentionDays: Number(env.QUEUE_SENT_RETENTION_DAYS) || 30,
  queueFailedRetentionDays: Number(env.QUEUE_FAILED_RETENTION_DAYS) || 60,
};
