import { existsSync } from 'node:fs';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/pool.js';
import { createPosRegistry, type PosRegistry } from '../integrations/pos/registry.js';
import type { AiModel } from '../modules/ai/model.js';
import { registerAuth } from './auth.js';
import { errorHandler } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { aiRoutes } from './routes/ai.js';
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
  /** Modèle d'IA ; null si aucune clé n'est configurée. */
  ai: AiModel | null;
}

/** webRoot : dossier de l'interface compilée (apps/web/dist), servie sur « / ». */
export interface ServerOptions {
  logger?: boolean;
  webRoot?: string;
  /** Derrière un proxy (Caddy, Nginx) : lire l'IP réelle dans X-Forwarded-For. */
  trustProxy?: boolean;
  /** Tentatives de connexion / inscription par minute et par IP. */
  loginRateLimit?: number;
}

export function buildServer(input: Omit<AppDeps, 'posRegistry' | 'ai'> & { posRegistry?: PosRegistry; ai?: AiModel | null }, opts: ServerOptions = {}): FastifyInstance {
  const deps: AppDeps = { ...input, posRegistry: input.posRegistry ?? createPosRegistry(), ai: input.ai ?? null };
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });
  // En-têtes de sécurité (CSP : tout est servi par nos soins ; styles en ligne de React autorisés).
  app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"],
        // Forcer le HTTPS seulement derrière le proxy HTTPS de production (sinon http://localhost casserait).
        upgradeInsecureRequests: opts.trustProxy ? [] : null,
      },
    },
  });
  // Limite générale par IP, plus stricte sur la connexion et l'inscription (voir routes/auth.ts).
  app.register(fastifyRateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  app.decorate('loginRateLimit', opts.loginRateLimit ?? Number(process.env.LOGIN_RATE_LIMIT ?? 10));
  app.setErrorHandler(errorHandler);
  // Routes enregistrées APRÈS les extensions (sécurité, limitation) pour qu'elles s'y appliquent.
  app.register(async (api) => {
    registerAuth(api, deps);
    api.get('/health', async () => {
      await deps.db.query('SELECT 1');
      return { ok: true };
    });
    catalogRoutes(api, deps);
    teeSheetRoutes(api, deps);
    bookingRoutes(api, deps);
    authRoutes(api, deps);
    staffRoutes(api, deps);
    configRoutes(api, deps);
    orderRoutes(api, deps);
    aiRoutes(api, deps);
  });

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
