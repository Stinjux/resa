import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/pool.js';
import { registerAuth } from './auth.js';
import { errorHandler } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { staffRoutes } from './routes/staff.js';
import { bookingRoutes } from './routes/bookings.js';
import { catalogRoutes } from './routes/catalog.js';
import { teeSheetRoutes } from './routes/teesheet.js';

export interface AppDeps {
  db: Db;
  now: () => Date;
}

export function buildServer(deps: AppDeps, opts: { logger?: boolean } = {}): FastifyInstance {
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
  return app;
}
