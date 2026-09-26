// Opérations du jour : blocage de départs, arrivée / absence des joueurs,
// départ effectif, export de la feuille de départs.

import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { audit, type Actor } from '../../shared/audit.js';
import { toCsv } from '../../shared/csv.js';
import { DomainError } from '../../shared/errors.js';
import { parseTimeMaybe } from '../ai/time.js';
import { getClub, getCourse } from '../catalog/repository.js';
import { syncOrder } from '../orders/service.js';
import { computeGrid, getTeeSheet } from '../teesheet/service.js';

/** Bloque les départs d'une plage horaire (bornes incluses). Les réservations existantes sont conservées. */
export async function blockRange(
  db: Db, input: { courseId: string; date: string; from: string; to: string; reason: string }, actor: Actor,
): Promise<{ blocked: number; withBookings: number }> {
  const course = await getCourse(db, input.courseId);
  const club = await getClub(db, course.clubId);
  const from = parseTimeMaybe(input.from);
  const to = parseTimeMaybe(input.to);
  if (!from || !to || to < from) throw new DomainError('VALIDATION', 'Plage horaire invalide.');
  if (!input.reason.trim()) throw new DomainError('VALIDATION', 'Motif du blocage obligatoire.');
  const slots = (await computeGrid(db, club, course, input.date)).filter((s) => s.localTime >= from && s.localTime <= to);
  if (!slots.length) throw new DomainError('VALIDATION', 'Aucun départ dans cette plage.');
  return withTransaction(db, async (tx) => {
    let blocked = 0;
    for (const slot of slots) {
      await tx.query(
        `INSERT INTO tee_times (club_id, course_id, starts_at, local_date, max_players) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (course_id, starts_at) DO NOTHING`,
        [club.id, course.id, slot.startsAt, input.date, slot.maxPlayers],
      );
      const r = await tx.query(
        `UPDATE tee_times SET blocked_reason = $3, blocked_by = $4, blocked_at = now(), updated_at = now()
          WHERE course_id = $1 AND starts_at = $2 AND blocked_reason IS NULL`,
        [course.id, slot.startsAt, input.reason.trim().slice(0, 200), actor.id ?? null],
      );
      blocked += r.rowCount ?? 0;
    }
    const { rows } = await tx.query(
      `SELECT count(DISTINCT t.id)::int AS n FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
        WHERE t.course_id = $1 AND t.starts_at = ANY($2)`,
      [course.id, slots.map((s) => s.startsAt)],
    );
    await audit(tx, { clubId: club.id, actor, action: 'tee_times.blocked', entityType: 'course', entityId: course.id,
      data: { date: input.date, from, to, reason: input.reason, blocked } });
    return { blocked, withBookings: rows[0].n };
  });
}

export async function unblockRange(db: Db, input: { courseId: string; date: string; from: string; to: string }, actor: Actor) {
  const course = await getCourse(db, input.courseId);
  const from = parseTimeMaybe(input.from) ?? '00:00';
  const to = parseTimeMaybe(input.to) ?? '23:59';
  const club = await getClub(db, course.clubId);
  const res = await db.query(
    `UPDATE tee_times SET blocked_reason = NULL, blocked_by = NULL, blocked_at = NULL, updated_at = now()
      WHERE course_id = $1 AND local_date = $2 AND blocked_reason IS NOT NULL
        AND to_char(starts_at AT TIME ZONE $5, 'HH24:MI') BETWEEN $3 AND $4`,
    [course.id, input.date, from, to, club.timezone],
  );
  await audit(db, { clubId: club.id, actor, action: 'tee_times.unblocked', entityType: 'course', entityId: course.id,
    data: { date: input.date, from, to, unblocked: res.rowCount } });
  return { unblocked: res.rowCount ?? 0 };
}

