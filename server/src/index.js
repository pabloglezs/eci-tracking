import cron from 'node-cron';
import { config } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { runDailyCheck, sweepUnpriced } from './checker.js';
import { startMailWorker } from './mailer.js';
import { startBackups } from './backup.js';

const db = openDb(config.dbPath);
const app = await buildApp({ db, logger: true });

cron.schedule(config.checkCron, () => runDailyCheck(db).catch((e) => console.error('[check]', e)), {
  timezone: config.timezone,
});
startMailWorker(db);
startBackups(db);

const swept = sweepUnpriced(db);
if (swept) console.log(`[check] ${swept} producto(s) sin precio en cola tras el arranque`);
if (config.checkOnStart) runDailyCheck(db).catch((e) => console.error('[check]', e));

await app.listen({ port: config.port, host: config.host });
app.log.info(`Comprobación diaria: "${config.checkCron}" (${config.timezone}) · ${config.publicUrl}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
