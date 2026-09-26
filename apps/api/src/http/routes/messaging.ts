import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan, can, type Principal } from '../../modules/auth/permissions.js';
import { getClub, listClubs } from '../../modules/catalog/repository.js';
import {
  approveRequest, getThread, listInbox, pendingRequestCount, processMessagingQueue, receiveInbound, rejectRequest, staffReply,
  type MessagingDeps,
} from '../../modules/messaging/service.js';
import { DomainError } from '../../shared/errors.js';
import type { AppDeps } from '../server.js';

const idParam = z.object({ id: z.uuid() });

export function messagingRoutes(app: FastifyInstance, deps: AppDeps) {
  const mdeps = (): MessagingDeps => ({ db: deps.db, now: deps.now, ai: deps.ai, messaging: deps.messaging });
  const user = (p: Principal | null): Principal => {
    if (!p) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
    return p;
  };

  // Nombre de demandes à valider (badge de navigation).
  app.get('/api/booking-requests/pending-count', async (req) => {
    const p = user(req.principal);
    const clubs = (await listClubs(deps.db)).filter((c) => can(p, 'booking.manage', c));
    return { count: clubs.length ? await pendingRequestCount(deps.db, clubs.map((c) => c.id)) : 0 };
  });

  app.get('/api/clubs/:clubId/inbox', async (req) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'booking.manage', club);
    return { threads: await listInbox(deps.db, clubId), simulator: club.messagingProvider === 'local', provider: club.messagingProvider };
  });

  app.get('/api/message-threads/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const thread = await getThread(deps.db, id);
    assertCan(req.principal, 'booking.manage', await getClub(deps.db, thread.clubId));
    return { thread };
  });

  app.post('/api/message-threads/:id/reply', async (req) => {
    const { id } = idParam.parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(1600) }).parse(req.body);
    await staffReply(deps.db, user(req.principal), id, text);
    await processMessagingQueue(mdeps()); // envoi immédiat
    return { thread: await getThread(deps.db, id) };
  });

  // Validation obligatoire par la réception ou la direction.
  app.post('/api/booking-requests/:id/approve', async (req) => {
    const { id } = idParam.parse(req.params);
    const { note } = z.object({ note: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
    await approveRequest(mdeps(), user(req.principal), id, note);
    await processMessagingQueue(mdeps());
    return { ok: true };
  });

  app.post('/api/booking-requests/:id/reject', async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
    await rejectRequest(mdeps(), user(req.principal), id, reason);
    await processMessagingQueue(mdeps());
    return { ok: true };
  });

  // Simulateur (golf configuré sur le fournisseur « local ») : saisir un message client.
  app.post('/api/clubs/:clubId/messaging/simulate', async (req, reply) => {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'booking.manage', club);
    if (club.messagingProvider !== 'local') throw new DomainError('FORBIDDEN', 'Simulateur disponible seulement avec le fournisseur « local ».');
    const body = z.object({ channel: z.enum(['whatsapp', 'sms']), from: z.string().min(6).max(30), name: z.string().max(120).nullable().optional(),
      text: z.string().trim().min(1).max(2000) }).parse(req.body);
    const r = await receiveInbound(deps.db, clubId, 'local', {
      channel: body.channel, from: body.from, to: null, fromName: body.name ?? null, text: body.text,
      providerMessageId: crypto.randomUUID(), receivedAt: deps.now(),
    });
    await processMessagingQueue(mdeps());
    return reply.status(201).send({ thread: await getThread(deps.db, r.threadId) });
  });

  // Notifications du fournisseur (une URL par golf). Corps brut conservé pour vérifier la signature.
  app.register(async (hook) => {
    hook.removeAllContentTypeParsers();
    hook.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    hook.route({
      method: ['GET', 'POST'],
      url: '/api/messaging/:provider/webhook/:clubId',
      handler: async (req, reply) => {
        const p = z.object({ provider: z.string(), clubId: z.uuid() }).parse(req.params);
        const connector = deps.messaging.get(p.provider);
        const club = await getClub(deps.db, p.clubId);
        if (!connector?.handleWebhook || club.messagingProvider !== p.provider) throw new DomainError('NOT_FOUND', 'Webhook inconnu.');
        const { messages, challenge } = await connector.handleWebhook({
          method: req.method, headers: req.headers, query: req.query as Record<string, unknown>, rawBody: (req.body as string) ?? '',
        });
        for (const m of messages) await receiveInbound(deps.db, club.id, connector.provider, m);
        return challenge ? reply.type('text/plain').send(challenge) : reply.status(200).send({ ok: true });
      },
    });
  });
}
