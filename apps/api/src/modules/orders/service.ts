// Commandes : ce qui est dû pour une réservation, et son règlement.
//
// - La commande suit la réservation : ses lignes sont recopiées des lignes de
//   prix (booking_charges) à chaque recalcul, ou remplacées par des frais
//   d'annulation si la réservation est annulée.
// - Payé = paiements CONFIRMÉS − remboursements CONFIRMÉS. Un paiement en
//   attente (ex. paiement en ligne initié) ne compte jamais.
// - Toute évolution est historisée et, si le golf a un POS, mise en file de
//   synchronisation dans la même transaction.

import type { Db, Queryable, Tx } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { audit, type Actor } from '../../shared/audit.js';
import { DomainError } from '../../shared/errors.js';
import { getClub } from '../catalog/repository.js';
import { enqueuePosJob } from '../pos-sync/enqueue.js';

export type PaymentMethod = 'cash' | 'card_terminal' | 'bank_transfer' | 'online' | 'pos' | 'other';
export type PaymentStatus = 'nothing_due' | 'unpaid' | 'partially_paid' | 'paid' | 'refund_due';

export interface OrderSummary {
  orderId: string;
  status: 'open' | 'cancelled';
  currency: string;
  totalMinor: number;
  paidMinor: number; // confirmés − remboursés
  balanceMinor: number; // > 0 : reste dû ; < 0 : à rembourser
  pendingMinor: number; // paiements en attente de confirmation (non comptés)
  paymentStatus: PaymentStatus;
}

export function paymentStatusOf(totalMinor: number, paidMinor: number): PaymentStatus {
  if (paidMinor > totalMinor) return 'refund_due';
  if (totalMinor === 0) return 'nothing_due';
  if (paidMinor === 0) return 'unpaid';
  return paidMinor < totalMinor ? 'partially_paid' : 'paid';
}

function skuOf(kind: string, holes: number, resourceCode: string | null): string {
  switch (kind) {
    case 'green_fee': return `GREEN_FEE_${holes}`;
    case 'caddie': return 'CADDIE';
    case 'private_surcharge': return 'PRIVATE_SURCHARGE';
    case 'cancellation_fee': return 'CANCELLATION_FEE';
    default: return resourceCode ?? 'RESOURCE';
  }
}

interface LineSnapshot {
  kind: string; sku: string; label: string; quantity: number; unitAmountMinor: number;
  totalMinor: number; taxRateBp: number; taxMinor: number; payable: string;
}

/**
 * Aligne la commande d'une réservation sur ses lignes de prix. Crée la
 * commande si besoin. N'incrémente la version (et ne met en file le POS) que
 * si les lignes ou le statut changent.
 */
