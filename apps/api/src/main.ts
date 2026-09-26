import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildServer } from './http/server.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const webRoot = process.env.WEB_ROOT ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const app = buildServer({ db, now: () => new Date() }, { logger: true, webRoot });

app.listen({ host: config.host, port: config.port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
