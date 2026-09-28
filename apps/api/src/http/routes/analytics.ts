import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertCan, type Principal } from '../../modules/auth/permissions.js';
import { getClub } from '../../modules/catalog/repository.js';
import { analyticsCsv, BLOCKS, computeAnalytics, type ReportConfig } from '../../modules/analytics/service.js';
import { createSchedule, deleteSchedule, listSchedules, sendScheduleNow, setScheduleActive } from '../../modules/analytics/schedules.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const date = z.iso.date();
const filters = {
  clubIds: z.array(z.uuid()).min(1).max(50),
  courseId: z.uuid().nullable().optional(),
  channels: z.array(z.string().max(20)).max(10).nullable().optional(),
  partnerId: z.uuid().nullable().optional(),
  categories: z.array(z.string().max(40)).max(20).nullable().optional(),
  compare: z.enum(['none', 'previous', 'last_year']).optional(),
  blocks: z.array(z.enum(BLOCKS)).min(1).max(BLOCKS.length),
};
const configSchema = z.object({ ...filters, from: date, to: date });
const scheduleSchema = z.object({
  name: z.string().min(1).max(120), frequency: z.enum(['weekly', 'monthly']),
  recipients: z.array(z.email()).min(1).max(10),
  config: z.object({ ...filters, period: z.enum(['previous_week', 'previous_month', 'last_7_days', 'last_30_days', 'month_to_date']) }),
});

function principal(req: FastifyRequest): Principal {
  if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
  return req.principal;
}

export function analyticsRoutes(app: FastifyInstance, deps: AppDeps) {
  async function checked(req: FastifyRequest, cfg: ReportConfig) {
    const p = principal(req);
    for (const id of cfg.clubIds) assertCan(p, 'reports.view', await getClub(deps.db, id));
    return computeAnalytics(deps.db, cfg);
  }

  app.post('/api/analytics', async (req) => ({ report: await checked(req, configSchema.parse(req.body)) }));

  // Export Excel : configuration passée en paramètre (JSON) pour un simple téléchargement.
  app.get('/api/analytics.csv', async (req, reply) => {
    const { config } = z.object({ config: z.string().max(4000) }).parse(req.query);
    let parsed: unknown;
    try { parsed = JSON.parse(config); } catch { throw new DomainError('VALIDATION', 'Configuration invalide.'); }
    const r = await checked(req, configSchema.parse(parsed));
    return reply.type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="rapport-${r.period.from}_${r.period.to}.csv"`).send(analyticsCsv(r));
  });

  app.get('/api/report-schedules', async (req) => ({ schedules: await listSchedules(deps.db, principal(req)) }));

  app.post('/api/report-schedules', async (req, reply) => {
    const body = scheduleSchema.parse(req.body);
    return reply.status(201).send({ schedule: await createSchedule(deps.db, principal(req), body, deps.now(), actorOf(req)) });
  });

  app.patch('/api/report-schedules/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    await setScheduleActive(deps.db, principal(req), id, active, deps.now());
    return { ok: true };
  });

  app.delete('/api/report-schedules/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await deleteSchedule(deps.db, principal(req), id, actorOf(req));
    return { ok: true };
  });

  app.post('/api/report-schedules/:id/send', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return sendScheduleNow(deps.db, deps.emailSender, principal(req), id, deps.now());
  });
}
