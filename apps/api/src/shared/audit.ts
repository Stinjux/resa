import type { Queryable } from '../db/pool.js';

export interface Actor {
  type: 'user' | 'customer' | 'system';
  id?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system' };

/** Historique des changements importants. Ne jamais y copier de données
 *  personnelles en clair : identifiants et valeurs métier uniquement. */
export async function audit(
  q: Queryable,
  entry: { clubId: string | null; actor: Actor; action: string; entityType: string; entityId: string | null; data?: object },
): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (club_id, actor_type, actor_id, action, entity_type, entity_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.clubId, entry.actor.type, entry.actor.id ?? null, entry.action, entry.entityType, entry.entityId, entry.data ?? {}],
  );
}
