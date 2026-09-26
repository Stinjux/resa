// Factures, avoirs, reçus et clôtures de caisse.
//
// - Numérotation continue et sans trou par golf, type et année : le compteur
//   est incrémenté dans la transaction qui crée le document (verrou de ligne),
//   une annulation de transaction n'en consomme donc aucun.
// - Une facture est immuable (vendeur, acheteur et lignes figés). On corrige
//   par un avoir qui l'annule entièrement, puis une nouvelle facture.
// - La clôture (ticket Z) regroupe tous les encaissements et remboursements
//   confirmés non encore clôturés ; elle compare les espèces attendues aux
//   espèces comptées.

import { DateTime } from 'luxon';
import type { Db, Queryable, Tx } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { audit, type Actor } from '../../shared/audit.js';
import { csvMoney, toCsv } from '../../shared/csv.js';
import { DomainError } from '../../shared/errors.js';
import { orderSummary } from '../orders/service.js';

type SequenceKind = 'invoice' | 'credit_note' | 'cash_closing';
const PREFIX: Record<SequenceKind, string> = { invoice: 'FA', credit_note: 'AV', cash_closing: 'Z' };

async function nextNumber(tx: Tx, club: { id: string; code: string; timezone: string }, kind: SequenceKind, at: Date): Promise<string> {
  const year = DateTime.fromJSDate(at, { zone: club.timezone }).year;
  const { rows } = await tx.query(
    `INSERT INTO document_sequences (club_id, kind, year, last_number) VALUES ($1, $2, $3, 1)
     ON CONFLICT (club_id, kind, year) DO UPDATE SET last_number = document_sequences.last_number + 1
     RETURNING last_number`,
    [club.id, kind, year],
  );
  return `${PREFIX[kind]}-${club.code}-${year}-${String(rows[0].last_number).padStart(5, '0')}`;
}

export interface Seller {
  name: string; legalName: string | null; address: string | null; ice: string | null; taxId: string | null;
  tradeRegister: string | null; patente: string | null; footer: string | null; phone: string | null; email: string | null;
}

interface ClubBilling extends Seller { id: string; code: string; timezone: string; currency: string; countryCode: string | null }

