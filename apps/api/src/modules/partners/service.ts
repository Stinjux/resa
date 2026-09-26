// Partenaires (tour-opérateurs, agences, hôtels, entreprises).
//
// - Tarifs négociés : chaque partenaire a une catégorie tarifaire ; ses
//   réservations sont toujours tarifées avec cette catégorie (grille Tarifs).
// - Allotement : des départs sont retirés de la vente et tenus pour le
//   partenaire jusqu'à « release_days » jours avant la date ; ensuite les
//   places non utilisées reviennent automatiquement à la vente.
// - Relevé : réservations de la période, montants, réglé, reste dû.

import { DateTime } from 'luxon';
import type { Db, Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { audit, type Actor } from '../../shared/audit.js';
import { csvMoney, toCsv } from '../../shared/csv.js';
import { DomainError } from '../../shared/errors.js';
import { hashPassword } from '../auth/password.js';
import { getClub, getCourse } from '../catalog/repository.js';
import { syncOrder } from '../orders/service.js';
import { computeGrid } from '../teesheet/service.js';

export interface PartnerInput {
  code: string; name: string; kind?: string; priceCategory?: string; onAccount?: boolean; paymentTermsDays?: number;
  contactName?: string | null; email?: string | null; phone?: string | null; legalName?: string | null; address?: string | null;
  ice?: string | null; notes?: string | null; active?: boolean; billingScope?: 'all' | 'green_fees' | 'none';
}

const COLUMNS: Record<keyof PartnerInput, string> = {
  code: 'code', name: 'name', kind: 'kind', priceCategory: 'price_category', onAccount: 'on_account', paymentTermsDays: 'payment_terms_days',
  contactName: 'contact_name', email: 'email', phone: 'phone', legalName: 'legal_name', address: 'address', ice: 'ice', notes: 'notes',
  active: 'active', billingScope: 'billing_scope',
};
const SELECT = `id, organization_id AS "organizationId", code, name, kind, price_category AS "priceCategory", on_account AS "onAccount",
  payment_terms_days AS "paymentTermsDays", billing_scope AS "billingScope", contact_name AS "contactName", email, phone, legal_name AS "legalName", address, ice, notes, active`;

export async function listPartners(q: Queryable, organizationId: string, activeOnly = false) {
  const { rows } = await q.query(
    `SELECT ${SELECT}, (SELECT count(*)::int FROM users u WHERE u.partner_id = p.id AND u.active) AS "portalUsers"
       FROM partners p WHERE organization_id = $1 ${activeOnly ? 'AND active' : ''} ORDER BY name`,
    [organizationId],
  );
  return rows;
}

export async function getPartner(q: Queryable, id: string) {
  const { rows } = await q.query(`SELECT ${SELECT} FROM partners WHERE id = $1`, [id]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Partenaire introuvable.');
  return rows[0];
}

function isUnique(err: unknown) {
  return (err as { code?: string }).code === '23505';
}

export async function savePartner(db: Db, organizationId: string, id: string | null, input: Partial<PartnerInput>, actor: Actor) {
  const entries = Object.entries(input).filter(([k, v]) => k in COLUMNS && v !== undefined) as Array<[keyof PartnerInput, unknown]>;
  try {
    const saved = await withTransaction(db, async (tx) => {
      let row;
      if (id) {
        if (!entries.length) return getPartner(tx, id);
        const sets = entries.map(([k], i) => `${COLUMNS[k]} = $${i + 3}`).join(', ');
        const r = await tx.query(`UPDATE partners SET ${sets} WHERE id = $1 AND organization_id = $2 RETURNING id`,
          [id, organizationId, ...entries.map(([, v]) => v)]);
        if (!r.rows[0]) throw new DomainError('NOT_FOUND', 'Partenaire introuvable.');
        row = r.rows[0];
      } else {
        if (!input.code || !input.name) throw new DomainError('VALIDATION', 'Code et nom obligatoires.');
        const cols = entries.map(([k]) => COLUMNS[k]);
        const r = await tx.query(
          `INSERT INTO partners (organization_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
          [organizationId, ...entries.map(([, v]) => v)]);
        row = r.rows[0];
      }
      if (id && input.billingScope !== undefined) {
        // Nouvelle répartition : appliquée aux réservations dont la part partenaire n'est pas encore facturée.
        const { rows: open } = await tx.query(
          `SELECT b.id FROM bookings b JOIN orders o ON o.booking_id = b.id
            WHERE b.partner_id = $1 AND NOT EXISTS (SELECT 1 FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
                    WHERE it.order_id = o.id AND i.kind = 'invoice' AND NOT EXISTS (SELECT 1 FROM invoices a WHERE a.original_id = i.id))`,
          [id]);
        for (const b of open) await syncOrder(tx, b.id);
      }
      await audit(tx, { clubId: null, actor, action: id ? 'partner.updated' : 'partner.created', entityType: 'partner', entityId: row.id,
        data: { fields: entries.map(([k]) => k) } });
      return getPartner(tx, row.id);
    });
    return saved;
  } catch (err) {
    if (isUnique(err)) throw new DomainError('VALIDATION', 'Ce code partenaire existe déjà.');
    throw err;
  }
}

/** Accès au portail partenaire. */
export async function createPartnerUser(db: Db, partnerId: string, input: { email: string; displayName: string; password: string }, actor: Actor) {
  if (input.password.length < 8) throw new DomainError('VALIDATION', 'Mot de passe : 8 caractères minimum.');
  const partner = await getPartner(db, partnerId);
  const passwordHash = await hashPassword(input.password);
  return withTransaction(db, async (tx) => {
    const taken = await tx.query('SELECT 1 FROM users WHERE organization_id = $1 AND lower(email) = lower($2)', [partner.organizationId, input.email]);
    if (taken.rowCount) throw new DomainError('EMAIL_TAKEN', 'Un compte existe déjà avec cet e-mail.');
    const { rows } = await tx.query(
      `INSERT INTO users (organization_id, email, password_hash, display_name, partner_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [partner.organizationId, input.email, passwordHash, input.displayName, partnerId],
    );
    await audit(tx, { clubId: null, actor, action: 'partner.user_created', entityType: 'partner', entityId: partnerId, data: { userId: rows[0].id } });
    return { id: rows[0].id as string };
  });
}

// ---------------------------------------------------------------------------
// Allotements

export interface AllotmentInput {
  partnerId: string; courseId: string; dateFrom: string; dateTo: string; weekdays?: number[];
  startTime: string; endTime: string; releaseDays: number; note?: string | null;
}

/** Retire de la vente les départs de l'allotement encore libres et non échus. */
async function applyAllotment(db: Db, allotmentId: string, now: Date): Promise<number> {
  const { rows: [a] } = await db.query(
    `SELECT a.id, a.club_id AS "clubId", a.course_id AS "courseId", a.date_from AS "dateFrom", a.date_to AS "dateTo", a.weekdays,
            to_char(a.start_time, 'HH24:MI') AS "startTime", to_char(a.end_time, 'HH24:MI') AS "endTime", a.release_days AS "releaseDays",
            p.name AS "partnerName"
       FROM allotments a JOIN partners p ON p.id = a.partner_id WHERE a.id = $1`,
    [allotmentId],
  );
  const course = await getCourse(db, a.courseId);
  const club = await getClub(db, a.clubId);
  const reason = `Allotement ${a.partnerName}`.slice(0, 200);
  let held = 0;
  for (let d = DateTime.fromISO(a.dateFrom, { zone: club.timezone }); d.toISODate()! <= a.dateTo; d = d.plus({ days: 1 })) {
    if (!a.weekdays.includes(d.weekday)) continue;
    const heldUntil = d.startOf('day').minus({ days: a.releaseDays }).toJSDate();
    if (heldUntil <= now) continue; // déjà rendu à la vente
    const date = d.toISODate()!;
    const slots = (await computeGrid(db, club, course, date)).filter((s) => s.localTime >= a.startTime && s.localTime <= a.endTime);
    await withTransaction(db, async (tx) => {
      for (const slot of slots) {
        await tx.query(
          `INSERT INTO tee_times (club_id, course_id, starts_at, local_date, max_players) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (course_id, starts_at) DO NOTHING`,
          [club.id, course.id, slot.startsAt, date, slot.maxPlayers],
        );
        // Seulement les départs libres et non bloqués.
        const r = await tx.query(
          `UPDATE tee_times t SET blocked_reason = $3, blocked_at = now(), held_allotment_id = $4, held_until = $5, updated_at = now()
            WHERE t.course_id = $1 AND t.starts_at = $2 AND t.blocked_reason IS NULL
              AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.tee_time_id = t.id AND b.status = 'confirmed')`,
          [course.id, slot.startsAt, reason, a.id, heldUntil],
        );
        held += r.rowCount ?? 0;
      }
    });
  }
  return held;
}

export async function createAllotment(db: Db, clubId: string, input: AllotmentInput, actor: Actor, now: Date) {
  const course = await getCourse(db, input.courseId);
  if (course.clubId !== clubId) throw new DomainError('VALIDATION', 'Parcours d’un autre golf.');
  const club = await getClub(db, clubId);
  const partner = await getPartner(db, input.partnerId);
  if (partner.organizationId !== club.organizationId || !partner.active) throw new DomainError('VALIDATION', 'Partenaire inconnu ou inactif.');
  if (input.dateTo < input.dateFrom || input.endTime < input.startTime) throw new DomainError('VALIDATION', 'Période ou plage horaire invalide.');
  const { rows } = await db.query(
    `INSERT INTO allotments (club_id, partner_id, course_id, date_from, date_to, weekdays, start_time, end_time, release_days, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [clubId, input.partnerId, input.courseId, input.dateFrom, input.dateTo, input.weekdays?.length ? input.weekdays : [1, 2, 3, 4, 5, 6, 7],
      input.startTime, input.endTime, input.releaseDays, input.note ?? null, actor.id ?? null],
  );
  const held = await applyAllotment(db, rows[0].id, now);
  await audit(db, { clubId, actor, action: 'allotment.created', entityType: 'allotment', entityId: rows[0].id,
    data: { partnerId: input.partnerId, dateFrom: input.dateFrom, dateTo: input.dateTo, held } });
  return { id: rows[0].id as string, held };
}

/** Libère les départs tenus : tous ceux d'un allotement, ou ceux dont la date de release est passée. */
async function releaseHolds(q: Queryable, where: string, params: unknown[]) {
  const r = await q.query(
    `UPDATE tee_times SET blocked_reason = NULL, blocked_at = NULL, held_allotment_id = NULL, held_until = NULL, updated_at = now()
      WHERE held_allotment_id IS NOT NULL AND ${where}`,
    params,
  );
  return r.rowCount ?? 0;
}

export async function cancelAllotment(db: Db, clubId: string, id: string, actor: Actor) {
  return withTransaction(db, async (tx) => {
    const r = await tx.query(`UPDATE allotments SET status = 'cancelled' WHERE id = $1 AND club_id = $2 AND status = 'active'`, [id, clubId]);
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Allotement introuvable.');
    const released = await releaseHolds(tx, 'held_allotment_id = $1', [id]);
    await audit(tx, { clubId, actor, action: 'allotment.cancelled', entityType: 'allotment', entityId: id, data: { released } });
    return { released };
  });
}

/** Tâche périodique : rend à la vente les places non utilisées à la date de release. */
export async function releaseDueAllotments(db: Db, now: Date): Promise<number> {
  return releaseHolds(db, 'held_until <= $1', [now]);
}

export async function listAllotments(q: Queryable, clubId: string) {
  const { rows } = await q.query(
    `SELECT a.id, a.partner_id AS "partnerId", p.name AS "partnerName", a.course_id AS "courseId", co.name AS "courseName",
            to_char(a.date_from, 'YYYY-MM-DD') AS "dateFrom", to_char(a.date_to, 'YYYY-MM-DD') AS "dateTo", a.weekdays,
            to_char(a.start_time, 'HH24:MI') AS "startTime", to_char(a.end_time, 'HH24:MI') AS "endTime", a.release_days AS "releaseDays",
            a.note, a.status, a.created_at AS "createdAt",
            (SELECT count(*)::int FROM tee_times t WHERE t.held_allotment_id = a.id) AS "heldTeeTimes",
            (SELECT coalesce(sum(b.players), 0)::int FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
              WHERE t.held_allotment_id = a.id AND b.partner_id = a.partner_id) AS "bookedPlayers"
       FROM allotments a JOIN partners p ON p.id = a.partner_id JOIN courses co ON co.id = a.course_id
      WHERE a.club_id = $1 ORDER BY a.status, a.date_from DESC`,
    [clubId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Réservations et relevé d'un partenaire

/** Réservations d'un partenaire dont le départ est entre deux dates locales (incluses). */
export async function partnerBookings(q: Queryable, partnerId: string, opts: { clubId?: string | null; from: string; to: string }) {
  const { rows } = await q.query(
    `SELECT b.id, b.reference, b.partner_reference AS "partnerReference", b.status, b.players, b.holes, b.club_id AS "clubId",
            c.name AS "clubName", co.name AS "courseName", t.starts_at AS "startsAt", c.timezone, b.checkin_status AS "checkinStatus",
            NULLIF(concat_ws(' ', cu.first_name, cu.last_name), '') AS "leadName", o.currency,
            -- Part du partenaire (la part du client est réglée au golf par le client).
            (SELECT coalesce(sum(total_minor), 0)::int FROM order_lines WHERE order_id = o.id AND payer = 'partner') AS "totalMinor",
            (SELECT coalesce(sum(total_minor), 0)::int FROM order_lines WHERE order_id = o.id AND payer = 'customer') AS "customerMinor",
            (coalesce((SELECT sum(amount_minor) FROM payments WHERE order_id = o.id AND status = 'confirmed' AND payer = 'partner'), 0)
             - coalesce((SELECT sum(amount_minor) FROM refunds WHERE order_id = o.id AND status = 'confirmed' AND payer = 'partner'), 0))::int AS "paidMinor",
            (SELECT string_agg(i.number, ', ' ORDER BY i.issued_at) FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
              WHERE it.order_id = o.id AND i.payer = 'partner' AND i.kind = 'invoice'
                AND NOT EXISTS (SELECT 1 FROM invoices x WHERE x.original_id = i.id)) AS "invoiceNumbers"
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN courses co ON co.id = t.course_id JOIN clubs c ON c.id = b.club_id
       LEFT JOIN customers cu ON cu.id = b.customer_id LEFT JOIN orders o ON o.booking_id = b.id
      WHERE b.partner_id = $1 AND ($2::uuid IS NULL OR b.club_id = $2) AND t.local_date BETWEEN $3 AND $4
      ORDER BY t.starts_at, b.reference`,
    [partnerId, opts.clubId ?? null, opts.from, opts.to],
  );
  return rows.map((r) => ({ ...r, balanceMinor: r.totalMinor - r.paidMinor }));
}

export async function partnerStatement(q: Queryable, partnerId: string, clubId: string, from: string, to: string) {
  const partner = await getPartner(q, partnerId);
  const bookings = await partnerBookings(q, partnerId, { clubId, from, to });
  const sum = (k: 'totalMinor' | 'paidMinor' | 'balanceMinor') => bookings.reduce((n, b) => n + b[k], 0);
  return {
    partner, bookings,
    totals: { players: bookings.filter((b) => b.status === 'confirmed').reduce((n, b) => n + b.players, 0),
      totalMinor: sum('totalMinor'), paidMinor: sum('paidMinor'), balanceMinor: sum('balanceMinor') },
  };
}

export async function partnerStatementCsv(q: Queryable, partnerId: string, clubId: string, from: string, to: string): Promise<string> {
  const s = await partnerStatement(q, partnerId, clubId, from, to);
  const lines: unknown[][] = [['Date', 'Heure', 'Parcours', 'Réservation', 'Voucher', 'Client', 'Joueurs', 'Trous', 'Statut', 'Part partenaire', 'Réglé', 'Reste dû', 'Facture']];
  for (const b of s.bookings) {
    const at = DateTime.fromJSDate(b.startsAt, { zone: b.timezone });
    lines.push([at.toFormat('dd/MM/yyyy'), at.toFormat('HH:mm'), b.courseName, b.reference, b.partnerReference ?? '', b.leadName ?? '', b.players, b.holes,
      b.status === 'cancelled' ? 'annulée' : b.checkinStatus === 'no_show' ? 'absent' : 'confirmée',
      csvMoney(b.totalMinor), csvMoney(b.paidMinor), csvMoney(b.balanceMinor), b.invoiceNumbers ?? '']);
  }
  lines.push(['Total', '', '', '', '', '', s.totals.players, '', '', csvMoney(s.totals.totalMinor), csvMoney(s.totals.paidMinor), csvMoney(s.totals.balanceMinor), '']);
  return toCsv(lines);
}
