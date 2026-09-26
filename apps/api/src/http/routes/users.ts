import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { changeOwnPassword, createStaff, listStaff, MIN_PASSWORD, resetStaffPassword, updateStaff } from '../../modules/users/service.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const idParam = z.object({ id: z.uuid() });
const roles = z.array(z.object({
  clubId: z.uuid().nullable(), role: z.enum(['org_admin', 'club_admin', 'receptionist', 'starter']),
})).min(1).max(40);

function principal(req: { principal: import('../../modules/auth/permissions.js').Principal | null }) {
  if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
  return req.principal;
}

export function userRoutes(app: FastifyInstance, deps: AppDeps) {
  // --- Comptes du personnel (administrateur du groupe, direction des golfs)
  app.get('/api/staff-users', async (req) => ({ users: await listStaff(deps.db, principal(req)) }));

  app.post('/api/staff-users', async (req, reply) => {
    const body = z.object({ email: z.email(), displayName: z.string().min(1).max(120), roles }).parse(req.body);
    return reply.status(201).send(await createStaff(deps.db, principal(req), body, actorOf(req)));
  });

  app.patch('/api/staff-users/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ displayName: z.string().min(1).max(120), roles, active: z.boolean() }).partial().strict().parse(req.body);
    await updateStaff(deps.db, principal(req), id, body, actorOf(req));
    return { ok: true };
  });

  app.post('/api/staff-users/:id/reset-password', async (req) => {
    const { id } = idParam.parse(req.params);
    return resetStaffPassword(deps.db, principal(req), id, actorOf(req));
  });

  // --- Son propre mot de passe (tout compte)
  app.post('/api/me/password', { config: { rateLimit: { max: app.loginRateLimit, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ current: z.string().min(1).max(200), next: z.string().min(MIN_PASSWORD).max(200) }).parse(req.body);
    await changeOwnPassword(deps.db, principal(req).userId, req.authToken, body);
    return { ok: true };
  });
}
