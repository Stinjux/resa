import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from '../modules/auth/permissions.js';
import { principalFromToken } from '../modules/auth/service.js';
import { getClub, type Club } from '../modules/catalog/repository.js';
import type { Actor } from '../shared/audit.js';
import { DomainError } from '../shared/errors.js';
import type { AppDeps } from './server.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    authToken: string | null;
  }
}

export function registerAuth(app: FastifyInstance, deps: AppDeps): void {
  app.decorateRequest('principal', null);
  app.decorateRequest('authToken', null);
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const token = header.slice(7).trim();
    req.authToken = token;
    req.principal = await principalFromToken(deps.db, token, deps.now());
    if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Session expirée ou invalide.');
  });
}

export function actorOf(req: FastifyRequest): Actor {
  const p = req.principal;
  if (!p) return { type: 'customer', id: null };
  return { type: p.roles.length > 0 ? 'user' : 'customer', id: p.userId };
}

async function clubVia(deps: AppDeps, sql: string, id: string, what: string): Promise<Club> {
  const { rows } = await deps.db.query(sql, [id]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', `${what} introuvable.`);
  return getClub(deps.db, rows[0].club_id);
}

export const clubOf = {
  course: (deps: AppDeps, id: string) => clubVia(deps, 'SELECT club_id FROM courses WHERE id = $1', id, 'Parcours'),
  booking: (deps: AppDeps, id: string) => clubVia(deps, 'SELECT club_id FROM bookings WHERE id = $1', id, 'Réservation'),
  teeTime: (deps: AppDeps, id: string) => clubVia(deps, 'SELECT club_id FROM tee_times WHERE id = $1', id, 'Départ'),
  allocation: (deps: AppDeps, id: string) =>
    clubVia(deps, 'SELECT club_id FROM resource_allocations WHERE id = $1', id, 'Allocation'),
};
