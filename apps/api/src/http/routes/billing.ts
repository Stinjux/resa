import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { assertCan, can, type ClubRef } from '../../modules/auth/permissions.js';
import {
  bookingInvoices, bookingReceipt, closeCash, currentCash, getClosing, getInvoice, invoicesCsv, issueCreditNote, issueInvoice,
  issuePartnerInvoice, listClosings, listInvoices, previewPartnerInvoice, recordInvoicePayment,
} from '../../modules/billing/service.js';
import { getBooking } from '../../modules/booking/service.js';
import { getClub } from '../../modules/catalog/repository.js';
import { actorOf, clubOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const idParam = z.object({ id: z.uuid() });
const clubParam = z.object({ clubId: z.uuid() });
const period = z.object({ from: z.iso.date(), to: z.iso.date() }).loose();

/** Période en dates locales du golf, fin incluse. */
function range(club: { timezone: string }, q: unknown) {
  const { from, to } = period.parse(q);
  return {
    from: DateTime.fromISO(from, { zone: club.timezone }).startOf('day').toJSDate(),
    to: DateTime.fromISO(to, { zone: club.timezone }).plus({ days: 1 }).startOf('day').toJSDate(),
    label: `${from}_${to}`,
  };
}

export function billingRoutes(app: FastifyInstance, deps: AppDeps) {
  /** Personnel du golf, ou client propriétaire de la réservation. */
  async function assertBookingReadable(req: FastifyRequest, bookingId: string): Promise<ClubRef> {
    const club = await clubOf.booking(deps, bookingId);
    const booking = await getBooking(deps.db, bookingId);
    const isOwner = !!req.principal?.customerId && booking.customerId === req.principal.customerId;
    if (!isOwner) assertCan(req.principal, 'booking.view', club);
    return club;
  }

  // --- Reçu et factures d'une réservation
  app.get('/api/bookings/:id/receipt', async (req) => {
    const { id } = idParam.parse(req.params);
    await assertBookingReadable(req, id);
    return { receipt: await bookingReceipt(deps.db, id) };
  });

  app.get('/api/bookings/:id/invoices', async (req) => {
    const { id } = idParam.parse(req.params);
    const club = await assertBookingReadable(req, id);
    const all = await bookingInvoices(deps.db, id);
    // Le client ne voit que ses propres factures (pas celles adressées au partenaire).
    return { invoices: can(req.principal, 'booking.view', club) ? all : all.filter((i) => i.payer === 'customer') };
  });

  app.post('/api/bookings/:id/invoices', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({
      buyer: z.object({ name: z.string().max(200).optional(), address: z.string().max(500).nullable().optional(), ice: z.string().max(30).nullable().optional() })
        .nullable().optional(),
      payer: z.enum(['customer', 'partner']).optional(),
    }).parse(req.body ?? {});
    // Facture client : réception ; facture partenaire : direction.
    assertCan(req.principal, body.payer === 'partner' ? 'finance.manage' : 'booking.manage', await clubOf.booking(deps, id));
    return reply.status(201).send({ invoice: await issueInvoice(deps.db, id, body, actorOf(req)) });
  });

  app.get('/api/invoices/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const invoice = await getInvoice(deps.db, id);
    const club = await getClub(deps.db, invoice.clubId);
    const ownPartner = !!req.principal?.partnerId && req.principal.partnerId === invoice.partnerId;
    if (invoice.payer === 'customer' && invoice.bookingId) await assertBookingReadable(req, invoice.bookingId);
    else if (!ownPartner) assertCan(req.principal, 'booking.view', club);
    return { invoice };
  });

  // --- Factures partenaire (direction) : aperçu, émission groupée, règlement
  const partnerParams = z.object({ clubId: z.uuid(), partnerId: z.uuid() });
  const selection = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), bookingIds: z.array(z.uuid()).max(500).optional() });

  app.get('/api/clubs/:clubId/partners/:partnerId/invoice-preview', async (req) => {
    const { clubId, partnerId } = partnerParams.parse(req.params);
    assertCan(req.principal, 'finance.manage', await getClub(deps.db, clubId));
    return { preview: await previewPartnerInvoice(deps.db, clubId, partnerId, selection.parse(req.query)) };
  });

  app.post('/api/clubs/:clubId/partners/:partnerId/invoices', async (req, reply) => {
    const { clubId, partnerId } = partnerParams.parse(req.params);
    assertCan(req.principal, 'finance.manage', await getClub(deps.db, clubId));
    return reply.status(201).send({ invoice: await issuePartnerInvoice(deps.db, clubId, partnerId, selection.parse(req.body), actorOf(req)) });
  });

  app.post('/api/invoices/:id/payments', async (req) => {
    const { id } = idParam.parse(req.params);
    const invoice = await getInvoice(deps.db, id);
    assertCan(req.principal, 'finance.manage', await getClub(deps.db, invoice.clubId));
    const body = z.object({
      amountMinor: z.number().int().positive(), method: z.enum(['cash', 'card_terminal', 'bank_transfer', 'other']), note: z.string().max(200).nullable().optional(),
    }).parse(req.body);
    return { invoice: await recordInvoicePayment(deps.db, id, body, actorOf(req)) };
  });

  app.post('/api/invoices/:id/credit-note', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const invoice = await getInvoice(deps.db, id);
    assertCan(req.principal, 'finance.manage', await getClub(deps.db, invoice.clubId));
    const { reason } = z.object({ reason: z.string().min(1).max(300) }).parse(req.body);
    return reply.status(201).send({ invoice: await issueCreditNote(deps.db, id, reason, actorOf(req)) });
  });

  // --- Journal des factures (direction, comptable)
  app.get('/api/clubs/:clubId/invoices', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'finance.manage', club);
    const r = range(club, req.query);
    const f = z.object({ payer: z.enum(['customer', 'partner']).optional(), partnerId: z.uuid().optional() }).parse(req.query);
    return { invoices: await listInvoices(deps.db, clubId, r.from, r.to, f) };
  });

  app.get('/api/clubs/:clubId/invoices.csv', async (req, reply) => {
    const { clubId } = clubParam.parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'finance.manage', club);
    const r = range(club, req.query);
    const { payer } = z.object({ payer: z.enum(['customer', 'partner']).optional() }).parse(req.query);
    const csv = await invoicesCsv(deps.db, clubId, r.from, r.to, club.timezone, { payer });
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="factures-${club.code}-${r.label}.csv"`).send(csv);
  });

  // --- Caisse
  app.get('/api/clubs/:clubId/cash', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    assertCan(req.principal, 'booking.manage', await getClub(deps.db, clubId));
    return { cash: await currentCash(deps.db, clubId) };
  });

  app.post('/api/clubs/:clubId/cash/closings', async (req, reply) => {
    const { clubId } = clubParam.parse(req.params);
    assertCan(req.principal, 'booking.manage', await getClub(deps.db, clubId));
    const body = z.object({
      countedCashMinor: z.number().int().min(0), floatMinor: z.number().int().min(0).optional(), note: z.string().max(500).nullable().optional(),
    }).parse(req.body);
    return reply.status(201).send({ closing: await closeCash(deps.db, clubId, body, actorOf(req)) });
  });

  app.get('/api/clubs/:clubId/cash/closings', async (req) => {
    const { clubId } = clubParam.parse(req.params);
    assertCan(req.principal, 'booking.manage', await getClub(deps.db, clubId));
    return { closings: await listClosings(deps.db, clubId) };
  });

  app.get('/api/cash-closings/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const closing = await getClosing(deps.db, id);
    assertCan(req.principal, 'booking.manage', await getClub(deps.db, closing.clubId));
    return { closing };
  });
}
