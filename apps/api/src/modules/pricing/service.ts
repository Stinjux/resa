// Tarification appliquée : charge la configuration du golf et délègue le
// calcul au domaine (domain/pricing.ts). Aucun lien avec un POS.

import type { Queryable, Tx } from '../../db/pool.js';
import { buildQuote, selectTariff, type Payable, type Quote } from '../../domain/pricing.js';
import type { Holes } from '../../domain/tee-time-rules.js';
import { instantToLocal, isoWeekday } from '../../shared/time.js';
import { listResourceTypes, listTariffs, type Club, type Course, type ResourceType } from '../catalog/repository.js';

export interface QuoteRequest {
  club: Club;
  course: Course;
  startsAt: Date;
  players: number;
  holes: Holes;
  isPrivate: boolean;
  customerCategory: string;
  caddiePayment: Payable;
  options: Array<{ resourceTypeId: string; quantity: number }>;
}

export async function quote(q: Queryable, req: QuoteRequest, preloaded?: { resourceTypes?: ResourceType[] }): Promise<Quote> {
  const [tariffs, resourceTypes] = await Promise.all([
    listTariffs(q, req.club.id),
    preloaded?.resourceTypes ?? listResourceTypes(q, req.club.id, { activeOnly: false }),
  ]);
  const local = instantToLocal(req.startsAt, req.club.timezone);
  const ctx = {
    courseId: req.course.id,
    holes: req.holes,
    customerCategory: req.customerCategory,
    date: local.date,
    isoWeekday: isoWeekday(local.date),
    minuteOfDay: local.minuteOfDay,
  };
  const caddie = resourceTypes.find((rt) => rt.active && rt.scope === 'tee_time' && rt.requiredPerTeeTime) ?? null;
  return buildQuote({
    currency: req.club.currency,
    taxRateBp: req.club.taxRateBp,
    pricesIncludeTax: req.club.pricesIncludeTax,
    players: req.players,
    holes: req.holes,
    isPrivate: req.isPrivate,
    greenFee: selectTariff(tariffs, { ...ctx, product: 'green_fee' }),
    privateSurcharge: selectTariff(tariffs, { ...ctx, product: 'private_surcharge' }),
    caddie: caddie && { resourceTypeId: caddie.id, label: caddie.name, price9Minor: caddie.price9Minor, price18Minor: caddie.price18Minor },
    caddiePayment: req.caddiePayment,
    options: req.options.map((o) => {
      const rt = resourceTypes.find((r) => r.id === o.resourceTypeId)!;
      return { resourceTypeId: rt.id, label: rt.name, quantity: o.quantity, price9Minor: rt.price9Minor, price18Minor: rt.price18Minor };
    }),
  });
}

/** Remplace les lignes de prix d'une réservation par un calcul à jour et
 *  met à jour ses totaux. À appeler dans la transaction qui la modifie. */
export async function recomputeCharges(tx: Tx, bookingId: string, club: Club, course: Course): Promise<Quote> {
  const { rows } = await tx.query(
    `SELECT b.players, b.holes, b.is_private AS "isPrivate", b.customer_category AS "customerCategory",
            b.caddie_payment AS "caddiePayment", t.starts_at AS "startsAt"
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id WHERE b.id = $1`,
    [bookingId],
  );
  const b = rows[0];
  const options = await tx.query(
    `SELECT resource_type_id AS "resourceTypeId", sum(quantity)::int AS quantity
       FROM resource_allocations WHERE booking_id = $1 AND status = 'active' GROUP BY resource_type_id`,
    [bookingId],
  );
  const result = await quote(tx, { club, course, ...b, options: options.rows });

  await tx.query('DELETE FROM booking_charges WHERE booking_id = $1', [bookingId]);
  for (const [i, l] of result.lines.entries()) {
    await tx.query(
      `INSERT INTO booking_charges (booking_id, position, kind, tariff_id, resource_type_id, label, quantity,
                                    unit_amount_minor, total_minor, tax_rate_bp, tax_minor, payable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [bookingId, i + 1, l.kind, l.tariffId, l.resourceTypeId, l.label, l.quantity, l.unitAmountMinor, l.totalMinor,
        l.taxRateBp, l.taxMinor, l.payable],
    );
  }
  await tx.query(
    `UPDATE bookings SET currency = $2, total_minor = $3, due_with_booking_minor = $4, due_on_site_minor = $5
      WHERE id = $1`,
    [bookingId, result.currency, result.totalMinor, result.dueWithBookingMinor, result.dueOnSiteMinor],
  );
  return result;
}
