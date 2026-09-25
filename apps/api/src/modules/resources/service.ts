// Disponibilité et allocation des ressources (caddies, voiturettes, chariots,
// sacs). Toute allocation passe par reserve(), appelée APRÈS lockResourceTypes()
// dans la même transaction : le verrou consultatif par type de ressource
// sérialise les vérifications de capacité concurrentes.

import type { Queryable, Tx } from '../../db/pool.js';
import { available, type Usage } from '../../domain/resource-usage.js';
import { DomainError } from '../../shared/errors.js';
import type { ResourceType } from '../catalog/repository.js';

/** Verrouille les types de ressources dans un ordre déterministe (évite les
 *  interblocages). Les verrous tiennent jusqu'à la fin de la transaction. */
export async function lockResourceTypes(tx: Tx, resourceTypeIds: string[]): Promise<void> {
  const ids = [...new Set(resourceTypeIds)].sort();
  for (const id of ids) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('resource_type:' || $1, 0))`, [id]);
  }
}

export async function capacityOn(q: Queryable, rt: ResourceType, date: string): Promise<number> {
  const { rows } = await q.query(
    'SELECT quantity FROM resource_capacity_overrides WHERE resource_type_id = $1 AND date = $2',
    [rt.id, date],
  );
  return rows[0]?.quantity ?? rt.totalQuantity;
}

export async function activeUsages(q: Queryable, resourceTypeId: string, start: Date, end: Date): Promise<Usage[]> {
  const { rows } = await q.query(
    `SELECT lower(period) AS start, upper(period) AS end, quantity
       FROM resource_allocations
      WHERE resource_type_id = $1 AND status = 'active' AND period && tstzrange($2, $3, '[)')`,
    [resourceTypeId, start, end],
  );
  return rows.map((r) => ({ start: r.start.getTime(), end: r.end.getTime(), quantity: r.quantity }));
}

export async function availableQuantity(
  q: Queryable,
  rt: ResourceType,
  date: string,
  start: Date,
  end: Date,
): Promise<number> {
  const [capacity, usages] = await Promise.all([capacityOn(q, rt, date), activeUsages(q, rt.id, start, end)]);
  return available(capacity, usages, start.getTime(), end.getTime());
}

export interface ReserveInput {
  resourceType: ResourceType;
  clubId: string;
  date: string; // date locale du départ (pour les exceptions de capacité)
  start: Date;
  end: Date;
  quantity: number;
  teeTimeId?: string;
  bookingId?: string;
}

/** Vérifie la disponibilité puis crée l'allocation. Le type doit être verrouillé. */
export async function reserve(tx: Tx, input: ReserveInput): Promise<string> {
  const { resourceType: rt } = input;
  const free = await availableQuantity(tx, rt, input.date, input.start, input.end);
  if (input.quantity > free) {
    const isCaddie = rt.kind === 'caddie';
    throw new DomainError(
      isCaddie ? 'CADDIE_UNAVAILABLE' : 'RESOURCE_UNAVAILABLE',
      isCaddie
        ? 'Aucun caddie disponible pour ce départ.'
        : `${rt.name} : ${free} disponible(s), ${input.quantity} demandé(s).`,
      { resourceTypeId: rt.id, code: rt.code, available: free, requested: input.quantity },
    );
  }
  const { rows } = await tx.query(
    `INSERT INTO resource_allocations (club_id, resource_type_id, tee_time_id, booking_id, quantity, period)
     VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7, '[)')) RETURNING id`,
    [input.clubId, rt.id, input.teeTimeId ?? null, input.bookingId ?? null, input.quantity, input.start, input.end],
  );
  return rows[0].id;
}

export async function releaseBookingAllocations(tx: Tx, bookingId: string): Promise<number> {
  const res = await tx.query(
    `UPDATE resource_allocations SET status = 'released', released_at = now()
      WHERE booking_id = $1 AND status = 'active'`,
    [bookingId],
  );
  return res.rowCount ?? 0;
}

export async function releaseTeeTimeAllocations(tx: Tx, teeTimeId: string): Promise<number> {
  const res = await tx.query(
    `UPDATE resource_allocations SET status = 'released', released_at = now()
      WHERE tee_time_id = $1 AND status = 'active'`,
    [teeTimeId],
  );
  return res.rowCount ?? 0;
}
