// Traitement de la file de synchronisation POS.
//
// Garanties :
//  - Un travail n'est jamais traité par deux processus en même temps
//    (SELECT … FOR UPDATE SKIP LOCKED + statut « processing »).
//  - Reprise sans doublon : clé d'idempotence stable transmise au connecteur,
//    et identifiant externe déjà connu (external_refs) transmis pour mise à jour.
//  - Une vente modifiée plusieurs fois n'est envoyée que dans sa DERNIÈRE
//    version : les versions plus anciennes sont marquées « superseded ».
//  - Chaque tentative est journalisée (pos_sync_log) ; après max_attempts le
//    travail passe « dead » et apparaît dans l'écran d'administration.

import type { Db, Queryable, Tx } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { PosError, type PosConnector, type PosResult, type PosSale } from '../../integrations/pos/contract.js';
import type { PosRegistry } from '../../integrations/pos/registry.js';

/** Un travail resté « processing » plus longtemps est considéré comme interrompu. */
const STALE_PROCESSING_MS = 10 * 60_000;

export function backoffMs(attempt: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1)); // 30 s, 1 min, 2 min… plafonné à 1 h
}

interface Job {
  id: string;
  clubId: string;
  provider: string;
  operation: 'upsert_sale' | 'record_payment' | 'record_refund';
  entityType: 'order' | 'payment' | 'refund';
  entityId: string;
  entityVersion: number;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
}