async function clubBilling(q: Queryable, clubId: string): Promise<ClubBilling> {
  const { rows } = await q.query(
    `SELECT id, code, timezone, currency, country_code AS "countryCode", name, legal_name AS "legalName", legal_address AS address,
            ice, tax_id AS "taxId", trade_register AS "tradeRegister", patente, invoice_footer AS footer,
            contact_phone AS phone, email_reply_to AS email
       FROM clubs WHERE id = $1`,
    [clubId],
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Golf introuvable.');
  return rows[0];
}

const sellerOf = ({ name, legalName, address, ice, taxId, tradeRegister, patente, footer, phone, email }: ClubBilling): Seller =>
  ({ name, legalName, address, ice, taxId, tradeRegister, patente, footer, phone, email });

function assertLegalInfo(c: ClubBilling) {
  const missing = [
    !c.legalName && 'raison sociale',
    !c.address && 'adresse',
    (c.countryCode ?? 'MA') === 'MA' && !c.ice && 'ICE',
  ].filter(Boolean);
  if (missing.length) {
    throw new DomainError('LEGAL_INFO_MISSING', `Mentions légales à compléter (Configuration → Général) : ${missing.join(', ')}.`, { missing });
  }
}

export interface InvoiceLine {
  label: string; quantity: number; unitHtMinor: number; totalHtMinor: number; taxRateBp: number; taxMinor: number; totalMinor: number;
}

export interface Buyer { name: string; address?: string | null; ice?: string | null }

// ---------------------------------------------------------------------------
// Factures

export async function issueInvoice(db: Db, bookingId: string, input: { buyer?: Partial<Buyer> | null }, actor: Actor) {
  const id = await withTransaction(db, async (tx) => {
    const { rows: [o] } = await tx.query(
      `SELECT o.id, o.club_id AS "clubId", o.currency, o.total_minor AS total, o.tax_minor AS tax,
              nullif(trim(coalesce(cu.first_name, '') || ' ' || coalesce(cu.last_name, '')), '') AS "customerName"
         FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id WHERE o.booking_id = $1 FOR UPDATE OF o`,
      [bookingId],
    );
    if (!o) throw new DomainError('NOT_FOUND', 'Commande introuvable pour cette réservation.');
    const club = await clubBilling(tx, o.clubId);
    assertLegalInfo(club);
    if (o.total <= 0) throw new DomainError('VALIDATION', 'Rien à facturer pour cette réservation.');
    const active = await tx.query(
      `SELECT i.number FROM invoices i WHERE i.order_id = $1 AND i.kind = 'invoice'
          AND NOT EXISTS (SELECT 1 FROM invoices a WHERE a.original_id = i.id)`,
      [o.id],
    );
    if (active.rows[0]) {
      throw new DomainError('INVOICE_EXISTS', `Facture ${active.rows[0].number} déjà émise : émettre un avoir pour la corriger.`);
    }
    const { rows: orderLines } = await tx.query(
      `SELECT label, quantity, total_minor AS "totalMinor", tax_rate_bp AS "taxRateBp", tax_minor AS "taxMinor"
         FROM order_lines WHERE order_id = $1 ORDER BY position`,
      [o.id],
    );
    const lines: InvoiceLine[] = orderLines.map((l) => {
      const ht = l.totalMinor - l.taxMinor;
      return { label: l.label, quantity: l.quantity, unitHtMinor: Math.round(ht / l.quantity), totalHtMinor: ht,
        taxRateBp: l.taxRateBp, taxMinor: l.taxMinor, totalMinor: l.totalMinor };
    });
    const name = input.buyer?.name?.trim() || o.customerName;
    if (!name) throw new DomainError('VALIDATION', 'Nom du client à indiquer sur la facture.');
    const buyer: Buyer = { name, address: input.buyer?.address?.trim() || null, ice: input.buyer?.ice?.trim() || null };
    const now = new Date();
    const number = await nextNumber(tx, club, 'invoice', now);
    const paid = (await orderSummary(tx, o.id)).paidMinor;
    const { rows } = await tx.query(
      `INSERT INTO invoices (club_id, order_id, booking_id, kind, number, issued_at, issued_by, seller, buyer, currency, lines,
                             total_ht_minor, tax_minor, total_minor, paid_minor)
       VALUES ($1, $2, $3, 'invoice', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [club.id, o.id, bookingId, number, now, actor.id ?? null, sellerOf(club), buyer, o.currency, JSON.stringify(lines),
        o.total - o.tax, o.tax, o.total, Math.max(0, Math.min(paid, o.total))],
    );
    await audit(tx, { clubId: club.id, actor, action: 'invoice.issued', entityType: 'invoice', entityId: rows[0].id,
      data: { number, bookingId, totalMinor: o.total } });
    return rows[0].id as string;
  });
  return getInvoice(db, id);
}

/** Avoir : annule entièrement une facture (montants négatifs). */
export async function issueCreditNote(db: Db, invoiceId: string, reason: string, actor: Actor) {
  if (!reason.trim()) throw new DomainError('VALIDATION', "Motif de l'avoir obligatoire.");
  const id = await withTransaction(db, async (tx) => {
    const { rows: [inv] } = await tx.query(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
    if (!inv) throw new DomainError('NOT_FOUND', 'Facture introuvable.');
    if (inv.kind !== 'invoice') throw new DomainError('VALIDATION', 'Un avoir ne peut pas être annulé par un autre avoir.');
    const done = await tx.query(`SELECT number FROM invoices WHERE original_id = $1`, [invoiceId]);
    if (done.rows[0]) throw new DomainError('INVOICE_EXISTS', `Facture déjà annulée par l'avoir ${done.rows[0].number}.`);
    const club = await clubBilling(tx, inv.club_id);
    const now = new Date();
    const number = await nextNumber(tx, club, 'credit_note', now);
    const lines = (inv.lines as InvoiceLine[]).map((l) => ({ ...l, quantity: -l.quantity, totalHtMinor: -l.totalHtMinor, taxMinor: -l.taxMinor, totalMinor: -l.totalMinor }));
    const { rows } = await tx.query(
      `INSERT INTO invoices (club_id, order_id, booking_id, kind, number, original_id, issued_at, issued_by, seller, buyer, currency, lines,
                             total_ht_minor, tax_minor, total_minor, paid_minor, reason)
       VALUES ($1, $2, $3, 'credit_note', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15) RETURNING id`,
      [inv.club_id, inv.order_id, inv.booking_id, number, inv.id, now, actor.id ?? null, sellerOf(club), inv.buyer, inv.currency,
        JSON.stringify(lines), -inv.total_ht_minor, -inv.tax_minor, -inv.total_minor, reason.trim()],
    );
    await audit(tx, { clubId: inv.club_id, actor, action: 'credit_note.issued', entityType: 'invoice', entityId: rows[0].id,
      data: { number, originalNumber: inv.number, totalMinor: -inv.total_minor } });
    return rows[0].id as string;
  });
  return getInvoice(db, id);
}

const INVOICE_COLUMNS = `i.id, i.club_id AS "clubId", i.booking_id AS "bookingId", i.kind, i.number, i.issued_at AS "issuedAt",
  i.seller, i.buyer, i.currency, i.lines, i.total_ht_minor AS "totalHtMinor", i.tax_minor AS "taxMinor", i.total_minor AS "totalMinor",
  i.paid_minor AS "paidMinor", i.reason, b.reference AS "bookingReference", u.display_name AS "issuedBy",
  o.number AS "originalNumber", cn.number AS "creditNoteNumber"`;
const INVOICE_FROM = `invoices i JOIN bookings b ON b.id = i.booking_id LEFT JOIN users u ON u.id = i.issued_by
  LEFT JOIN invoices o ON o.id = i.original_id LEFT JOIN invoices cn ON cn.original_id = i.id`;

export async function getInvoice(q: Queryable, id: string) {
  const { rows } = await q.query(`SELECT ${INVOICE_COLUMNS} FROM ${INVOICE_FROM} WHERE i.id = $1`, [id]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Facture introuvable.');
  return rows[0];
}

export async function bookingInvoices(q: Queryable, bookingId: string) {
  const { rows } = await q.query(
    `SELECT i.id, i.kind, i.number, i.issued_at AS "issuedAt", i.total_minor AS "totalMinor", i.currency, cn.number AS "creditNoteNumber"
       FROM invoices i LEFT JOIN invoices cn ON cn.original_id = i.id WHERE i.booking_id = $1 ORDER BY i.issued_at`,
    [bookingId],
  );
  return rows;
}

export async function listInvoices(q: Queryable, clubId: string, from: Date, to: Date) {
  const { rows } = await q.query(
    `SELECT ${INVOICE_COLUMNS} FROM ${INVOICE_FROM} WHERE i.club_id = $1 AND i.issued_at >= $2 AND i.issued_at < $3 ORDER BY i.issued_at, i.number`,
    [clubId, from, to],
  );
  return rows;
}

/** Journal des factures et avoirs pour le comptable. */
export async function invoicesCsv(q: Queryable, clubId: string, from: Date, to: Date, timezone: string): Promise<string> {
  const rows = await listInvoices(q, clubId, from, to);
  const lines: unknown[][] = [['Date', 'Numéro', 'Type', 'Facture annulée', 'Client', 'ICE client', 'Réservation', 'Total HT', 'TVA', 'Total TTC', 'Devise']];
  for (const r of rows) {
    lines.push([DateTime.fromJSDate(r.issuedAt, { zone: timezone }).toFormat('dd/MM/yyyy'), r.number, r.kind === 'invoice' ? 'Facture' : 'Avoir',
      r.originalNumber ?? '', r.buyer.name, r.buyer.ice ?? '', r.bookingReference, csvMoney(r.totalHtMinor), csvMoney(r.taxMinor),
      csvMoney(r.totalMinor), r.currency]);
  }
  return toCsv(lines);
}

// ---------------------------------------------------------------------------
// Reçu (justificatif de paiement, ne vaut pas facture)

export async function bookingReceipt(q: Queryable, bookingId: string) {
  const { rows: [b] } = await q.query(
    `SELECT b.reference, b.club_id AS "clubId", b.players, b.holes, b.status, t.starts_at AS "startsAt", co.name AS "courseName",
            nullif(trim(coalesce(cu.first_name, '') || ' ' || coalesce(cu.last_name, '')), '') AS "customerName", o.id AS "orderId"
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN courses co ON co.id = t.course_id
       LEFT JOIN customers cu ON cu.id = b.customer_id LEFT JOIN orders o ON o.booking_id = b.id WHERE b.id = $1`,
    [bookingId],
  );
  if (!b?.orderId) throw new DomainError('NOT_FOUND', 'Réservation introuvable.');
  const club = await clubBilling(q, b.clubId);
  const [summary, lines, movements] = await Promise.all([
    orderSummary(q, b.orderId),
    q.query(`SELECT label, quantity, total_minor AS "totalMinor", tax_minor AS "taxMinor" FROM order_lines WHERE order_id = $1 ORDER BY position`, [b.orderId]),
    q.query(
      `SELECT 'payment' AS type, method, amount_minor AS "amountMinor", confirmed_at AS at FROM payments WHERE order_id = $1 AND status = 'confirmed'
       UNION ALL
       SELECT 'refund', method, -amount_minor, confirmed_at FROM refunds WHERE order_id = $1 AND status = 'confirmed' ORDER BY at`,
      [b.orderId],
    ),
  ]);
  const { orderId: _o, clubId: _c, ...booking } = b;
  return { seller: sellerOf(club), timezone: club.timezone, booking, order: summary, lines: lines.rows, movements: movements.rows, printedAt: new Date() };
}

// ---------------------------------------------------------------------------
// Caisse

const METHODS = ['cash', 'card_terminal', 'bank_transfer', 'online', 'pos', 'other'] as const;

interface Movement { type: 'payment' | 'refund'; method: string; amountMinor: number }

function totalsOf(movements: Movement[]) {
  const byMethod: Record<string, { paidMinor: number; refundedMinor: number; netMinor: number; count: number }> = {};
  for (const m of METHODS) byMethod[m] = { paidMinor: 0, refundedMinor: 0, netMinor: 0, count: 0 };
  for (const m of movements) {
    const t = (byMethod[m.method] ??= { paidMinor: 0, refundedMinor: 0, netMinor: 0, count: 0 });
    if (m.type === 'payment') t.paidMinor += m.amountMinor; else t.refundedMinor += m.amountMinor;
    t.netMinor = t.paidMinor - t.refundedMinor;
    t.count++;
  }
  const netMinor = Object.values(byMethod).reduce((n, t) => n + t.netMinor, 0);
  return { byMethod, netMinor };
}

const MOVEMENTS_SQL = (where: string) => `
  SELECT 'payment' AS type, p.id, p.method, p.amount_minor AS "amountMinor", p.confirmed_at AS at, b.reference, u.display_name AS "recordedBy"
    FROM payments p JOIN orders o ON o.id = p.order_id JOIN bookings b ON b.id = o.booking_id LEFT JOIN users u ON u.id = p.recorded_by
   WHERE p.status = 'confirmed' AND ${where.replaceAll('X.', 'p.')}
  UNION ALL
  SELECT 'refund', r.id, r.method, r.amount_minor, r.confirmed_at, b.reference, u.display_name
    FROM refunds r JOIN orders o ON o.id = r.order_id JOIN bookings b ON b.id = o.booking_id LEFT JOIN users u ON u.id = r.recorded_by
   WHERE r.status = 'confirmed' AND ${where.replaceAll('X.', 'r.')}
  ORDER BY at`;

/** Caisse en cours : mouvements confirmés depuis la dernière clôture. */
export async function currentCash(q: Queryable, clubId: string) {
  const club = await clubBilling(q, clubId);
  const [movements, last] = await Promise.all([
    q.query(MOVEMENTS_SQL('X.club_id = $1 AND X.closing_id IS NULL'), [clubId]),
    q.query(`SELECT number, closed_at AS "closedAt" FROM cash_closings WHERE club_id = $1 ORDER BY closed_at DESC LIMIT 1`, [clubId]),
  ]);
  const totals = totalsOf(movements.rows);
  return { currency: club.currency, since: last.rows[0]?.closedAt ?? null, lastClosing: last.rows[0]?.number ?? null,
    movements: movements.rows, ...totals, expectedCashMinor: totals.byMethod.cash!.netMinor };
}

export async function closeCash(db: Db, clubId: string, input: { countedCashMinor: number; floatMinor?: number; note?: string | null }, actor: Actor) {
  if (!Number.isInteger(input.countedCashMinor) || input.countedCashMinor < 0) throw new DomainError('VALIDATION', 'Montant compté invalide.');
  const float = input.floatMinor ?? 0;
  if (!Number.isInteger(float) || float < 0) throw new DomainError('VALIDATION', 'Fond de caisse invalide.');
  const id = await withTransaction(db, async (tx) => {
    // Une clôture à la fois par golf.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('cash_closing:' || $1, 0))`, [clubId]);
    const club = await clubBilling(tx, clubId);
    const { rows: [last] } = await tx.query(`SELECT closed_at FROM cash_closings WHERE club_id = $1 ORDER BY closed_at DESC LIMIT 1`, [clubId]);
    // Heure de la base : même horloge que confirmed_at des paiements.
    const closedAt: Date = (await tx.query('SELECT now() AS t')).rows[0].t;
    const number = await nextNumber(tx, club, 'cash_closing', closedAt);
    const { rows: [c] } = await tx.query(
      `INSERT INTO cash_closings (club_id, number, period_start, closed_at, closed_by, currency, totals, float_minor,
                                  expected_cash_minor, counted_cash_minor, difference_minor, note)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, 0, $8, 0, $9) RETURNING id`,
      [clubId, number, last?.closed_at ?? null, closedAt, actor.id ?? null, club.currency, float, input.countedCashMinor, input.note ?? null],
    );
    // Rattache tout ce qui a été confirmé jusqu'à l'instant de clôture.
    const p = await tx.query(
      `UPDATE payments SET closing_id = $2 WHERE club_id = $1 AND status = 'confirmed' AND closing_id IS NULL AND confirmed_at <= $3
       RETURNING 'payment' AS type, method, amount_minor AS "amountMinor"`, [clubId, c.id, closedAt]);
    const r = await tx.query(
      `UPDATE refunds SET closing_id = $2 WHERE club_id = $1 AND status = 'confirmed' AND closing_id IS NULL AND confirmed_at <= $3
       RETURNING 'refund' AS type, method, amount_minor AS "amountMinor"`, [clubId, c.id, closedAt]);
    const totals = totalsOf([...p.rows, ...r.rows]);
    const expected = float + totals.byMethod.cash!.netMinor;
    await tx.query(
      `UPDATE cash_closings SET totals = $2, expected_cash_minor = $3, difference_minor = $4 WHERE id = $1`,
      [c.id, totals, expected, input.countedCashMinor - expected],
    );
    await audit(tx, { clubId, actor, action: 'cash.closed', entityType: 'cash_closing', entityId: c.id,
      data: { number, netMinor: totals.netMinor, expectedCashMinor: expected, countedCashMinor: input.countedCashMinor } });
    return c.id as string;
  });
  return getClosing(db, id);
}

const CLOSING_COLUMNS = `c.id, c.club_id AS "clubId", c.number, c.period_start AS "periodStart", c.closed_at AS "closedAt", c.currency, c.totals,
  c.float_minor AS "floatMinor", c.expected_cash_minor AS "expectedCashMinor", c.counted_cash_minor AS "countedCashMinor",
  c.difference_minor AS "differenceMinor", c.note, u.display_name AS "closedBy"`;

export async function getClosing(q: Queryable, id: string) {
  const { rows } = await q.query(`SELECT ${CLOSING_COLUMNS} FROM cash_closings c LEFT JOIN users u ON u.id = c.closed_by WHERE c.id = $1`, [id]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Clôture introuvable.');
  const movements = await q.query(MOVEMENTS_SQL('X.closing_id = $1'), [id]);
  const club = await clubBilling(q, rows[0].clubId);
  return { ...rows[0], movements: movements.rows, seller: sellerOf(club), timezone: club.timezone };
}

export async function listClosings(q: Queryable, clubId: string, limit = 60) {
  const { rows } = await q.query(
    `SELECT ${CLOSING_COLUMNS} FROM cash_closings c LEFT JOIN users u ON u.id = c.closed_by WHERE c.club_id = $1 ORDER BY c.closed_at DESC LIMIT $2`,
    [clubId, limit],
  );
  return rows;
}
