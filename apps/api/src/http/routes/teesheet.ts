import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan, assertDateVisible, can } from '../../modules/auth/permissions.js';
import { getCourse } from '../../modules/catalog/repository.js';
import { quoteNewBooking } from '../../modules/pricing/service.js';
import { getAvailability, getCalendar, getOptionsAvailability, getTeeSheet } from '../../modules/teesheet/service.js';
import { clubOf } from '../auth.js';
import { activeMembership } from '../../modules/members/membership.js';
import { instantToLocal } from '../../shared/time.js';
import type { AppDeps } from '../server.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const holesQuery = z.coerce.number().pipe(z.union([z.literal(9), z.literal(18)]));
const courseParam = z.object({ courseId: z.uuid() });

export function teeSheetRoutes(app: FastifyInstance, deps: AppDeps) {
  // Public : créneaux réservables par un client.
  app.get('/api/courses/:courseId/availability', async (req) => {
    const { courseId } = courseParam.parse(req.params);
    const q = z.object({ date, players: z.coerce.number().int().min(1).max(4), holes: holesQuery, all: z.enum(['0', '1']).optional() }).parse(req.query);
    // Membre connecté : réservation ouverte plus longtemps à l'avance, et son tarif pour repérer les heures creuses.
    const clubRef = await clubOf.course(deps, courseId);
    const member = req.principal?.customerId && req.principal.organizationId === clubRef.organizationId
      ? await activeMembership(deps.db, clubRef.id, req.principal.customerId, q.date) : null;
    const { club, course, slots } = await getAvailability(deps.db, {
      courseId, date: q.date, players: q.players, holes: q.holes, now: deps.now(), enforceBookingWindow: true,
      horizonDays: member?.bookingHorizonDays, includeUnavailable: q.all === '1', customerCategory: member?.priceCategory,
    });
    return { club: { id: club.id, name: club.name, timezone: club.timezone, currency: club.currency }, course, slots,
      membership: member ? { planName: member.planName } : null };
  });

  // Public : calendrier (jours réservables, jours à tarif réduit).
  app.get('/api/courses/:courseId/calendar', async (req) => {
    const { courseId } = courseParam.parse(req.params);
    const q = z.object({ from: date, days: z.coerce.number().int().min(1).max(62).default(31),
      players: z.coerce.number().int().min(1).max(4).default(1), holes: holesQuery }).parse(req.query);
    const clubRef = await clubOf.course(deps, courseId);
    const member = req.principal?.customerId && req.principal.organizationId === clubRef.organizationId
      ? await activeMembership(deps.db, clubRef.id, req.principal.customerId, q.from) : null;
    const horizon = Math.max(clubRef.bookingHorizonDays, member?.bookingHorizonDays ?? 0);
    return { days: await getCalendar(deps.db, { courseId, from: q.from, days: Math.min(q.days, horizon + 1), players: q.players, holes: q.holes,
      now: deps.now(), horizonDays: member?.bookingHorizonDays, customerCategory: member?.priceCategory }), horizonDays: horizon };
  });

  // Public : matériel disponible pour un créneau.
  app.get('/api/courses/:courseId/options', async (req) => {
    const { courseId } = courseParam.parse(req.params);
    const q = z.object({ startsAt: z.iso.datetime({ offset: true }), holes: holesQuery }).parse(req.query);
    return { options: await getOptionsAvailability(deps.db, { courseId, startsAt: new Date(q.startsAt), holes: q.holes }) };
  });

  // Public : devis détaillé avant réservation. La catégorie tarifaire n'est
  // prise en compte que pour le personnel.
  app.post('/api/quote', async (req) => {
    const body = z
      .object({
        courseId: z.uuid(),
        startsAt: z.iso.datetime({ offset: true }),
        players: z.number().int().min(1).max(4),
        holes: z.union([z.literal(9), z.literal(18)]),
        isPrivate: z.boolean().default(false),
        caddiePayment: z.enum(['on_site', 'with_booking']).optional(),
        customerCategory: z.string().max(40).optional(),
        options: z.array(z.object({ resourceTypeId: z.uuid(), quantity: z.number().int().min(0) })).default([]),
      })
      .parse(req.body);
    const club = await clubOf.course(deps, body.courseId);
    const course = await getCourse(deps.db, body.courseId);
    return {
      quote: await quoteNewBooking(deps.db, {
        club,
        course,
        startsAt: new Date(body.startsAt),
        players: body.players,
        holes: body.holes,
        isPrivate: body.isPrivate,
        caddiePayment: body.caddiePayment ?? club.defaultCaddiePayment,
        customerCategory: can(req.principal, 'booking.manage', club) ? (body.customerCategory ?? 'standard')
          : req.principal?.customerId && req.principal.organizationId === club.organizationId
            ? ((await activeMembership(deps.db, club.id, req.principal.customerId, instantToLocal(new Date(body.startsAt), club.timezone).date))?.priceCategory ?? 'standard')
            : 'standard',
        options: body.options,
      }),
    };
  });

  // Personnel : feuille de départs complète (starter limité à la semaine).
  app.get('/api/courses/:courseId/tee-sheet', async (req) => {
    const { courseId } = courseParam.parse(req.params);
    const q = z.object({ date }).parse(req.query);
    const club = await clubOf.course(deps, courseId);
    assertCan(req.principal, 'teesheet.view', club);
    assertDateVisible(req.principal, club, q.date, deps.now());
    const sheet = await getTeeSheet(deps.db, courseId, q.date);
    if (!can(req.principal, 'customer.view', club)) {
      for (const row of sheet.rows) {
        for (const b of row.bookings) {
          b.customerPhone = null;
          b.customerEmail = null;
        }
      }
    }
    return sheet;
  });
}