/** Arrivée ou absence d'une réservation. Une absence applique la politique du golf sur le montant dû. */
export async function setCheckin(db: Db, bookingId: string, status: 'expected' | 'arrived' | 'no_show', actor: Actor) {
  await withTransaction(db, async (tx) => {
    const { rows: [b] } = await tx.query(
      `SELECT id, club_id AS "clubId", status, checkin_status AS "checkinStatus", reference FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId]);
    if (!b) throw new DomainError('NOT_FOUND', 'Réservation introuvable.');
    if (b.status !== 'confirmed') throw new DomainError('BOOKING_CANCELLED', 'Réservation annulée.');
    if (b.checkinStatus === status) return;
    await tx.query(
      `UPDATE bookings SET checkin_status = $2, checked_in_at = CASE WHEN $2 = 'expected' THEN NULL ELSE now() END,
              checkin_by = $3, updated_at = now() WHERE id = $1`,
      [bookingId, status, actor.id ?? null],
    );
    if (status === 'no_show' || b.checkinStatus === 'no_show') await syncOrder(tx, bookingId);
    await audit(tx, { clubId: b.clubId, actor, action: `booking.checkin.${status}`, entityType: 'booking', entityId: bookingId,
      data: { reference: b.reference, previous: b.checkinStatus } });
  });
}

export async function setStarted(db: Db, teeTimeId: string, started: boolean, actor: Actor) {
  const { rows: [t] } = await db.query(
    `UPDATE tee_times SET started_at = CASE WHEN $2 THEN coalesce(started_at, now()) END, updated_at = now() WHERE id = $1
     RETURNING club_id`, [teeTimeId, started]);
  if (!t) throw new DomainError('NOT_FOUND', 'Départ introuvable.');
  await audit(db, { clubId: t.club_id, actor, action: started ? 'tee_time.started' : 'tee_time.start_undone', entityType: 'tee_time', entityId: teeTimeId });
}

const CHECKIN_LABEL = { expected: 'attendu', arrived: 'arrivé', no_show: 'absent' } as const;
const PAYMENT_LABEL: Record<string, string> = { nothing_due: 'rien à payer', unpaid: 'à payer', partially_paid: 'partiel', paid: 'payé', refund_due: 'à rembourser' };

/** Feuille de départs du jour au format CSV (séparateur « ; », compatible Excel). */
export async function teeSheetCsv(db: Db, courseId: string, date: string, withContacts: boolean): Promise<string> {
  const sheet = await getTeeSheet(db, courseId, date);
  const header = ['Heure', 'Parcours', 'Formule', 'Joueurs du départ', 'Référence', 'Client', ...(withContacts ? ['Téléphone', 'E-mail'] : []),
    'Joueurs', 'Canal', 'Options', 'Caddie', 'Paiement', 'Reste dû', 'Arrivée', 'Bloqué'];
  const lines: unknown[][] = [header];
  for (const r of sheet.rows) {
    if (!r.bookings.length && !r.blockedReason) continue;
    const base = [r.localTime, sheet.course.name, r.holes ? `${r.holes} trous` : '', r.bookedPlayers];
    if (!r.bookings.length) {
      lines.push([...base, '', '', ...(withContacts ? ['', ''] : []), '', '', '', '', '', '', '', r.blockedReason]);
      continue;
    }
    for (const b of r.bookings) {
      lines.push([...base, b.reference, b.customerName ?? '', ...(withContacts ? [b.customerPhone ?? '', b.customerEmail ?? ''] : []),
        b.players, b.channel, b.resources.map((x) => `${x.name} x${x.quantity}`).join(', '), r.caddie.name ?? (r.caddie.reserved ? 'réservé' : ''),
        PAYMENT_LABEL[b.paymentStatus ?? ''] ?? '', ((b.balanceMinor ?? 0) / 100).toFixed(2).replace('.', ','),
        CHECKIN_LABEL[b.checkinStatus], r.blockedReason ?? '']);
    }
  }
  return toCsv(lines);
}
