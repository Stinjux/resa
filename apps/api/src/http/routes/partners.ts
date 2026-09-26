import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertCan, type Principal } from '../../modules/auth/permissions.js';
import { cancelBooking, createBooking, getBooking } from '../../modules/booking/service.js';
import { getClub, getCourse } from '../../modules/catalog/repository.js';
import {
  cancelAllotment, createAllotment, createPartnerUser, getPartner, listAllotments, listPartners, partnerBookings, partnerStatement,
  partnerStatementCsv, savePartner,
} from '../../modules/partners/service.js';
import { quoteNewBooking } from '../../modules/pricing/service.js';
import { getAvailability } from '../../modules/teesheet/service.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf, clubOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const idParam = z.object({ id: z.uuid() });
const date = z.iso.date();
const holes = z.union([z.literal(9), z.literal(18)]);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure HH:MM');
const partnerBody = z.object({
  code: z.string().min(1).max(20), name: z.string().min(1).max(120),
  kind: z.enum(['tour_operator', 'travel_agency', 'hotel', 'corporate', 'other']),
  priceCategory: z.string().min(1).max(40), onAccount: z.boolean(), paymentTermsDays: z.number().int().min(0).max(365),
  contactName: z.string().max(120).nullable(), email: z.email().nullable(), phone: z.string().max(40).nullable(),
  legalName: z.string().max(200).nullable(), address: z.string().max(500).nullable(), ice: z.string().max(30).nullable(),
  notes: z.string().max(2000).nullable(), active: z.boolean(),
});

/** Personnel de l'organisation ayant l'un des rôles donnés (sur au moins un golf). */
function assertStaff(p: Principal | null, roles: string[]): Principal {
  if (!p) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
  if (!p.roles.some((r) => roles.includes(r.role))) throw new DomainError('FORBIDDEN', 'Accès refusé.');
  return p;
}
const MANAGERS = ['org_admin', 'club_admin'];

const period = (q: unknown) => z.object({ from: date, to: date }).refine((p) => p.to >= p.from, 'Période invalide').parse(q);

