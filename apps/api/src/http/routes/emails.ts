import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan } from '../../modules/auth/permissions.js';
import { getClub } from '../../modules/catalog/repository.js';
import { getEmail, listEmails, processEmailQueue, resendEmail } from '../../modules/notifications/service.js';
import { DomainError } from '../../shared/errors.js';
import type { AppDeps } from '../server.js';

export function emailRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/api/clubs/:clubId/emails', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'config.manage', await getClub(deps.db, clubId));
    return { mode: deps.emailSender.mode, emails: await listEmails(deps.db, clubId) };
  });

  app.get('/api/emails/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const email = await getEmail(deps.db, id);
    if (!email) throw new DomainError('NOT_FOUND', 'E-mail introuvable.');
    assertCan(req.principal, 'config.manage', await getClub(deps.db, email.clubId));
    return { email };
  });

  app.post('/api/clubs/:clubId/emails/:id/resend', async (req) => {
    const { clubId, id } = z.object({ clubId: z.uuid(), id: z.uuid() }).parse(req.params);
    assertCan(req.principal, 'config.manage', await getClub(deps.db, clubId));
    if (!(await resendEmail(deps.db, clubId, id))) throw new DomainError('NOT_FOUND', 'E-mail introuvable.');
    await processEmailQueue(deps.db, deps.emailSender, deps.now());
    return { ok: true };
  });
}
