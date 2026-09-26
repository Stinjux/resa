// Golfeurs vus par le personnel d'un golf : uniquement ceux qui ont (ou ont
// eu) une réservation dans CE golf. Les fiches sont partagées au niveau de
// l'organisation mais jamais exposées aux autres golfs.

import type { Queryable } from '../../db/pool.js';
import { DomainError } from '../../shared/errors.js';

const LINKED = `EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id AND b.club_id = $1)`;

export async function isCustomerVisibleToClub(q: Queryable, clubId: string, customerId: string): Promise<boolean> {
  const { rowCount } = await q.query(`SELECT 1 FROM customers c WHERE c.id = $2 AND ${LINKED}`, [clubId, customerId]);
  return (rowCount ?? 0) > 0;
}

export async function searchClubCustomers(q: Queryable, clubId: string, search: string | undefined) {
  const term = search?.trim() ? `%${search.trim().replace(/[%_\\]/g, '\\$&')}%` : null;
  const { rows } = await q.query(
    `SELECT c.id, c.first_name AS "firstName", c.last_name AS "lastName", c.email, c.phone
       FROM customers c
      WHERE ${LINKED}
        AND ($2::text IS NULL OR concat_ws(' ', c.first_name, c.last_name) ILIKE $2 OR c.email ILIKE $2 OR c.phone ILIKE $2)
      ORDER BY c.last_name, c.first_name LIMIT 50`,
    [clubId, term],
  );
  return rows;
}

export async function getClubCustomer(q: Queryable, clubId: string, customerId: string) {
  const { rows } = await q.query(
    `SELECT c.id, c.first_name AS "firstName", c.last_name AS "lastName", c.email, c.phone,
            c.preferred_locale AS "preferredLocale", c.created_at AS "createdAt"
       FROM customers c WHERE c.id = $2 AND ${LINKED}`,
    [clubId, customerId],
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Golfeur introuvable pour ce golf.');
  const bookings = await q.query(
    `SELECT b.id, b.reference, b.status, b.players, b.holes, t.starts_at AS "startsAt", b.total_minor AS "totalMinor", b.currency
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id
      WHERE b.customer_id = $2 AND b.club_id = $1 ORDER BY t.starts_at DESC LIMIT 100`,
    [clubId, customerId],
  );
  return { ...rows[0], bookings: bookings.rows };
}
