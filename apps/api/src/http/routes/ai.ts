import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cancelDraft, confirmDraft, getConversation, runAssistantTurn } from '../../modules/ai/assistant.js';
import { computeReportData, generateReport, getReport, listReports } from '../../modules/ai/reports.js';
import { assertCan, type Principal } from '../../modules/auth/permissions.js';
import { getClub } from '../../modules/catalog/repository.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Chaque appel au modèle a un coût : limite par IP.
const aiLimit = { config: { rateLimit: { max: Number(process.env.AI_RATE_LIMIT ?? 30), timeWindow: '1 minute' } } };

export function aiRoutes(app: FastifyInstance, deps: AppDeps) {
  function staff(req: { principal: Principal | null }): Principal {
    const p = req.principal;
    if (!p) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
    if (!p.roles.length) throw new DomainError('FORBIDDEN', 'Réservé au personnel.');
    return p;
  }

  app.get('/api/ai/status', async () => ({ configured: !!deps.ai, model: deps.ai?.name ?? null }));

  // --- Assistant
  app.post('/api/ai/assistant', aiLimit, async (req) => {
    const p = staff(req);
    const body = z.object({ conversationId: z.uuid().nullable().optional(), message: z.string().trim().min(1).max(4000) }).parse(req.body);
    return runAssistantTurn({ db: deps.db, now: deps.now, model: deps.ai }, p, body);
  });

  app.get('/api/ai/conversations/:id', async (req) => {
    const p = staff(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return getConversation(deps.db, p, id);
  });

  app.post('/api/ai/drafts/:id/confirm', async (req) => {
    const p = staff(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return { draft: await confirmDraft(deps, p, id) };
  });

  app.post('/api/ai/drafts/:id/cancel', async (req) => {
    const p = staff(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return { draft: await cancelDraft(deps.db, p, id) };
  });

  // --- Rapports
  async function reportClub(req: { params: unknown; principal: Principal | null }) {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'reports.view', club);
    return club;
  }

  // Chiffres seuls (sans IA, toujours disponibles).
  app.get('/api/clubs/:clubId/reports/data', async (req) => {
    const club = await reportClub(req);
    const q = z.object({ from: date, to: date }).parse(req.query);
    return computeReportData(deps.db, club.id, q.from, q.to);
  });

  app.get('/api/clubs/:clubId/reports', async (req) => {
    const club = await reportClub(req);
    return { reports: await listReports(deps.db, club.id) };
  });

  app.post('/api/clubs/:clubId/reports', aiLimit, async (req, reply) => {
    const club = await reportClub(req);
    const body = z.object({ from: date, to: date, focus: z.string().max(500).nullable().optional(), locale: z.enum(['fr', 'en', 'ar', 'es']).optional() })
      .parse(req.body);
    const report = await generateReport(deps.db, deps.ai, { clubId: club.id, ...body, actor: actorOf(req) });
    return reply.status(201).send({ report });
  });

  app.get('/api/reports/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const report = await getReport(deps.db, id);
    assertCan(req.principal, 'reports.view', await getClub(deps.db, report.clubId));
    return { report };
  });
}