async function claimJobs(db: Db, now: Date, limit: number, clubId: string | null): Promise<Job[]> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<Job>(
      `SELECT id, club_id AS "clubId", provider, operation, entity_type AS "entityType", entity_id AS "entityId",
              entity_version AS "entityVersion", idempotency_key AS "idempotencyKey", attempts, max_attempts AS "maxAttempts"
         FROM pos_sync_jobs
        WHERE ((status IN ('pending', 'failed') AND next_attempt_at <= $1)
               OR (status = 'processing' AND updated_at < $2))
          AND ($4::uuid IS NULL OR club_id = $4)
        ORDER BY created_at
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [now, new Date(now.getTime() - STALE_PROCESSING_MS), limit, clubId],
    );
    if (rows.length) {
      await tx.query(
        `UPDATE pos_sync_jobs SET status = 'processing', attempts = attempts + 1, updated_at = $2 WHERE id = ANY($1)`,
        [rows.map((r) => r.id), now],
      );
    }
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
}

async function externalId(q: Queryable, provider: string, entityType: string, entityId: string): Promise<string | null> {
  const { rows } = await q.query(
    'SELECT external_id FROM external_refs WHERE provider = $1 AND entity_type = $2 AND entity_id = $3',
    [provider, entityType, entityId],
  );
  return rows[0]?.external_id ?? null;
}

/** Instantané de la vente à envoyer, construit depuis l'état actuel. */
export async function buildSale(q: Queryable, orderId: string, provider: string): Promise<PosSale> {
  const { rows: [o] } = await q.query(
    `SELECT o.id, o.version, o.reference, o.club_id AS "clubId", c.code AS "clubCode", o.currency,
            c.prices_include_tax AS "pricesIncludeTax", o.status, o.booking_id AS "bookingId",
            t.starts_at AS "startsAt", o.total_minor AS "totalMinor", o.tax_minor AS "taxMinor",
            cu.id AS "customerId", cu.first_name AS "firstName", cu.last_name AS "lastName", cu.email, cu.phone
       FROM orders o JOIN clubs c ON c.id = o.club_id JOIN bookings b ON b.id = o.booking_id
       JOIN tee_times t ON t.id = b.tee_time_id LEFT JOIN customers cu ON cu.id = o.customer_id
      WHERE o.id = $1`,
    [orderId],
  );
  const lines = await q.query(
    `SELECT position, sku, label, quantity, unit_amount_minor AS "unitAmountMinor", total_minor AS "totalMinor",
            tax_rate_bp AS "taxRateBp", tax_minor AS "taxMinor"
       FROM order_lines WHERE order_id = $1 ORDER BY position`,
    [orderId],
  );
  return {
    orderId: o.id, version: o.version, reference: o.reference, clubId: o.clubId, clubCode: o.clubCode,
    currency: o.currency, pricesIncludeTax: o.pricesIncludeTax, status: o.status, bookingId: o.bookingId,
    teeTimeStartsAt: o.startsAt.toISOString(),
    customer: o.customerId ? {
      id: o.customerId, externalId: await externalId(q, provider, 'customer', o.customerId),
      firstName: o.firstName, lastName: o.lastName, email: o.email, phone: o.phone,
    } : null,
    lines: lines.rows, totalMinor: o.totalMinor, taxMinor: o.taxMinor,
  };
}

type Outcome = { kind: 'done'; result: PosResult } | { kind: 'superseded' };

async function execute(db: Db, job: Job, connector: PosConnector): Promise<Outcome> {
  const ctxFor = async (type: string, id: string) => ({
    idempotencyKey: job.idempotencyKey,
    existingExternalId: await externalId(db, job.provider, type, id),
  });

  if (job.operation === 'upsert_sale') {
    const { rows: [o] } = await db.query('SELECT version FROM orders WHERE id = $1', [job.entityId]);
    if (o.version > job.entityVersion) return { kind: 'superseded' }; // une version plus récente est en file
    return { kind: 'done', result: await connector.upsertSale(await buildSale(db, job.entityId, job.provider), await ctxFor('order', job.entityId)) };
  }

  const table = job.operation === 'record_payment' ? 'payments' : 'refunds';
  const { rows: [m] } = await db.query(
    `SELECT m.id, m.order_id AS "orderId", m.amount_minor AS "amountMinor", m.currency, m.method, m.confirmed_at AS "confirmedAt"
            ${table === 'refunds' ? ', m.reason, m.payment_id AS "paymentId"' : ''}
       FROM ${table} m WHERE m.id = $1 AND m.status = 'confirmed'`,
    [job.entityId],
  );
  if (!m) throw new PosError('Mouvement introuvable ou non confirmé.', false);
  const saleExternalId = await externalId(db, job.provider, 'order', m.orderId);
  // La vente doit exister chez le fournisseur avant son règlement.
  if (!saleExternalId) throw new PosError('Vente pas encore synchronisée : nouvel essai plus tard.', true);

  if (job.operation === 'record_payment') {
    if (!connector.recordPayment) return { kind: 'superseded' }; // fonction non proposée par le fournisseur
    return { kind: 'done', result: await connector.recordPayment({
      paymentId: m.id, orderId: m.orderId, saleExternalId, amountMinor: m.amountMinor, currency: m.currency,
      method: m.method, confirmedAt: m.confirmedAt.toISOString(),
    }, await ctxFor('payment', m.id)) };
  }
  if (!connector.recordRefund) return { kind: 'superseded' };
  return { kind: 'done', result: await connector.recordRefund({
    refundId: m.id, orderId: m.orderId, saleExternalId,
    paymentExternalId: m.paymentId ? await externalId(db, job.provider, 'payment', m.paymentId) : null,
    amountMinor: m.amountMinor, currency: m.currency, method: m.method, reason: m.reason, confirmedAt: m.confirmedAt.toISOString(),
  }, await ctxFor('refund', m.id)) };
}

async function finish(tx: Tx, job: Job, status: string, fields: { error?: string | null; externalId?: string | null; nextAttemptAt?: Date }, durationMs: number, now: Date) {
  await tx.query(
    `UPDATE pos_sync_jobs SET status = $2, last_error = $3, external_id = coalesce($4, external_id),
            next_attempt_at = coalesce($5, next_attempt_at), updated_at = $6
      WHERE id = $1`,
    [job.id, status, fields.error ?? null, fields.externalId ?? null, fields.nextAttemptAt ?? null, now],
  );
  await tx.query(
    `INSERT INTO pos_sync_log (job_id, attempt, success, error, duration_ms) VALUES ($1, $2, $3, $4, $5)`,
    [job.id, job.attempts, status === 'succeeded' || status === 'superseded', fields.error ?? null, durationMs],
  );
}

export interface ProcessReport { processed: number; succeeded: number; failed: number; dead: number; superseded: number }

/** Traite les travaux dus. Peut être appelé en boucle par un minuteur ou à la demande. */
export async function processPosJobs(
  db: Db, registry: PosRegistry, now: Date = new Date(), opts: { limit?: number; clubId?: string } = {},
): Promise<ProcessReport> {
  const report: ProcessReport = { processed: 0, succeeded: 0, failed: 0, dead: 0, superseded: 0 };
  for (const job of await claimJobs(db, now, opts.limit ?? 20, opts.clubId ?? null)) {
    report.processed++;
    const started = Date.now();
    const connector = registry.get(job.provider);
    try {
      if (!connector) throw new PosError(`Connecteur POS « ${job.provider} » non installé.`, false);
      const outcome = await execute(db, job, connector);
      await withTransaction(db, async (tx) => {
        if (outcome.kind === 'superseded') {
          await finish(tx, job, 'superseded', {}, Date.now() - started, now);
          report.superseded++;
          return;
        }
        await tx.query(
          `INSERT INTO external_refs (club_id, provider, entity_type, entity_id, external_id, data, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (provider, entity_type, entity_id)
           DO UPDATE SET external_id = EXCLUDED.external_id, data = EXCLUDED.data, synced_at = EXCLUDED.synced_at`,
          [job.clubId, job.provider, job.entityType, job.entityId, outcome.result.externalId, outcome.result.data ?? {}, now],
        );
        await finish(tx, job, 'succeeded', { externalId: outcome.result.externalId }, Date.now() - started, now);
        report.succeeded++;
      });
    } catch (err) {
      const retryable = err instanceof PosError ? err.retryable : true; // erreur inattendue : on réessaie
      const dead = !retryable || job.attempts >= job.maxAttempts;
      const message = (err as Error).message?.slice(0, 1000) ?? String(err);
      await withTransaction(db, (tx) => finish(tx, job, dead ? 'dead' : 'failed', {
        error: message, nextAttemptAt: new Date(now.getTime() + backoffMs(job.attempts)),
      }, Date.now() - started, now));
      if (dead) report.dead++; else report.failed++;
    }
  }
  return report;
}

/** Remet un travail en échec définitif dans la file (après correction). */
export async function retryPosJob(db: Db, clubId: string, jobId: string, now: Date = new Date()): Promise<boolean> {
  const res = await db.query(
    `UPDATE pos_sync_jobs SET status = 'pending', attempts = 0, next_attempt_at = $3, updated_at = $3
      WHERE id = $1 AND club_id = $2 AND status IN ('failed', 'dead')`,
    [jobId, clubId, now],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listPosJobs(q: Queryable, clubId: string, status?: string) {
  const { rows } = await q.query(
    `SELECT j.id, j.provider, j.operation, j.entity_type AS "entityType", j.entity_id AS "entityId",
            j.entity_version AS "entityVersion", j.status, j.attempts, j.max_attempts AS "maxAttempts",
            j.next_attempt_at AS "nextAttemptAt", j.last_error AS "lastError", j.external_id AS "externalId",
            j.created_at AS "createdAt", j.updated_at AS "updatedAt", o.reference
       FROM pos_sync_jobs j
       LEFT JOIN orders o ON o.id = CASE j.entity_type WHEN 'order' THEN j.entity_id
            WHEN 'payment' THEN (SELECT order_id FROM payments WHERE id = j.entity_id)
            ELSE (SELECT order_id FROM refunds WHERE id = j.entity_id) END
      WHERE j.club_id = $1 AND ($2::text IS NULL OR j.status = $2)
      ORDER BY j.created_at DESC LIMIT 200`,
    [clubId, status ?? null],
  );
  const counts = await q.query(
    `SELECT status, count(*)::int AS n FROM pos_sync_jobs WHERE club_id = $1 GROUP BY status`,
    [clubId],
  );
  return { jobs: rows, counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])) };
}
