import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/pool.js';
import { createPosRegistry, type PosRegistry } from '../integrations/pos/registry.js';
import { registerAuth } from './auth.js';
import { errorHandler } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { orderRoutes } from './routes/orders.js';
import { staffRoutes } from './routes/staff.js';
import { bookingRoutes } from './routes/bookings.js';
import { catalogRoutes } from './routes/catalog.js';
import { teeSheetRoutes } from './routes/teesheet.js';

export interface AppDeps {
  db: Db;
  now: () => Date;
  posRegistry: PosRegistry;
}

/** webRoot : dossier de l'interface compilée (apps/web/dist), servie sur « / ». */
export function buildServer(input: Omit<AppDeps, 'posRegistry'> & { posRegistry?: PosRegistry }, opts: { logger?: boolean; webRoot?: string } = {}): FastifyInstance {
  const deps: AppDeps = { ...input, posRegistry: input.posRegistry ?? createPosRegistry() };
  const app = Fastify({ logger: opts.logger ?? false });
  app.setErrorHandler(errorHandler);
  registerAuth(app, deps);
  app.get('/health', async () => {
    await deps.db.query('SELECT 1');
    return { ok: true };
  });
  catalogRoutes(app, deps);
  teeSheetRoutes(app, deps);
  bookingRoutes(app, deps);
  authRoutes(app, deps);
  staffRoutes(app, deps);
  configRoutes(app, deps);
  orderRoutes(app, deps);

  if (opts.webRoot && existsSync(opts.webRoot)) {
    app.register(fastifyStatic, { root: opts.webRoot });
    // Application monopage : toute route hors /api renvoie index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route inconnue.' } });
    });
  }
  return app;
}
