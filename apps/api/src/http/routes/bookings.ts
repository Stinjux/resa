import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan, can } from '../../modules/auth/permissions.js';
import {
  cancelBooking,
  createBooking,
  createGroupBooking,
  getBooking,
  moveBooking,
  updateBooking,
  type BookingContext,
} from '../../modules/booking/service.js';
import { getCourse, type Club } from '../../modules/catalog/repository.js';
import { isCustomerVisibleToClub } from '../../modules/customers/service.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf, clubOf } from '../auth.js';
import type { AppDeps } from '../server.js';
import type { FastifyRequest } from 'fastify';

const holes = z.union([z.literal(9), z.literal(18)]);
const caddiePayment = z.enum(['on_site', 'with_booking']);
const option = z
  .object({ resourceTypeId: z.uuid().optional(), code: z.string().optional(), quantity: z.number().int().min(0) })
  .refine((o) => o.resourceTypeId || o.code, 'resourceTypeId ou code requis');
const item = z.object({
  courseId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  players: z.number().int().min(1).max(4),
  holes,
  isPrivate: z.boolean().optional(),
  options: z.array(option).optional(),
  playerNames: z.array(z.string().max(120).nullable()).max(4).optional(),
  notes: z.string().max(2000).nullable().optional(),
  customerCategory: z.string().max(40).optional(),
  caddiePayment: caddiePayment.optional(),
});
const customer = z.object({
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().min(1).max(120),
  email: z.email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  preferredLocale: z.string().max(10).nullable().optional(),
});
const staffChannel = z.enum(['phone', 'group', 'walk_in', 'staff']);
const idParam = z.object({ id: z.uuid() });

function idempotencyKey(headers: Record<string, unknown>): string | null {
  const v = headers['idempotency-key'];
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;
}

/** Contexte de réservation selon l'appelant : personnel du golf, client
 *  connecté ou visiteur. Le client ne peut réserver que sur le canal web. */
async function bookingContext(
  req: FastifyRequest,
  deps: AppDeps,
  club: Club,
  body: { channel?: string; customerId?: string; customer?: z.infer<typeof customer> },
): Promise<BookingContext> {
  const actor = actorOf(req);
  const key = idempotencyKey(req.headers);
  if (can(req.principal, 'booking.manage', club)) {
    if (body.customerId && !can(req.principal, 'config.manage', club) &&
        !(await isCustomerVisibleToClub(deps.db, club.id, body.customerId))) {
      throw new DomainError('NOT_FOUND', 'Golfeur introuvable pour ce golf.');
    }
    return {
      channel: staffChannel.parse(body.channel ?? 'phone'),
      actor, customerId: body.customerId, customer: body.customer, idempotencyKey: key,
    };
  }
  if (body.channel && body.channel !== 'web') throw new DomainError('FORBIDDEN', 'Canal réservé au personnel.');
  const own = req.principal?.organizationId === club.organizationId ? req.principal?.customerId : null;
  if (!own && !body.customer) throw new DomainError('VALIDATION', 'Coordonnées du client requises.');
  return { channel: 'web', actor, customerId: own ?? null, customer: own ? null : body.customer, idempotencyKey: key };
}

export function bookingRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post('/api/bookings', async (req, reply) => {
    const body = item
      .extend({ channel: z.string().optional(), customerId: z.uuid().optional(), customer: customer.optional() })
      .parse(req.body);
    const club = await clubOf.course(deps, body.courseId);
    const ctx = await bookingContext(req, deps, club, body);
    const { channel: _c, customerId: _i, customer: _cu, ...rest } = body;
    const result = await createBooking(deps, ctx, { ...rest, startsAt: new Date(rest.startsAt) });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post('/api/booking-groups', async (req, reply) => {
    const body = z
      .object({
        channel: staffChannel.default('group'),
        customerId: z.uuid().optional(),
        customer: customer.optional(),
        items: z.array(item).min(1).max(50),
      })
      .parse(req.body);
    const club = await clubOf.course(deps, body.items[0]!.courseId);
    assertCan(req.principal, 'booking.manage', club);
    const ctx = await bookingContext(req, deps, club, body);
    const result = await createGroupBooking(deps, ctx, body.items.map((i) => ({ ...i, startsAt: new Date(i.startsAt) })));
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.get('/api/bookings/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const club = await clubOf.booking(deps, id);
    const booking = await getBooking(deps.db, id);
    const isOwner = !!req.principal?.customerId && booking.customerId === req.principal.customerId;
    if (!isOwner) assertCan(req.principal, 'booking.view', club);
    return { booking };
  });

  app.get('/api/bookings/:id/history', async (req) => {
    const { id } = idParam.parse(req.params);
    const club = await clubOf.booking(deps, id);
    assertCan(req.principal, 'booking.view', club);
    const { rows } = await deps.db.query(
      `SELECT a.action, a.data, a.created_at AS "createdAt", a.actor_type AS "actorType", u.display_name AS "actorName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.entity_type = 'booking' AND a.entity_id = $1 ORDER BY a.id`,
      [id],
    );
    return { history: rows };
  });

  app.patch('/api/bookings/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    assertCan(req.principal, 'booking.manage', await clubOf.booking(deps, id));
    const patch = z
      .object({
        players: z.number().int().min(1).max(4).optional(),
        holes: holes.optional(),
        isPrivate: z.boolean().optional(),
        options: z.array(option).optional(),
        playerNames: z.array(z.string().max(120).nullable()).max(4).optional(),
        notes: z.string().max(2000).nullable().optional(),
        customerCategory: z.string().max(40).optional(),
        caddiePayment: caddiePayment.optional(),
      })
      .parse(req.body);
    return { booking: await updateBooking(deps, id, patch, { actor: actorOf(req) }) };
  });

  app.post('/api/bookings/:id/cancel', async (req) => {
    const { id } = idParam.parse(req.params);
    assertCan(req.principal, 'booking.manage', await clubOf.booking(deps, id));
    const { reason, waiveFee } = z.object({ reason: z.string().max(500).nullable().optional(), waiveFee: z.boolean().optional() }).parse(req.body ?? {});
    return { booking: await cancelBooking(deps, id, { actor: actorOf(req), reason, waiveFee }) };
  });

  // Déplacer une réservation, ou la réunir avec une autre en visant son départ.
  app.post('/api/bookings/:id/move', async (req) => {
    const { id } = idParam.parse(req.params);
    assertCan(req.principal, 'booking.manage', await clubOf.booking(deps, id));
    const target = z
      .union([z.object({ teeTimeId: z.uuid() }), z.object({ courseId: z.uuid(), startsAt: z.iso.datetime({ offset: true }) })])
      .parse(req.body);
    if ('courseId' in target) await getCourse(deps.db, target.courseId);
    const t = 'teeTimeId' in target ? target : { courseId: target.courseId, startsAt: new Date(target.startsAt) };
    return { booking: await moveBooking(deps, id, t, { actor: actorOf(req) }) };
  });
}
