// Abonnement actif d'un golfeur sur un golf à une date donnée (séparé du
// service Membres pour être utilisé par la réservation sans dépendance circulaire).

import type { Queryable } from '../../db/pool.js';

export interface ActiveMembership {
  id: string; planId: string; planName: string; priceCategory: string; bookingHorizonDays: number; cardNumber: string | null;
  validTo: string;
}

export async function activeMembership(q: Queryable, clubId: string, customerId: string, localDate: string): Promise<ActiveMembership | null> {
  const { rows } = await q.query(
    `SELECT m.id, m.plan_id AS "planId", p.name AS "planName", p.price_category AS "priceCategory",
            p.booking_horizon_days AS "bookingHorizonDays", m.card_number AS "cardNumber", to_char(m.valid_to, 'YYYY-MM-DD') AS "validTo"
       FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
      WHERE m.club_id = $1 AND m.customer_id = $2 AND m.status = 'active' AND p.active
        AND $3::date BETWEEN m.valid_from AND m.valid_to
      ORDER BY p.booking_horizon_days DESC LIMIT 1`,
    [clubId, customerId, localDate],
  );
  return rows[0] ?? null;
}