export function partnerRoutes(app: FastifyInstance, deps: AppDeps) {
  // ------------------------------------------------------------------ personnel
  app.get('/api/partners', async (req) => {
    const p = assertStaff(req.principal, ['org_admin', 'club_admin', 'receptionist']);
    return { partners: await listPartners(deps.db, p.organizationId) };
  });

  app.post('/api/partners', async (req, reply) => {
    const p = assertStaff(req.principal, MANAGERS);
    const body = partnerBody.partial().required({ code: true, name: true }).parse(req.body);
    return reply.status(201).send({ partner: await savePartner(deps.db, p.organizationId, null, body, actorOf(req)) });
  });

  app.patch('/api/partners/:id', async (req) => {
    const p = assertStaff(req.principal, MANAGERS);
    const { id } = idParam.parse(req.params);
    return { partner: await savePartner(deps.db, p.organizationId, id, partnerBody.partial().strict().parse(req.body), actorOf(req)) };
  });

  app.post('/api/partners/:id/users', async (req, reply) => {
    const p = assertStaff(req.principal, MANAGERS);
    const { id } = idParam.parse(req.params);
    if ((await getPartner(deps.db, id)).organizationId !== p.organizationId) throw new DomainError('NOT_FOUND', 'Partenaire introuvable.');
    const body = z.object({ email: z.email(), displayName: z.string().min(1).max(120), password: z.string().min(8).max(200) }).parse(req.body);
    return reply.status(201).send(await createPartnerUser(deps.db, id, body, actorOf(req)));
  });

  app.get('/api/clubs/:clubId/allotments', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'booking.view', await getClub(deps.db, clubId));
    return { allotments: await listAllotments(deps.db, clubId) };
  });

  app.post('/api/clubs/:clubId/allotments', async (req, reply) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'config.manage', await getClub(deps.db, clubId));
    const body = z.object({
      partnerId: z.uuid(), courseId: z.uuid(), dateFrom: date, dateTo: date, weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
      startTime: time, endTime: time, releaseDays: z.number().int().min(0).max(365), note: z.string().max(500).nullable().optional(),
    }).parse(req.body);
    return reply.status(201).send(await createAllotment(deps.db, clubId, body, actorOf(req), deps.now()));
  });

  app.post('/api/clubs/:clubId/allotments/:id/cancel', async (req) => {
    const { clubId, id } = z.object({ clubId: z.uuid(), id: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'config.manage', await getClub(deps.db, clubId));
    return cancelAllotment(deps.db, clubId, id, actorOf(req));
  });

  async function statementScope(req: FastifyRequest) {
    const { id } = idParam.parse(req.params);
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.query);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'finance.manage', club);
    const partner = await getPartner(deps.db, id);
    if (partner.organizationId !== club.organizationId) throw new DomainError('NOT_FOUND', 'Partenaire introuvable.');
    return { id, club, ...period(req.query) };
  }

  app.get('/api/partners/:id/statement', async (req) => {
    const s = await statementScope(req);
    return { statement: await partnerStatement(deps.db, s.id, s.club.id, s.from, s.to) };
  });

  app.get('/api/partners/:id/statement.csv', async (req, reply) => {
    const s = await statementScope(req);
    const partner = await getPartner(deps.db, s.id);
    const csv = await partnerStatementCsv(deps.db, s.id, s.club.id, s.from, s.to);
    return reply.type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="releve-${partner.code}-${s.club.code}-${s.from}_${s.to}.csv"`).send(csv);
  });

  // ------------------------------------------------------------ portail partenaire
  function partnerOf(req: FastifyRequest) {
    const p = req.principal;
    if (!p) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
    if (!p.partnerId) throw new DomainError('FORBIDDEN', 'Espace réservé aux partenaires.');
    return { partnerId: p.partnerId, organizationId: p.organizationId };
  }
  /** Parcours d'un golf de l'organisation du partenaire. */
  async function partnerCourse(req: FastifyRequest, courseId: string) {
    const me = partnerOf(req);
    const club = await clubOf.course(deps, courseId);
    if (club.organizationId !== me.organizationId) throw new DomainError('NOT_FOUND', 'Parcours introuvable.');
    return { me, club, course: await getCourse(deps.db, courseId) };
  }

  app.get('/api/partner/me', async (req) => {
    const me = partnerOf(req);
    const p = await getPartner(deps.db, me.partnerId);
    return { partner: { id: p.id, name: p.name, code: p.code, onAccount: p.onAccount, paymentTermsDays: p.paymentTermsDays } };
  });

  app.get('/api/partner/availability', async (req) => {
    const q = z.object({ courseId: z.uuid(), date, players: z.coerce.number().int().min(1).max(4), holes: z.coerce.number().pipe(holes) }).parse(req.query);
    const { me } = await partnerCourse(req, q.courseId);
    const r = await getAvailability(deps.db, { ...q, now: deps.now(), enforceBookingWindow: false, partnerId: me.partnerId });
    return { slots: r.slots };
  });

  const request = z.object({ courseId: z.uuid(), startsAt: z.iso.datetime({ offset: true }), players: z.number().int().min(1).max(4), holes });

  app.post('/api/partner/quote', async (req) => {
    const body = request.parse(req.body);
    const { me, club, course } = await partnerCourse(req, body.courseId);
    const partner = await getPartner(deps.db, me.partnerId);
    return { quote: await quoteNewBooking(deps.db, { club, course, startsAt: new Date(body.startsAt), players: body.players, holes: body.holes,
      isPrivate: false, caddiePayment: club.defaultCaddiePayment, customerCategory: partner.priceCategory, options: [] }) };
  });

  app.post('/api/partner/bookings', async (req, reply) => {
    const body = request.extend({
      partnerReference: z.string().min(1).max(80), leadName: z.string().min(1).max(120),
      playerNames: z.array(z.string().max(120).nullable()).max(4).optional(), notes: z.string().max(2000).nullable().optional(),
    }).parse(req.body);
    const { me } = await partnerCourse(req, body.courseId);
    const key = req.headers['idempotency-key'];
    const result = await createBooking(deps, {
      channel: 'partner', actor: actorOf(req), partnerId: me.partnerId, partnerReference: body.partnerReference,
      customer: { lastName: body.leadName }, idempotencyKey: typeof key === 'string' && key.length <= 200 ? `partner:${me.partnerId}:${key}` : null,
    }, { courseId: body.courseId, startsAt: new Date(body.startsAt), players: body.players, holes: body.holes,
      playerNames: body.playerNames, notes: body.notes ?? null });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.get('/api/partner/bookings', async (req) => {
    const me = partnerOf(req);
    return { bookings: await partnerBookings(deps.db, me.partnerId, period(req.query)) };
  });

  // Annulation par le partenaire : uniquement dans le délai gratuit du golf.
  app.post('/api/partner/bookings/:id/cancel', async (req) => {
    const me = partnerOf(req);
    const { id } = idParam.parse(req.params);
    const booking = await getBooking(deps.db, id);
    if (booking.partner?.id !== me.partnerId) throw new DomainError('NOT_FOUND', 'Réservation introuvable.');
    const club = await getClub(deps.db, booking.clubId);
    const freeUntil = new Date(booking.teeTime.startsAt).getTime() - club.cancellationFreeHours * 3_600_000;
    if (deps.now().getTime() >= freeUntil) {
      throw new DomainError('FORBIDDEN', `Annulation en ligne impossible moins de ${club.cancellationFreeHours} h avant le départ : contactez le golf.`);
    }
    return { booking: await cancelBooking(deps, id, { actor: actorOf(req), reason: 'Annulée par le partenaire' }) };
  });
}
