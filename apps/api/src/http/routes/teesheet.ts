import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan, assertDateVisible, can } from '../../modules/auth/permissions.js';
import { getCourse } from '../../modules/catalog/repository.js';
import { quote } from '../../modules/pricing/service.js';
import { getAvailability, getOptionsAvailability, getTeeSheet } from '../../modules/teesheet/service.js';
import { clubOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const holesQuery = z.coerce.number().pipe(z.union([z.literal(9), z.literal(18)]));
const courseParam = z.object({ courseId: z.uuid() });

export function teeSheetRoutes(app: FastifyInstance, deps: AppDeps) {
  // Public : créneaux réservables par un client.
  app.get('/api/courses/:courseId/availability', async (req) => {
    const { courseId } = courseParam.parse(req.params);
    const q = z.object({ date, players: z.coerce.number().int().min(1).max(4), holes: holesQuery }).parse(req.query);
    const { club, course, slots } = await getAvailability(deps.db, {
      courseId, date: q.date, players: q.players, holes: q.holes, now: deps.now(), enforceBookingWindow: true,
    });
    return { club: { id: club.id, name: club.name, timezone: club.timezone, currency: club.currency }, course, slots };
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
      quote: await quote(deps.db, {
        club,
        course,
        startsAt: new Date(body.startsAt),
        players: body.players,
        holes: body.holes,
        isPrivate: body.isPrivate,
        caddiePayment: body.caddiePayment ?? club.defaultCaddiePayment,
        customerCategory: can(req.principal, 'booking.manage', club) ? (body.customerCategory ?? 'standard') : 'standard',
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
