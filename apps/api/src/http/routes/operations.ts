import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan, assertDateVisible, can } from '../../modules/auth/permissions.js';
import { blockRange, setCheckin, setStarted, teeSheetCsv, unblockRange } from '../../modules/operations/service.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf, clubOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^\d{1,2}[:h]\d{2}$/);

export function operationsRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post('/api/courses/:courseId/blocks', async (req) => {
    const { courseId } = z.object({ courseId: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'booking.manage', await clubOf.course(deps, courseId));
    const body = z.object({ date, from: time, to: time, reason: z.string().trim().min(1).max(200) }).parse(req.body);
    return blockRange(deps.db, { courseId, ...body }, actorOf(req));
  });

  app.post('/api/courses/:courseId/unblock', async (req) => {
    const { courseId } = z.object({ courseId: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'booking.manage', await clubOf.course(deps, courseId));
    const body = z.object({ date, from: time, to: time }).parse(req.body);
    return unblockRange(deps.db, { courseId, ...body }, actorOf(req));
  });

  // Arrivée / absence : starter ou réception.
  app.put('/api/bookings/:id/checkin', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const club = await clubOf.booking(deps, id);
    if (!can(req.principal, 'starter.operate', club)) assertCan(req.principal, 'booking.manage', club);
    const { status } = z.object({ status: z.enum(['expected', 'arrived', 'no_show']) }).parse(req.body);
    await setCheckin(deps.db, id, status, actorOf(req));
    return { ok: true };
  });

  app.put('/api/tee-times/:id/started', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const club = await clubOf.teeTime(deps, id);
    if (!can(req.principal, 'starter.operate', club)) assertCan(req.principal, 'booking.manage', club);
    const { started } = z.object({ started: z.boolean() }).parse(req.body);
    await setStarted(deps.db, id, started, actorOf(req));
    return { ok: true };
  });

  // Export Excel (CSV) de la feuille du jour.
  app.get('/api/courses/:courseId/tee-sheet.csv', async (req, reply) => {
    const { courseId } = z.object({ courseId: z.uuid() }).parse(req.params);
    const { date: d } = z.object({ date }).parse(req.query);
    const club = await clubOf.course(deps, courseId);
    assertCan(req.principal, 'teesheet.view', club);
    assertDateVisible(req.principal, club, d, deps.now());
    if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
    const csv = await teeSheetCsv(deps.db, courseId, d, can(req.principal, 'customer.view', club));
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="departs-${club.code}-${d}.csv"`).send(csv);
  });
}
