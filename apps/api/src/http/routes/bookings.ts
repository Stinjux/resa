import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cancelBooking,
  createBooking,
  createGroupBooking,
  getBooking,
  moveBooking,
  updateBooking,
} from '../../modules/booking/service.js';
import { SYSTEM_ACTOR } from '../../shared/audit.js';
import type { AppDeps } from '../server.js';

const holes = z.union([z.literal(9), z.literal(18)]);
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
});
const customer = z.object({
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().min(1).max(120),
  email: z.email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  preferredLocale: z.string().max(10).nullable().optional(),
});
const channel = z.enum(['web', 'phone', 'group', 'walk_in', 'staff']);
const idParam = z.object({ id: z.uuid() });

function idempotencyKey(headers: Record<string, unknown>): string | null {
  const v = headers['idempotency-key'];
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;
}

// TODO(étape 2) : authentification + rôles. L'acteur et le canal seront
// déduits de la session (client → 'web', personnel → canal choisi).
export function bookingRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post('/api/bookings', async (req, reply) => {
    const body = item
      .extend({ channel, customerId: z.uuid().optional(), customer: customer.optional() })
      .parse(req.body);
    const { channel: ch, customerId, customer: cust, ...rest } = body;
    const result = await createBooking(
      deps,
      { channel: ch, actor: SYSTEM_ACTOR, customerId, customer: cust, idempotencyKey: idempotencyKey(req.headers) },
      { ...rest, startsAt: new Date(rest.startsAt) },
    );
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post('/api/booking-groups', async (req, reply) => {
    const body = z
      .object({
        channel: channel.default('group'),
        customerId: z.uuid().optional(),
        customer: customer.optional(),
        items: z.array(item).min(1).max(50),
      })
      .parse(req.body);
    const result = await createGroupBooking(
      deps,
      {
        channel: body.channel,
        actor: SYSTEM_ACTOR,
        customerId: body.customerId,
        customer: body.customer,
        idempotencyKey: idempotencyKey(req.headers),
      },
      body.items.map((i) => ({ ...i, startsAt: new Date(i.startsAt) })),
    );
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.get('/api/bookings/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return { booking: await getBooking(deps.db, id) };
  });

  app.patch('/api/bookings/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = z
      .object({
        players: z.number().int().min(1).max(4).optional(),
        holes: holes.optional(),
        isPrivate: z.boolean().optional(),
        options: z.array(option).optional(),
        playerNames: z.array(z.string().max(120).nullable()).max(4).optional(),
        notes: z.string().max(2000).nullable().optional(),
      })
      .parse(req.body);
    return { booking: await updateBooking(deps, id, patch, { actor: SYSTEM_ACTOR }) };
  });

  app.post('/api/bookings/:id/cancel', async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
    return { booking: await cancelBooking(deps, id, { actor: SYSTEM_ACTOR, reason }) };
  });

  // Déplacer une réservation, ou la réunir avec une autre en visant son départ.
  app.post('/api/bookings/:id/move', async (req) => {
    const { id } = idParam.parse(req.params);
    const target = z
      .union([
        z.object({ teeTimeId: z.uuid() }),
        z.object({ courseId: z.uuid(), startsAt: z.iso.datetime({ offset: true }) }),
      ])
      .parse(req.body);
    const t = 'teeTimeId' in target ? target : { courseId: target.courseId, startsAt: new Date(target.startsAt) };
    return { booking: await moveBooking(deps, id, t, { actor: SYSTEM_ACTOR }) };
  });
}
