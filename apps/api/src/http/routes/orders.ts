import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan } from '../../modules/auth/permissions.js';
import { cancelBooking, cancellationFee, getBooking } from '../../modules/booking/service.js';
import { getBookingOrder, recordStaffPayment, recordStaffRefund } from '../../modules/orders/service.js';
import { listPosJobs, processPosJobs, retryPosJob } from '../../modules/pos-sync/service.js';
import { getClub } from '../../modules/catalog/repository.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf, clubOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const idParam = z.object({ id: z.uuid() });
const staffMethod = z.enum(['cash', 'card_terminal', 'bank_transfer', 'other']);
const payer = z.enum(['customer', 'partner']).optional();

function idempotencyKey(headers: Record<string, unknown>): string | null {
  const v = headers['idempotency-key'];
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;
}

export function orderRoutes(app: FastifyInstance, deps: AppDeps) {
  // Commande, paiements et solde d'une réservation.
  app.get('/api/bookings/:id/order', async (req) => {
    const { id } = idParam.parse(req.params);
    const club = await clubOf.booking(deps, id);
    const booking = await getBooking(deps.db, id);
    const isOwner = !!req.principal?.customerId && booking.customerId === req.principal.customerId;
    if (!isOwner) assertCan(req.principal, 'booking.view', club);
    return { order: await getBookingOrder(deps.db, id) };
  });

  // Encaissement constaté au golf (espèces, TPE, virement reçu).
  app.post('/api/bookings/:id/payments', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    assertCan(req.principal, 'booking.manage', await clubOf.booking(deps, id));
    const body = z.object({ amountMinor: z.number().int().positive(), method: staffMethod, note: z.string().max(300).nullable().optional(), payer }).parse(req.body);
    const summary = await recordStaffPayment(deps.db, id, { ...body, idempotencyKey: idempotencyKey(req.headers) }, actorOf(req));
    return reply.status(201).send({ order: summary });
  });

  app.post('/api/bookings/:id/refunds', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    assertCan(req.principal, 'booking.manage', await clubOf.booking(deps, id));
    const body = z.object({
      amountMinor: z.number().int().positive(), method: staffMethod, reason: z.string().max(300).nullable().optional(),
      paymentId: z.uuid().nullable().optional(), payer,
    }).parse(req.body);
    const summary = await recordStaffRefund(deps.db, id, { ...body, idempotencyKey: idempotencyKey(req.headers) }, actorOf(req));
    return reply.status(201).send({ order: summary });
  });

  // Frais qui s'appliqueraient si on annulait maintenant.
  app.get('/api/bookings/:id/cancellation-preview', async (req) => {
    const { id } = idParam.parse(req.params);
    const club = await clubOf.booking(deps, id);
    const booking = await getBooking(deps.db, id);
    const isOwner = !!req.principal?.customerId && booking.customerId === req.principal.customerId;
    if (!isOwner) assertCan(req.principal, 'booking.view', club);
    const startsAt = new Date(booking.teeTime.startsAt);
    const freeUntil = new Date(startsAt.getTime() - club.cancellationFreeHours * 3_600_000);
    return {
      feeMinor: cancellationFee(club, startsAt, deps.now(), booking.pricing.totalMinor ?? 0),
      currency: booking.pricing.currency, freeUntil: freeUntil.toISOString(),
      customerCanCancel: club.customerCanCancel && deps.now() < freeUntil,
    };
  });

  // Annulation par le client lui-même : seulement dans le délai gratuit.
  app.post('/api/me/bookings/:id/cancel', async (req) => {
    const { id } = idParam.parse(req.params);
    const booking = await getBooking(deps.db, id);
    if (!req.principal?.customerId || booking.customerId !== req.principal.customerId) {
      throw new DomainError('NOT_FOUND', 'Réservation introuvable.');
    }
    const club = await getClub(deps.db, booking.clubId);
    const freeUntil = new Date(booking.teeTime.startsAt).getTime() - club.cancellationFreeHours * 3_600_000;
    if (!club.customerCanCancel || deps.now().getTime() >= freeUntil) {
      throw new DomainError('FORBIDDEN', `Annulation en ligne impossible moins de ${club.cancellationFreeHours} h avant le départ : contactez le golf.`);
    }
    return { booking: await cancelBooking(deps, id, { actor: actorOf(req), reason: 'Annulée par le client' }) };
  });

  // --- Supervision de la synchronisation POS (direction)
  app.get('/api/clubs/:clubId/pos/jobs', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'config.manage', await getClub(deps.db, clubId));
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    return listPosJobs(deps.db, clubId, status);
  });

  app.post('/api/clubs/:clubId/pos/jobs/:jobId/retry', async (req) => {
    const { clubId, jobId } = z.object({ clubId: z.uuid(), jobId: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'config.manage', await getClub(deps.db, clubId));
    if (!(await retryPosJob(deps.db, clubId, jobId, deps.now()))) throw new DomainError('NOT_FOUND', 'Travail introuvable ou non relançable.');
    return { ok: true };
  });

  app.post('/api/clubs/:clubId/pos/process', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'config.manage', await getClub(deps.db, clubId));
    return processPosJobs(deps.db, deps.posRegistry, deps.now(), { clubId });
  });
}

