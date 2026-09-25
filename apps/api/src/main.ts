import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildServer } from './http/server.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = buildServer({ db, now: () => new Date() }, { logger: true });

app.listen({ host: config.host, port: config.port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
