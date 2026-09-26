import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { assertCan, visibleDateRange } from '../../modules/auth/permissions.js';
import { getClub } from '../../modules/catalog/repository.js';
import { getClubCustomer, searchClubCustomers } from '../../modules/customers/service.js';
import { assignCaddie, assignUnits, getStarterBoard, listCaddies, listUnits } from '../../modules/starter/service.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf, clubOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const clubParam = z.object({ clubId: z.uuid() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function staffRoutes(app: FastifyInstance, deps: AppDeps) {
  // --- Golfeurs du golf (réception)
  app.get('/api/clubs/:clubId/customers', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'customer.view', club);
    const { q } = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    return { customers: await searchClubCustomers(deps.db, clubId, q) };
  });

  app.get('/api/clubs/:clubId/customers/:customerId', async (req) => {
    const { clubId, customerId } = z.object({ clubId: z.uuid(), customerId: z.uuid() }).parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'customer.view', club);
    return { customer: await getClubCustomer(deps.db, clubId, customerId) };
  });

  // --- Vue starter : jour et semaine
  app.get('/api/clubs/:clubId/starter', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'starter.operate', club);
    const today = DateTime.fromJSDate(deps.now(), { zone: club.timezone }).toISODate()!;
    const q = z.object({ date: date.default(today), days: z.coerce.number().int().min(1).max(7).default(1) }).parse(req.query);
    const from = q.date;
    const to = DateTime.fromISO(from).plus({ days: q.days - 1 }).toISODate()!;
    const range = visibleDateRange(req.principal, club, deps.now());
    if (range && (from < range.from || to > range.to)) {
      throw new DomainError('FORBIDDEN', `Consultation limitée du ${range.from} au ${range.to}.`, range);
    }
    return { club: { id: club.id, name: club.name, timezone: club.timezone }, from, to,
      teeTimes: await getStarterBoard(deps.db, club, from, to) };
  });

  app.get('/api/clubs/:clubId/caddies', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'starter.operate', club);
    return { caddies: await listCaddies(deps.db, clubId) };
  });

  app.get('/api/clubs/:clubId/resource-units', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'starter.operate', club);
    return { units: await listUnits(deps.db, clubId) };
  });

  app.put('/api/tee-times/:id/caddie', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'starter.operate', await clubOf.teeTime(deps, id));
    const { caddieId } = z.object({ caddieId: z.uuid().nullable() }).parse(req.body);
    await assignCaddie(deps.db, id, caddieId, actorOf(req));
    return reply.status(204).send();
  });

  app.put('/api/allocations/:id/units', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'starter.operate', await clubOf.allocation(deps, id));
    const { unitIds } = z.object({ unitIds: z.array(z.uuid()).max(20) }).parse(req.body);
    await assignUnits(deps.db, id, unitIds, actorOf(req));
    return reply.status(204).send();
  });

  // --- Historique du golf (administration)
  app.get('/api/clubs/:clubId/audit', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'audit.view', club);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const { rows } = await deps.db.query(
      `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.data,
              a.created_at AS "createdAt", a.actor_type AS "actorType", u.display_name AS "actorName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.club_id = $1 ORDER BY a.id DESC LIMIT $2`,
      [clubId, limit],
    );
    return { entries: rows };
  });
}
