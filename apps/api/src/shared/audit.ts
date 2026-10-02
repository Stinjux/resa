import type { Queryable } from '../db/pool.js';

export interface Actor {
  type: 'user' | 'customer' | 'system';
  id?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system' };

/** Ancienne et nouvelle valeur d'un champ modifié. */
export type Change = { from: unknown; to: unknown };

/** Ne garde que les champs réellement modifiés. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, Change> {
  const out: Record<string, Change> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}

/**
 * Historique des changements importants, écrit dans la MÊME transaction que
 * l'opération (pas d'opération sans trace, pas de trace sans opération).
 * La table est en lecture seule une fois écrite (trigger en base).
 * Ne jamais y copier de données personnelles ni bancaires : identifiants,
 * références et valeurs métier uniquement.
 * refs : autres éléments concernés (réservations d'un départ partagé, unité,
 * caddie…) pour retrouver l'événement depuis chacun d'eux.
 */
export async function audit(
  q: Queryable,
  entry: {
    clubId: string | null; actor: Actor; action: string; entityType: string; entityId: string | null; data?: object;
    refs?: Array<string | null | undefined>; reason?: string | null;
  },
): Promise<void> {
  const refs = [...new Set((entry.refs ?? []).filter((r): r is string => !!r && r !== entry.entityId))];
  await q.query(
    `INSERT INTO audit_log (club_id, actor_type, actor_id, action, entity_type, entity_id, data, refs, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [entry.clubId, entry.actor.type, entry.actor.id ?? null, entry.action, entry.entityType, entry.entityId, entry.data ?? {},
      refs, entry.reason?.trim() || null],
  );
}