export async function syncOrder(tx: Tx, bookingId: string): Promise<void> {
  const { rows: [b] } = await tx.query(
    `SELECT b.id, b.club_id AS "clubId", b.customer_id AS "customerId", b.reference, b.status, b.holes,
            b.cancellation_fee_minor AS "cancellationFeeMinor", coalesce(b.currency, c.currency) AS currency,
            c.tax_rate_bp AS "taxRateBp", c.prices_include_tax AS "pricesIncludeTax", c.pos_provider AS "posProvider"
       FROM bookings b JOIN clubs c ON c.id = b.club_id WHERE b.id = $1`,
    [bookingId],
  );
  if (!b) return;

  let lines: LineSnapshot[];
  if (b.status === 'cancelled') {
    const fee = b.cancellationFeeMinor ?? 0;
    const tax = b.pricesIncludeTax ? Math.round((fee * b.taxRateBp) / (10_000 + b.taxRateBp)) : Math.round((fee * b.taxRateBp) / 10_000);
    lines = fee > 0 ? [{ kind: 'cancellation_fee', sku: 'CANCELLATION_FEE', label: "Frais d'annulation", quantity: 1,
      unitAmountMinor: fee, totalMinor: b.pricesIncludeTax ? fee : fee + tax, taxRateBp: b.taxRateBp, taxMinor: tax, payable: 'with_booking' }] : [];
  } else {
    const { rows } = await tx.query(
      `SELECT bc.kind, bc.label, bc.quantity, bc.unit_amount_minor AS "unitAmountMinor", bc.total_minor AS "totalMinor",
              bc.tax_rate_bp AS "taxRateBp", bc.tax_minor AS "taxMinor", bc.payable, rt.code AS "resourceCode"
         FROM booking_charges bc LEFT JOIN resource_types rt ON rt.id = bc.resource_type_id
        WHERE bc.booking_id = $1 ORDER BY bc.position`,
      [bookingId],
    );
    lines = rows.map(({ resourceCode, ...l }) => ({ ...l, sku: skuOf(l.kind, b.holes, resourceCode) }));
  }
  const status = b.status === 'cancelled' ? 'cancelled' : 'open';
  const total = lines.reduce((n, l) => n + l.totalMinor, 0);
  const tax = lines.reduce((n, l) => n + l.taxMinor, 0);

  const existing = await tx.query('SELECT id, status, version FROM orders WHERE booking_id = $1 FOR UPDATE', [bookingId]);
  let orderId: string;
  let version: number;
  if (!existing.rows[0]) {
    const ins = await tx.query(
      `INSERT INTO orders (club_id, booking_id, customer_id, reference, currency, status, total_minor, tax_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, version`,
      [b.clubId, bookingId, b.customerId, b.reference, b.currency, status, total, tax],
    );
    orderId = ins.rows[0].id;
    version = ins.rows[0].version;
  } else {
    orderId = existing.rows[0].id;
    const current = await tx.query(
      `SELECT kind, sku, label, quantity, unit_amount_minor AS "unitAmountMinor", total_minor AS "totalMinor",
              tax_rate_bp AS "taxRateBp", tax_minor AS "taxMinor", payable
         FROM order_lines WHERE order_id = $1 ORDER BY position`,
      [orderId],
    );
    const unchanged = existing.rows[0].status === status && JSON.stringify(current.rows) === JSON.stringify(lines);
    if (unchanged) return;
    const upd = await tx.query(
      `UPDATE orders SET status = $2, total_minor = $3, tax_minor = $4, customer_id = $5, version = version + 1, updated_at = now()
        WHERE id = $1 RETURNING version`,
      [orderId, status, total, tax, b.customerId],
    );
    version = upd.rows[0].version;
    await tx.query('DELETE FROM order_lines WHERE order_id = $1', [orderId]);
  }
  for (const [i, l] of lines.entries()) {
    await tx.query(
      `INSERT INTO order_lines (order_id, position, kind, sku, label, quantity, unit_amount_minor, total_minor, tax_rate_bp, tax_minor, payable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [orderId, i + 1, l.kind, l.sku, l.label, l.quantity, l.unitAmountMinor, l.totalMinor, l.taxRateBp, l.taxMinor, l.payable],
    );
  }
  await enqueuePosJob(tx, { clubId: b.clubId, provider: b.posProvider, operation: 'upsert_sale', entityType: 'order', entityId: orderId, entityVersion: version });
}

export async function syncOrders(tx: Tx, bookingIds: Iterable<string>): Promise<void> {
  for (const id of bookingIds) await syncOrder(tx, id);
}

export async function orderSummary(q: Queryable, orderId: string): Promise<OrderSummary> {
  const { rows: [o] } = await q.query(
    `SELECT o.id, o.status, o.currency, o.total_minor AS total,
            coalesce((SELECT sum(amount_minor) FROM payments WHERE order_id = o.id AND status = 'confirmed'), 0)::int AS paid,
            coalesce((SELECT sum(amount_minor) FROM refunds WHERE order_id = o.id AND status = 'confirmed'), 0)::int AS refunded,
            coalesce((SELECT sum(amount_minor) FROM payments WHERE order_id = o.id AND status = 'pending'), 0)::int AS pending
       FROM orders o WHERE o.id = $1`,
    [orderId],
  );
  if (!o) throw new DomainError('NOT_FOUND', 'Commande introuvable.');
  const paid = o.paid - o.refunded;
  return {
    orderId: o.id, status: o.status, currency: o.currency, totalMinor: o.total, paidMinor: paid,
    balanceMinor: o.total - paid, pendingMinor: o.pending, paymentStatus: paymentStatusOf(o.total, paid),
  };
}

async function orderIdForBooking(q: Queryable, bookingId: string): Promise<string> {
  const { rows } = await q.query('SELECT id FROM orders WHERE booking_id = $1', [bookingId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Commande introuvable pour cette réservation.');
  return rows[0].id;
}

/** Détail complet pour l'écran de réservation. */
export async function getBookingOrder(q: Queryable, bookingId: string) {
  const orderId = await orderIdForBooking(q, bookingId);
  const [summary, lines, payments, refunds, refs] = await Promise.all([
    orderSummary(q, orderId),
    q.query(`SELECT position, kind, sku, label, quantity, unit_amount_minor AS "unitAmountMinor", total_minor AS "totalMinor",
                    tax_minor AS "taxMinor", payable FROM order_lines WHERE order_id = $1 ORDER BY position`, [orderId]),
    q.query(`SELECT p.id, p.amount_minor AS "amountMinor", p.method, p.status, p.source, p.note, p.created_at AS "createdAt",
                    p.confirmed_at AS "confirmedAt", u.display_name AS "recordedBy"
               FROM payments p LEFT JOIN users u ON u.id = p.recorded_by WHERE p.order_id = $1 ORDER BY p.created_at`, [orderId]),
    q.query(`SELECT r.id, r.amount_minor AS "amountMinor", r.method, r.status, r.reason, r.created_at AS "createdAt",
                    u.display_name AS "recordedBy"
               FROM refunds r LEFT JOIN users u ON u.id = r.recorded_by WHERE r.order_id = $1 ORDER BY r.created_at`, [orderId]),
    q.query(`SELECT provider, external_id AS "externalId", synced_at AS "syncedAt" FROM external_refs
              WHERE entity_type = 'order' AND entity_id = $1`, [orderId]),
  ]);
  return { ...summary, lines: lines.rows, payments: payments.rows, refunds: refunds.rows, externalRefs: refs.rows };
}

async function lockOrder(tx: Tx, orderId: string) {
  const { rows } = await tx.query(
    `SELECT o.id, o.club_id AS "clubId", o.currency, c.pos_provider AS "posProvider"
       FROM orders o JOIN clubs c ON c.id = o.club_id WHERE o.id = $1 FOR UPDATE OF o`,
    [orderId],
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Commande introuvable.');
  return rows[0] as { id: string; clubId: string; currency: string; posProvider: string | null };
}

function isUnique(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === constraint;
}

/**
 * Encaissement constaté par le personnel (espèces, TPE, virement reçu…) :
 * c'est une confirmation fiable, le paiement est donc « confirmé ».
 * Les paiements en ligne ne passent JAMAIS par ici (voir createPendingPayment).
 */
export async function recordStaffPayment(
  db: Db,
  bookingId: string,
  input: { amountMinor: number; method: Exclude<PaymentMethod, 'online' | 'pos'>; note?: string | null; idempotencyKey?: string | null },
  actor: Actor,
): Promise<OrderSummary> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new DomainError('VALIDATION', 'Montant invalide.');
  const orderId = await orderIdForBooking(db, bookingId);
  try {
    await withTransaction(db, async (tx) => {
      const order = await lockOrder(tx, orderId);
      const s = await orderSummary(tx, orderId);
      if (input.amountMinor > s.balanceMinor) {
        throw new DomainError('VALIDATION', `Montant supérieur au reste dû (${s.balanceMinor / 100} ${s.currency}).`, { balanceMinor: s.balanceMinor });
      }
      const { rows } = await tx.query(
        `INSERT INTO payments (club_id, order_id, amount_minor, currency, method, status, source, note, idempotency_key, recorded_by, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, 'confirmed', 'staff', $6, $7, $8, now()) RETURNING id`,
        [order.clubId, orderId, input.amountMinor, order.currency, input.method, input.note ?? null, input.idempotencyKey ?? null, actor.id ?? null],
      );
      await enqueuePosJob(tx, { clubId: order.clubId, provider: order.posProvider, operation: 'record_payment', entityType: 'payment', entityId: rows[0].id });
      await audit(tx, { clubId: order.clubId, actor, action: 'payment.recorded', entityType: 'booking', entityId: bookingId,
        data: { paymentId: rows[0].id, amountMinor: input.amountMinor, method: input.method } });
    });
  } catch (err) {
    if (!isUnique(err, 'payments_club_id_idempotency_key_key')) throw err; // rejeu : déjà enregistré
  }
  return orderSummary(db, orderId);
}

/** Remboursement effectué par le personnel. Plafonné au montant net payé. */
export async function recordStaffRefund(
  db: Db,
  bookingId: string,
  input: { amountMinor: number; method: Exclude<PaymentMethod, 'online' | 'pos'>; reason?: string | null; paymentId?: string | null; idempotencyKey?: string | null },
  actor: Actor,
): Promise<OrderSummary> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new DomainError('VALIDATION', 'Montant invalide.');
  const orderId = await orderIdForBooking(db, bookingId);
  try {
    await withTransaction(db, async (tx) => {
      const order = await lockOrder(tx, orderId);
      const s = await orderSummary(tx, orderId);
      if (input.amountMinor > s.paidMinor) {
        throw new DomainError('VALIDATION', `Montant supérieur au montant payé (${s.paidMinor / 100} ${s.currency}).`);
      }
      if (input.paymentId) {
        const p = await tx.query(`SELECT 1 FROM payments WHERE id = $1 AND order_id = $2 AND status = 'confirmed'`, [input.paymentId, orderId]);
        if (!p.rowCount) throw new DomainError('VALIDATION', 'Paiement d’origine introuvable.');
      }
      const { rows } = await tx.query(
        `INSERT INTO refunds (club_id, order_id, payment_id, amount_minor, currency, method, status, source, reason, idempotency_key, recorded_by, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', 'staff', $7, $8, $9, now()) RETURNING id`,
        [order.clubId, orderId, input.paymentId ?? null, input.amountMinor, order.currency, input.method, input.reason ?? null,
          input.idempotencyKey ?? null, actor.id ?? null],
      );
      await enqueuePosJob(tx, { clubId: order.clubId, provider: order.posProvider, operation: 'record_refund', entityType: 'refund', entityId: rows[0].id });
      await audit(tx, { clubId: order.clubId, actor, action: 'refund.recorded', entityType: 'booking', entityId: bookingId,
        data: { refundId: rows[0].id, amountMinor: input.amountMinor, method: input.method } });
    });
  } catch (err) {
    if (!isUnique(err, 'refunds_club_id_idempotency_key_key')) throw err;
  }
  return orderSummary(db, orderId);
}

