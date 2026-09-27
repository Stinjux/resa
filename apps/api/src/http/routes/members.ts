import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertCan } from '../../modules/auth/permissions.js';
import { getClub } from '../../modules/catalog/repository.js';
import {
  createMembership, getProfile, listMembers, myRounds, openGames, setBookingOpen, updateMembership, updateProfile,
} from '../../modules/members/service.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const date = z.iso.date();
const handicap = z.number().min(-10).max(54).nullable();

function golfer(req: FastifyRequest) {
  const p = req.principal;
  if (!p) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
  if (!p.customerId) throw new DomainError('FORBIDDEN', 'Espace réservé aux golfeurs.');
  return { customerId: p.customerId, organizationId: p.organizationId };
}

export function memberRoutes(app: FastifyInstance, deps: AppDeps) {
  // ------------------------------------------------------------ espace golfeur
  app.get('/api/me/profile', async (req) => ({ profile: await getProfile(deps.db, golfer(req).customerId) }));

  app.patch('/api/me/profile', async (req) => {
    const me = golfer(req);
    const body = z.object({
      firstName: z.string().max(120).nullable(), lastName: z.string().min(1).max(120), phone: z.string().max(40).nullable(),
      preferredLocale: z.enum(['fr', 'en', 'ar']).nullable(), handicapIndex: handicap, licenceNumber: z.string().max(40).nullable(),
      shareProfile: z.boolean(),
    }).partial().strict().parse(req.body);
    return { profile: await updateProfile(deps.db, me.customerId, body, actorOf(req)) };
  });

  app.get('/api/me/rounds', async (req) => ({ rounds: await myRounds(deps.db, golfer(req).customerId, deps.now()) }));

  app.get('/api/open-games', async (req) => {
    const me = golfer(req);
    const q = z.object({ clubId: z.uuid().optional(), days: z.coerce.number().int().min(1).max(60).optional() }).parse(req.query);
    return { games: await openGames(deps.db, me, { clubId: q.clubId, days: q.days, now: deps.now() }) };
  });

  app.put('/api/me/bookings/:id/open', async (req) => {
    const me = golfer(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ isOpen: z.boolean(), openNote: z.string().max(200).nullable().optional() }).parse(req.body);
    await setBookingOpen(deps.db, me.customerId, id, body, actorOf(req));
    return { ok: true };
  });

  // ------------------------------------------------------------ membres (personnel)
  const clubParam = z.object({ clubId: z.uuid() });
  const membershipFields = {
    planId: z.uuid(), cardNumber: z.string().max(40).nullable(), validFrom: date, validTo: date, notes: z.string().max(500).nullable(),
    handicapIndex: handicap,
  };

  app.get('/api/clubs/:clubId/membership-plans', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    assertCan(req.principal, 'customer.view', await getClub(deps.db, clubId));
    const { rows } = await deps.db.query(
      `SELECT id, code, name, price_category AS "priceCategory", booking_horizon_days AS "bookingHorizonDays" FROM membership_plans
        WHERE club_id = $1 AND active ORDER BY name`, [clubId]);
    return { plans: rows };
  });

  app.get('/api/clubs/:clubId/members', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    assertCan(req.principal, 'customer.view', await getClub(deps.db, clubId));
    const { q } = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    return { members: await listMembers(deps.db, clubId, q) };
  });

  app.post('/api/clubs/:clubId/members', async (req, reply) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'booking.manage', club);
    const body = z.object({
      ...membershipFields, cardNumber: membershipFields.cardNumber.optional(), notes: membershipFields.notes.optional(),
      handicapIndex: handicap.optional(), customerId: z.uuid().optional(),
      customer: z.object({ firstName: z.string().max(120).nullable().optional(), lastName: z.string().min(1).max(120),
        email: z.email().nullable().optional(), phone: z.string().max(40).nullable().optional() }).optional(),
    }).parse(req.body);
    return reply.status(201).send(await createMembership(deps.db, club, body, actorOf(req)));
  });

  app.patch('/api/clubs/:clubId/members/:id', async (req) => {
    const { clubId, id } = z.object({ clubId: z.uuid(), id: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'booking.manage', await getClub(deps.db, clubId));
    const body = z.object({ ...membershipFields, status: z.enum(['active', 'suspended']) }).partial().strict().parse(req.body);
    await updateMembership(deps.db, clubId, id, body, actorOf(req));
    return { ok: true };
  });
}
