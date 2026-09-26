import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool, type Db } from './db/pool.js';
import { seedDemo } from './db/seed.js';
import { buildServer } from './http/server.js';
import { createPosRegistry } from './integrations/pos/registry.js';
import { processPosJobs } from './modules/pos-sync/service.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);

/** La base peut démarrer après l'application (Docker) : on patiente. */
async function waitForDatabase(pool: Db, attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

await waitForDatabase(db);
// AUTO_MIGRATE=1 : applique les migrations au démarrage.
if (process.env.AUTO_MIGRATE === '1') {
  const applied = await migrate(db);
  if (applied.length) console.log(`Migrations appliquées : ${applied.join(', ')}`);
}
// SEED_DEMO=1 : charge la démo si elle est absente (jamais en production).
if (process.env.SEED_DEMO === '1' && process.env.NODE_ENV !== 'production') {
  if (await seedDemo(db)) console.log('Données de démonstration chargées (mot de passe des comptes : Demo2026!).');
}

const webRoot = process.env.WEB_ROOT ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const posRegistry = createPosRegistry();
const app = buildServer({ db, now: () => new Date(), posRegistry }, { logger: true, webRoot });

// Synchronisation POS en arrière-plan (désactivable : POS_WORKER=0).
if (process.env.POS_WORKER !== '0') {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await processPosJobs(db, posRegistry);
      if (r.processed) app.log.info({ pos: r }, 'Synchronisation POS');
    } catch (err) {
      app.log.error(err, 'Synchronisation POS');
    } finally {
      running = false;
    }
  }, Number(process.env.POS_WORKER_INTERVAL_MS ?? 30_000)).unref();
}

app.listen({ host: config.host, port: config.port }).then(() => {
  console.log(`\n  ⛳ Resa Golf prêt : http://localhost:${config.port}\n`);
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
