// Messagerie WhatsApp / SMS : réception, réponses de l'IA, file d'envoi, et
// VALIDATION par le personnel des demandes de réservation.
//
// Règle métier : aucune demande reçue par message ne devient une réservation
// sans validation explicite d'une réceptionniste ou d'un directeur du golf.

import type { Db, Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import type { MessagingRegistry } from '../../integrations/messaging/registry.js';
import { MessagingError, type InboundMessage } from '../../integrations/messaging/contract.js';
import { audit } from '../../shared/audit.js';
import { DomainError } from '../../shared/errors.js';
import type { AiModel } from '../ai/model.js';
import { assertCan, type Principal } from '../auth/permissions.js';
import { createBooking, createGroupBooking, type BookingDeps } from '../booking/service.js';
import { getClub } from '../catalog/repository.js';
import { runCustomerAgent } from './agent.js';
import { normalizePhone, phoneKey } from './phone.js';
import { render, teeTimeLine } from './templates.js';

/** Garde-fou de coût : tours d'IA par conversation et par 24 h. */
const AI_TURNS_PER_DAY = Number(process.env.AI_MESSAGING_TURNS_PER_DAY ?? 40);
const MAX_SEND_ATTEMPTS = 5;

export interface MessagingDeps extends BookingDeps {
  ai: AiModel | null;
  messaging: MessagingRegistry;
}

// ---------------------------------------------------------------------------
// Réception

export async function receiveInbound(db: Db, clubId: string, provider: string, msg: InboundMessage) {
  const club = await getClub(db, clubId);
  const contact = normalizePhone(msg.from, club.countryCode);
  return withTransaction(db, async (tx) => {
    const { rows: [thread] } = await tx.query(
      `INSERT INTO message_threads (club_id, channel, contact, contact_name, last_message_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (club_id, channel, contact)
       DO UPDATE SET last_message_at = EXCLUDED.last_message_at, contact_name = coalesce(message_threads.contact_name, EXCLUDED.contact_name)
       RETURNING id`,
      [clubId, msg.channel, contact, msg.fromName, msg.receivedAt],
    );
    const ins = await tx.query(
      `INSERT INTO messages (thread_id, direction, author, body, provider, provider_message_id, status)
       VALUES ($1, 'in', 'customer', $2, $3, $4, 'received')
       ON CONFLICT (provider, provider_message_id) DO NOTHING RETURNING id`,
      [thread.id, msg.text.slice(0, 4000), provider, msg.providerMessageId],
    );
    return { threadId: thread.id as string, messageId: (ins.rows[0]?.id ?? null) as string | null, duplicate: !ins.rowCount };
  });
}

async function queueOutbound(q: Queryable, threadId: string, author: 'ai' | 'staff' | 'system', body: string, sentBy: string | null = null) {
  await q.query(
    `INSERT INTO messages (thread_id, direction, author, body, status, sent_by) VALUES ($1, 'out', $2, $3, 'pending', $4)`,
    [threadId, author, body, sentBy],
  );
  await q.query('UPDATE message_threads SET last_message_at = now() WHERE id = $1', [threadId]);
}

// ---------------------------------------------------------------------------
// Traitement de la file (IA sur les messages reçus, puis envois)

async function processThread(deps: MessagingDeps, threadId: string, now: Date) {
  const db = deps.db;
  // Un seul traitement à la fois par conversation.
  const lock = await db.connect();
  try {
    const { rows: [l] } = await lock.query(`SELECT pg_try_advisory_lock(hashtextextended('thread:' || $1, 0)) AS ok`, [threadId]);
    if (!l.ok) return;
    try {
      const pending = await db.query(
        `SELECT id, body FROM messages WHERE thread_id = $1 AND direction = 'in' AND status = 'received' ORDER BY created_at`, [threadId]);
      if (!pending.rowCount) return;
      const { rows: [t] } = await db.query(
        `SELECT t.id, t.club_id AS "clubId", t.channel, t.contact_name AS "contactName", t.customer_id AS "customerId",
                t.ai_messages AS "aiMessages", t.ai_turns_window AS turns, t.ai_window_start AS "windowStart", t.locale, c.name AS "clubName"
           FROM message_threads t JOIN clubs c ON c.id = t.club_id WHERE t.id = $1`, [threadId]);
      const text = pending.rows.map((r) => r.body).join('\n');
      const windowExpired = now.getTime() - t.windowStart.getTime() > 86_400_000;
      const turns = windowExpired ? 0 : t.turns;

      if (deps.ai && turns < AI_TURNS_PER_DAY) {
        const result = await runCustomerAgent(db, deps.ai, now, t, text);
        await withTransaction(db, async (tx) => {
          await tx.query(
            `UPDATE message_threads SET ai_messages = $2, ai_turns_window = $3, ai_window_start = $4 WHERE id = $1`,
            [threadId, JSON.stringify(result.messages), turns + 1, windowExpired ? now : t.windowStart],
          );
          await tx.query(`UPDATE messages SET status = 'processed' WHERE id = ANY($1)`, [pending.rows.map((r) => r.id)]);
          // Si l'IA a transmis une demande sans le dire, message standard.
          const reply = result.reply || (result.requestIds.length ? render('received', t.locale, { golf: t.clubName }) : '');
          if (reply) await queueOutbound(tx, threadId, 'ai', reply);
        });
      } else {
        // Sans IA (ou quota atteint) : accusé de réception, le personnel répond.
        await withTransaction(db, async (tx) => {
          const first = await tx.query(`SELECT 1 FROM messages WHERE thread_id = $1 AND direction = 'out' LIMIT 1`, [threadId]);
          await tx.query(`UPDATE messages SET status = 'processed' WHERE id = ANY($1)`, [pending.rows.map((r) => r.id)]);
          if (!first.rowCount) await queueOutbound(tx, threadId, 'system', render('noAi', t.locale, { golf: t.clubName }));
        });
      }
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtextextended('thread:' || $1, 0))`, [threadId]);
    }
  } finally {
    lock.release();
  }
}

async function sendPending(deps: MessagingDeps, now: Date) {
  const { rows } = await deps.db.query(
    `SELECT m.id, m.body, m.attempts, t.channel, t.contact, c.messaging_provider AS provider
       FROM messages m JOIN message_threads t ON t.id = m.thread_id JOIN clubs c ON c.id = t.club_id
      WHERE m.direction = 'out' AND m.status = 'pending' AND m.next_attempt_at <= greatest($1::timestamptz, now())
      ORDER BY m.created_at LIMIT 50`,
    [now],
  );
  for (const m of rows) {
    const connector = m.provider ? deps.messaging.get(m.provider) : undefined;
    try {
      if (!connector) throw new MessagingError('Aucun fournisseur de messagerie configuré pour ce golf.', false);
      const r = await connector.send({ channel: m.channel, to: m.contact, text: m.body }, { idempotencyKey: m.id });
      await deps.db.query(`UPDATE messages SET status = 'sent', provider = $2, provider_message_id = $3, attempts = attempts + 1, last_error = NULL WHERE id = $1`,
        [m.id, connector.provider, r.providerMessageId]);
    } catch (err) {
      const retryable = err instanceof MessagingError ? err.retryable : true;
      const attempts = m.attempts + 1;
      const failed = !retryable || attempts >= MAX_SEND_ATTEMPTS;
      await deps.db.query(
        `UPDATE messages SET status = $2, attempts = $3, last_error = $4, next_attempt_at = $5 WHERE id = $1`,
        [m.id, failed ? 'failed' : 'pending', attempts, (err as Error).message.slice(0, 500), new Date(now.getTime() + 30_000 * 2 ** (attempts - 1))],
      );
    }
  }
}

export async function processMessagingQueue(deps: MessagingDeps, now: Date = deps.now()) {
  const threads = await deps.db.query(
    `SELECT DISTINCT thread_id FROM messages WHERE direction = 'in' AND status = 'received' LIMIT 20`);
  for (const r of threads.rows) {
    try {
      await processThread(deps, r.thread_id, now);
    } catch (err) {
      console.error('Messagerie : traitement IA impossible', err); // les messages restent « received » : nouvel essai
    }
  }
  await sendPending(deps, now);
}

// ---------------------------------------------------------------------------
// Boîte de réception et validation (personnel)

export async function listInbox(q: Queryable, clubId: string) {
  const { rows } = await q.query(
    `SELECT t.id, t.channel, t.contact, t.contact_name AS "contactName", t.last_message_at AS "lastMessageAt",
            (SELECT body FROM messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS "lastMessage",
            (SELECT count(*)::int FROM booking_requests WHERE thread_id = t.id AND status = 'pending') AS "pendingRequests",
            (SELECT count(*)::int FROM messages WHERE thread_id = t.id AND status = 'failed') AS "failedMessages"
       FROM message_threads t WHERE t.club_id = $1
      ORDER BY (SELECT count(*) FROM booking_requests WHERE thread_id = t.id AND status = 'pending') > 0 DESC, t.last_message_at DESC
      LIMIT 100`,
    [clubId],
  );
  return rows;
}

export async function pendingRequestCount(q: Queryable, clubIds: string[]): Promise<number> {
  const { rows } = await q.query(`SELECT count(*)::int AS n FROM booking_requests WHERE club_id = ANY($1) AND status = 'pending'`, [clubIds]);
  return rows[0].n;
}

export async function getThread(q: Queryable, threadId: string) {
  const { rows: [t] } = await q.query(
    `SELECT id, club_id AS "clubId", channel, contact, contact_name AS "contactName", customer_id AS "customerId", locale
       FROM message_threads WHERE id = $1`, [threadId]);
  if (!t) throw new DomainError('NOT_FOUND', 'Conversation introuvable.');
  const messages = await q.query(
    `SELECT m.id, m.direction, m.author, m.body, m.status, m.last_error AS "lastError", m.created_at AS "createdAt", u.display_name AS "sentBy"
       FROM messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.thread_id = $1 ORDER BY m.created_at`, [threadId]);
  const requests = await q.query(
    `SELECT r.id, r.status, r.summary, r.last_error AS "lastError", r.decision_note AS "decisionNote", r.created_at AS "createdAt",
            r.decided_at AS "decidedAt", u.display_name AS "decidedBy",
            coalesce((SELECT array_agg(reference ORDER BY reference) FROM bookings WHERE id = ANY(r.booking_ids)), '{}') AS "bookingReferences"
       FROM booking_requests r LEFT JOIN users u ON u.id = r.decided_by WHERE r.thread_id = $1 ORDER BY r.created_at`, [threadId]);
  return { ...t, messages: messages.rows, requests: requests.rows };
}

export async function staffReply(db: Db, principal: Principal, threadId: string, text: string) {
  const t = await getThread(db, threadId);
  assertCan(principal, 'booking.manage', await getClub(db, t.clubId));
  await queueOutbound(db, threadId, 'staff', text.slice(0, 1600), principal.userId);
}

async function findOrgCustomerByPhone(q: Queryable, organizationId: string, contact: string): Promise<string | null> {
  const { rows } = await q.query(
    `SELECT id FROM customers WHERE organization_id = $1 AND phone IS NOT NULL
        AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = $2
      ORDER BY created_at LIMIT 1`,
    [organizationId, phoneKey(contact)],
  );
  return rows[0]?.id ?? null;
}

/**
 * Validation par une réceptionniste ou un directeur du golf : crée la ou les
 * réservations puis envoie la confirmation au client. Si un créneau a été
 * pris entre-temps, la demande reste en attente avec l'erreur affichée.
 */
export async function approveRequest(deps: MessagingDeps, principal: Principal, requestId: string, note?: string | null) {
  const { rows: [r] } = await deps.db.query(
    `SELECT r.*, t.contact, t.channel, t.locale, t.customer_id AS thread_customer
       FROM booking_requests r JOIN message_threads t ON t.id = r.thread_id WHERE r.id = $1`, [requestId]);
  if (!r) throw new DomainError('NOT_FOUND', 'Demande introuvable.');
  const club = await getClub(deps.db, r.club_id);
  assertCan(principal, 'booking.manage', club);
  if (r.status === 'approved') return; // double clic
  if (r.status !== 'pending') throw new DomainError('VALIDATION', 'Cette demande a déjà été traitée.');

  const customerId = r.thread_customer ?? (await findOrgCustomerByPhone(deps.db, club.organizationId, r.contact));
  const ctx = {
    channel: r.channel as 'whatsapp' | 'sms',
    actor: { type: 'user' as const, id: principal.userId },
    customerId,
    customer: customerId ? null : { ...r.payload.customer, phone: r.contact, preferredLocale: r.payload.language ?? null },
    idempotencyKey: `request:${requestId}`,
  };
  const items = r.payload.items.map((i: { courseId: string; startsAt: string; players: number; holes: 9 | 18 }) => ({
    courseId: i.courseId, startsAt: new Date(i.startsAt), players: i.players, holes: i.holes,
    notes: [r.payload.notes, note].filter(Boolean).join(' — ') || null,
  }));
  let bookingIds: string[];
  try {
    bookingIds = items.length === 1
      ? [(await createBooking(deps, ctx, items[0])).booking.id]
      : (await createGroupBooking(deps, ctx, items)).bookings.map((b) => b.id);
  } catch (err) {
    if (err instanceof DomainError) {
      await deps.db.query('UPDATE booking_requests SET last_error = $2 WHERE id = $1', [requestId, err.message]);
    }
    throw err;
  }

  await withTransaction(deps.db, async (tx) => {
    const upd = await tx.query(
      `UPDATE booking_requests SET status = 'approved', booking_ids = $2, decided_by = $3, decided_at = now(), decision_note = $4, last_error = NULL
        WHERE id = $1 AND status = 'pending'`,
      [requestId, bookingIds, principal.userId, note ?? null],
    );
    if (!upd.rowCount) return;
    const { rows: bookings } = await tx.query(
      `SELECT b.reference, b.customer_id, t.local_date, to_char(t.starts_at AT TIME ZONE $2, 'HH24:MI') AS time, b.players, b.holes, o.total_minor
         FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN orders o ON o.booking_id = b.id
        WHERE b.id = ANY($1) ORDER BY t.starts_at`,
      [bookingIds, club.timezone],
    );
    await tx.query('UPDATE message_threads SET customer_id = coalesce(customer_id, $2) WHERE id = $1', [r.thread_id, bookings[0]!.customer_id]);
    const total = bookings.reduce((n, b) => n + b.total_minor, 0);
    await queueOutbound(tx, r.thread_id, 'system', render('approved', r.locale, {
      golf: club.name,
      details: bookings.map((b) => teeTimeLine(r.locale, b.local_date, b.time, b.players, b.holes)).join(' ; '),
      refs: bookings.map((b) => b.reference).join(', '),
      total: `${total / 100} ${club.currency}`,
    }));
    await audit(tx, { clubId: club.id, actor: { type: 'user', id: principal.userId }, action: 'booking_request.approved',
      entityType: 'booking_request', entityId: requestId, data: { bookingIds, channel: r.channel } });
  });
}

export async function rejectRequest(deps: MessagingDeps, principal: Principal, requestId: string, reason?: string | null) {
  const { rows: [r] } = await deps.db.query(
    `SELECT r.id, r.club_id, r.thread_id, r.status, t.locale FROM booking_requests r JOIN message_threads t ON t.id = r.thread_id WHERE r.id = $1`, [requestId]);
  if (!r) throw new DomainError('NOT_FOUND', 'Demande introuvable.');
  const club = await getClub(deps.db, r.club_id);
  assertCan(principal, 'booking.manage', club);
  if (r.status !== 'pending') throw new DomainError('VALIDATION', 'Cette demande a déjà été traitée.');
  await withTransaction(deps.db, async (tx) => {
    await tx.query(`UPDATE booking_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
      [requestId, principal.userId, reason ?? null]);
    await queueOutbound(tx, r.thread_id, 'system', render('rejected', r.locale, { golf: club.name, reason: reason ? ` ${reason}` : '' }));
    await audit(tx, { clubId: club.id, actor: { type: 'user', id: principal.userId }, action: 'booking_request.rejected',
      entityType: 'booking_request', entityId: requestId, data: { reason: reason ?? null } });
  });
}
