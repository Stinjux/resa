// Disponibilité des ressources (tous les membres du personnel en lecture),
// affectation (starter), indisponibilités (gestionnaire) et historique.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { assertCan, can, type Permission } from '../../modules/auth/permissions.js';
import { getClub, listClubs } from '../../modules/catalog/repository.js';
import { CATEGORIES, historyActors, searchHistory, type Category } from '../../modules/history/service.js';
import {
  caddieOptions, clubOfUnavailability, declareUnavailability, endUnavailability, getResourceBoard, listConflicts, unitOptions,
} from '../../modules/resources/availability.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf, clubOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const clubParam = z.object({ clubId: z.uuid() });
const idParam = z.object({ id: z.uuid() });
const date = z.iso.date();

export function resourceRoutes(app: FastifyInstance, deps: AppDeps) {
  // --- Tableau du jour : types, unités, caddies, indisponibilités, conflits
  app.get('/api/clubs/:clubId/resources', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'teesheet.view', club);
    const today = DateTime.fromJSDate(deps.now(), { zone: club.timezone }).toISODate()!;
    const q = z.object({ date: date.default(today) }).parse(req.query);
    return {
      board: await getResourceBoard(deps.db, club, q.date, deps.now()),
      permissions: {
        manage: can(req.principal, 'config.manage', club),
        assign: can(req.principal, 'starter.operate', club),
        book: can(req.principal, 'booking.manage', club),
      },
    };
  });

  app.get('/api/clubs/:clubId/resource-conflicts', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'teesheet.view', club);
    return { conflicts: await listConflicts(deps.db, club, deps.now()) };
  });

  // --- Maintenance / indisponibilité : le gestionnaire administre les disponibilités
  app.post('/api/clubs/:clubId/unavailabilities', async (req, reply) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'config.manage', club);
    const body = z.object({
      unitId: z.uuid().nullable().optional(), caddieId: z.uuid().nullable().optional(),
      startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
      reason: z.string().min(1).max(300),
    }).parse(req.body);
    const r = await declareUnavailability(deps.db, clubId, { ...body, startsAt: new Date(body.startsAt), endsAt: body.endsAt ? new Date(body.endsAt) : null },
      actorOf(req), deps.now());
    return reply.status(201).send(r);
  });

  app.post('/api/unavailabilities/:id/end', async (req) => {
    const { id } = idParam.parse(req.params);
    assertCan(req.principal, 'config.manage', await getClub(deps.db, await clubOfUnavailability(deps.db, id)));
    return endUnavailability(deps.db, id, actorOf(req), deps.now());
  });

  // --- Choix d'affectation avec explication des conflits
  app.get('/api/allocations/:id/unit-options', async (req) => {
    const { id } = idParam.parse(req.params);
    assertCan(req.principal, 'booking.view', await clubOf.allocation(deps, id));
    return unitOptions(deps.db, id);
  });

  app.get('/api/tee-times/:id/caddie-options', async (req) => {
    const { id } = idParam.parse(req.params);
    assertCan(req.principal, 'booking.view', await clubOf.teeTime(deps, id));
    return caddieOptions(deps.db, id);
  });

  // --- Historique global (gestionnaires)
  async function allowedClubs(req: FastifyRequest, perm: Permission, clubId?: string | null): Promise<string[]> {
    if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
    if (clubId) {
      assertCan(req.principal, perm, await getClub(deps.db, clubId));
      return [clubId];
    }
    const ids = (await listClubs(deps.db)).filter((c) => can(req.principal, perm, c)).map((c) => c.id);
    if (!ids.length) throw new DomainError('FORBIDDEN', 'Historique réservé aux gestionnaires.');
    return ids;
  }

  app.get('/api/history', async (req) => {
    const q = z.object({
      clubId: z.uuid().optional(), from: date.optional(), to: date.optional(), actorId: z.uuid().optional(),
      category: z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]]).optional(), reference: z.string().max(40).optional(),
      before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    const clubIds = await allowedClubs(req, 'audit.view', q.clubId);
    return searchHistory(deps.db, { ...q, clubIds });
  });

  app.get('/api/history/filters', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid().optional() }).parse(req.query);
    const clubIds = await allowedClubs(req, 'audit.view', clubId);
    return { actors: await historyActors(deps.db, clubIds),
      categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label })) };
  });
}
