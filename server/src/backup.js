import { mkdirSync, readdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import cron from 'node-cron';
import { config } from './config.js';

const PREFIX = 'eci-';
const SUFFIX = '.db';
const NAME_RE = /^eci-\d{8}-\d{6}\.db$/;

const pad = (n) => String(n).padStart(2, '0');
export function backupName(d = new Date()) {
  return `${PREFIX}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${SUFFIX}`;
}

/**
 * Copia consistente de la BD con VACUUM INTO (seguro con la BD en uso y WAL).
 * Escribe a un .tmp y renombra al terminar, para no dejar copias a medias.
 * Devuelve la ruta del backup. Aplica la retención (`keep` copias más recientes).
 */
export function backupDb(db, { dir = config.backupDir, keep = config.backupKeep, now = new Date() } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, backupName(now));
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  db.prepare('VACUUM INTO ?').run(tmp);
  renameSync(tmp, file);
  pruneBackups(dir, keep);
  return file;
}

export function listBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => NAME_RE.test(f)).sort();
}

export function pruneBackups(dir, keep) {
  const files = listBackups(dir);
  const old = files.slice(0, Math.max(0, files.length - Math.max(1, keep)));
  for (const f of old) rmSync(join(dir, f), { force: true });
  return old;
}

/** Programa el backup periódico. Con BACKUP_CRON=off queda desactivado. */
export function startBackups(db) {
  if (!config.backupCron || config.backupCron === 'off') return null;
  if (!cron.validate(config.backupCron)) {
    console.error(`[backup] BACKUP_CRON no válido: "${config.backupCron}"; backups desactivados`);
    return null;
  }
  return cron.schedule(
    config.backupCron,
    () => {
      try {
        console.log('[backup] ok', backupDb(db));
      } catch (e) {
        console.error('[backup] error', e);
      }
    },
    { timezone: config.timezone },
  );
}
