import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAvailability, getOptionsAvailability, getTeeSheet } from '../../modules/teesheet/service.js';
import type { AppDeps } from '../server.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const holes = z.coerce.number().pipe(z.union([z.literal(9), z.literal(18)]));

export function teeSheetRoutes(app: FastifyInstance, deps: AppDeps) {
  // Parcours client : créneaux réservables.
  app.get('/api/courses/:courseId/availability', async (req) => {
    const { courseId } = z.object({ courseId: z.uuid() }).parse(req.params);
    const q = z
      .object({ date, players: z.coerce.number().int().min(1).max(4), holes })
      .parse(req.query);
    const { club, course, slots } = await getAvailability(deps.db, {
      courseId,
      date: q.date,
      players: q.players,
      holes: q.holes,
      now: deps.now(),
      enforceBookingWindow: true,
    });
    return { club: { id: club.id, name: club.name, timezone: club.timezone, currency: club.currency }, course, slots };
  });

  app.get('/api/courses/:courseId/options', async (req) => {
    const { courseId } = z.object({ courseId: z.uuid() }).parse(req.params);
    const q = z.object({ startsAt: z.iso.datetime({ offset: true }), holes }).parse(req.query);
    return { options: await getOptionsAvailability(deps.db, { courseId, startsAt: new Date(q.startsAt), holes: q.holes }) };
  });

  // Vue interne (personnel) : feuille de départs complète.
  app.get('/api/courses/:courseId/tee-sheet', async (req) => {
    const { courseId } = z.object({ courseId: z.uuid() }).parse(req.params);
    const q = z.object({ date }).parse(req.query);
    return getTeeSheet(deps.db, courseId, q.date);
  });
}