// ---------------------------------------------------------------------------
// Paiement par un prestataire externe (en ligne, POS) — pour le futur
// connecteur. Le paiement reste « pending » tant que le prestataire ne l'a
// pas confirmé par un canal fiable (notification signée, API interrogée).

export async function createPendingPayment(
  db: Db,
  bookingId: string,
  input: { amountMinor: number; method: 'online' | 'pos'; provider: string; externalId?: string | null; idempotencyKey: string },
): Promise<string> {
  const orderId = await orderIdForBooking(db, bookingId);
  return withTransaction(db, async (tx) => {
    const order = await lockOrder(tx, orderId);
    const existing = await tx.query('SELECT id FROM payments WHERE club_id = $1 AND idempotency_key = $2', [order.clubId, input.idempotencyKey]);
    if (existing.rows[0]) return existing.rows[0].id;
    const { rows } = await tx.query(
      `INSERT INTO payments (club_id, order_id, amount_minor, currency, method, status, source, provider, external_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9) RETURNING id`,
      [order.clubId, orderId, input.amountMinor, order.currency, input.method, input.method === 'pos' ? 'pos' : 'psp',
        input.provider, input.externalId ?? null, input.idempotencyKey],
    );
    return rows[0].id;
  });
}

/** Confirmation (ou échec) reçue du prestataire. Idempotent. */
export async function settleProviderPayment(
  db: Db,
  input: { provider: string; externalId: string; outcome: 'confirmed' | 'failed'; amountMinor: number; currency: string },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const { rows: [p] } = await tx.query(
      `SELECT p.id, p.status, p.amount_minor AS "amountMinor", p.currency, p.club_id AS "clubId", o.booking_id AS "bookingId"
         FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.provider = $1 AND p.external_id = $2 FOR UPDATE OF p`,
      [input.provider, input.externalId],
    );
    if (!p) throw new DomainError('NOT_FOUND', 'Paiement inconnu.');
    if (p.status !== 'pending') return; // déjà traité : rejeu de la notification
    // Montant et devise doivent correspondre exactement à ce qui a été demandé.
    if (input.outcome === 'confirmed' && (input.amountMinor !== p.amountMinor || input.currency !== p.currency)) {
      throw new DomainError('VALIDATION', 'Montant ou devise confirmés différents du paiement demandé.');
    }
    await tx.query(
      `UPDATE payments SET status = $2, confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() END WHERE id = $1`,
      [p.id, input.outcome],
    );
    await audit(tx, { clubId: p.clubId, actor: { type: 'system' }, action: `payment.${input.outcome}`, entityType: 'booking',
      entityId: p.bookingId, data: { paymentId: p.id, provider: input.provider } });
  });
}
