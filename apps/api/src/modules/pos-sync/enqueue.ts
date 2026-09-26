// Ajout d'un travail de synchronisation POS dans la transaction courante
// (outbox) : si la transaction échoue, rien n'est envoyé ; si elle réussit,
// le travail sera traité, même après un redémarrage.

import type { Tx } from '../../db/pool.js';

export async function enqueuePosJob(
  tx: Tx,
  job: {
    clubId: string;
    provider: string | null;
    operation: 'upsert_sale' | 'record_payment' | 'record_refund';
    entityType: 'order' | 'payment' | 'refund';
    entityId: string;
    entityVersion?: number;
  },
): Promise<void> {
  if (!job.provider) return; // golf sans POS
  const version = job.entityVersion ?? 1;
  await tx.query(
    `INSERT INTO pos_sync_jobs (club_id, provider, operation, entity_type, entity_id, entity_version, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (idempotency_key) DO NOTHING`,
    [job.clubId, job.provider, job.operation, job.entityType, job.entityId, version,
      `${job.provider}:${job.operation}:${job.entityId}:v${version}`],
  );
}
