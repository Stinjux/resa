import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { login, logout, registerCustomer } from '../../modules/auth/service.js';
import { getBooking } from '../../modules/booking/service.js';
import { DomainError } from '../../shared/errors.js';
import type { AppDeps } from '../server.js';

declare module 'fastify' {
  interface FastifyInstance {
    loginRateLimit: number;
  }
}

export function authRoutes(app: FastifyInstance, deps: AppDeps) {
  // Protection contre les essais de mots de passe en série.
  const strict = { config: { rateLimit: { max: app.loginRateLimit, timeWindow: '1 minute' } } };

  app.post('/api/auth/login', strict, async (req) => {
    const body = z
      .object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200), organizationCode: z.string().optional() })
      .parse(req.body);
    const { token, expiresAt, principal } = await login(deps.db, body, deps.now());
    return { token, expiresAt, user: principal };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.authToken) await logout(deps.db, req.authToken);
    return reply.status(204).send();
  });

  app.post('/api/auth/register', strict, async (req, reply) => {
    const body = z
      .object({
        organizationCode: z.string().optional(),
        clubId: z.uuid().optional(), // inscription depuis la page d'un golf
        email: z.email(),
        password: z.string().min(8).max(200),
        firstName: z.string().max(120).nullable().optional(),
        lastName: z.string().min(1).max(120),
        phone: z.string().max(40).nullable().optional(),
      })
      .parse(req.body);
    const org = body.clubId
      ? await deps.db.query('SELECT organization_id AS id FROM clubs WHERE id = $1 AND active', [body.clubId])
      : await deps.db.query('SELECT id FROM organizations WHERE code = $1', [body.organizationCode ?? '']);
    if (!org.rows[0]) throw new DomainError('NOT_FOUND', 'Organisation introuvable.');
    await registerCustomer(deps.db, { ...body, organizationId: org.rows[0].id });
    const session = await login(deps.db, { email: body.email, password: body.password }, deps.now());
    return reply.status(201).send({ token: session.token, expiresAt: session.expiresAt, user: session.principal });
  });

  app.get('/api/me', async (req) => {
    if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
    return { user: req.principal };
  });

  app.get('/api/me/bookings', async (req) => {
    const customerId = req.principal?.customerId;
    if (!customerId) throw new DomainError('UNAUTHENTICATED', 'Compte client requis.');
    const { rows } = await deps.db.query(
      `SELECT b.id FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id
        WHERE b.customer_id = $1 ORDER BY t.starts_at DESC LIMIT 100`,
      [customerId],
    );
    return { bookings: await Promise.all(rows.map((r) => getBooking(deps.db, r.id))) };
  });
}
