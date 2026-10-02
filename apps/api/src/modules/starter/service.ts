// Vue opérationnelle du starter : départs à venir, attribution nominative
// du caddie (capacité déjà réservée à la réservation) et du matériel.

import type { Db, Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { audit, type Actor } from '../../shared/audit.js';
import { caddieClash, lockCaddie, lockUnit, unitClash } from '../resources/availability.js';
import { DomainError } from '../../shared/errors.js';
import { paymentStatusOf } from '../orders/service.js';
import { instantToLocal } from '../../shared/time.js';
import type { Club } from '../catalog/repository.js';

export async function getStarterBoard(q: Queryable, club: Club, from: string, to: string) {
  const teeTimes = (
    await q.query(
      `SELECT t.id, t.starts_at AS "startsAt", t.local_date AS "localDate", t.holes, t.is_private AS "isPrivate",
              t.max_players AS "maxPlayers", co.id AS "courseId", co.name AS "courseName",
              t.caddie_id AS "caddieId", ca.display_name AS "caddieName", t.started_at AS "startedAt",
              EXISTS (SELECT 1 FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id
                       WHERE a.tee_time_id = t.id AND a.status = 'active' AND rt.kind = 'caddie') AS "caddieReserved"
         FROM tee_times t
         JOIN courses co ON co.id = t.course_id
         LEFT JOIN caddies ca ON ca.id = t.caddie_id
        WHERE t.club_id = $1 AND t.local_date BETWEEN $2 AND $3
          AND EXISTS (SELECT 1 FROM bookings b WHERE b.tee_time_id = t.id AND b.status = 'confirmed')
        ORDER BY t.starts_at, co.name`,
      [club.id, from, to],
    )
  ).rows;
  const ids = teeTimes.map((t) => t.id);
  const bookings = ids.length
    ? (
        await q.query(
          `SELECT b.id, b.tee_time_id AS "teeTimeId", b.reference, b.players, b.holes, b.channel,
                  b.caddie_payment AS "caddiePayment", b.due_on_site_minor AS "dueOnSiteMinor", b.notes,
                  b.checkin_status AS "checkinStatus",
                  (SELECT o.total_minor FROM orders o WHERE o.booking_id = b.id) AS "orderTotalMinor",
                  (SELECT coalesce((SELECT sum(amount_minor) FROM payments WHERE order_id = o.id AND status = 'confirmed'), 0)
                        - coalesce((SELECT sum(amount_minor) FROM refunds WHERE order_id = o.id AND status = 'confirmed'), 0)
                     FROM orders o WHERE o.booking_id = b.id)::int AS "paidMinor",
                  NULLIF(concat_ws(' ', cu.first_name, cu.last_name), '') AS "customerName",
                  (SELECT array_agg(name ORDER BY position) FROM booking_players bp WHERE bp.booking_id = b.id) AS "playerNames"
             FROM bookings b LEFT JOIN customers cu ON cu.id = b.customer_id
            WHERE b.tee_time_id = ANY($1) AND b.status = 'confirmed' ORDER BY b.created_at`,
          [ids],
        )
      ).rows
    : [];
  const bookingIds = bookings.map((b) => b.id);
  const equipment = bookingIds.length
    ? (
        await q.query(
          `SELECT a.id AS "allocationId", a.booking_id AS "bookingId", a.quantity, rt.id AS "resourceTypeId",
                  rt.code, rt.name, rt.kind,
                  coalesce(json_agg(json_build_object('id', u.id, 'label', u.label) ORDER BY u.label)
                           FILTER (WHERE u.id IS NOT NULL), '[]') AS units
             FROM resource_allocations a
             JOIN resource_types rt ON rt.id = a.resource_type_id
             LEFT JOIN allocation_units au ON au.allocation_id = a.id
             LEFT JOIN resource_units u ON u.id = au.unit_id
            WHERE a.booking_id = ANY($1) AND a.status = 'active'
            GROUP BY a.id, rt.id ORDER BY rt.sort_order`,
          [bookingIds],
        )
      ).rows
    : [];

  return teeTimes.map((t) => {
    const tb = bookings.filter((b) => b.teeTimeId === t.id);
    return {
      teeTimeId: t.id,
      startsAt: t.startsAt.toISOString(),
      localDate: t.localDate,
      localTime: instantToLocal(t.startsAt, club.timezone).time,
      course: { id: t.courseId, name: t.courseName },
      holes: t.holes,
      isPrivate: t.isPrivate,
      players: tb.reduce((n, b) => n + b.players, 0),
      remaining: t.isPrivate ? 0 : t.maxPlayers - tb.reduce((n, b) => n + b.players, 0),
      caddie: { reserved: t.caddieReserved, caddieId: t.caddieId, name: t.caddieName },
      startedAt: t.startedAt ? t.startedAt.toISOString() : null,
      bookings: tb.map((b) => ({
        ...b,
        paymentStatus: paymentStatusOf(b.orderTotalMinor ?? 0, b.paidMinor ?? 0),
        balanceMinor: (b.orderTotalMinor ?? 0) - (b.paidMinor ?? 0),
        playerNames: b.playerNames ?? [],
        equipment: equipment.filter((e) => e.bookingId === b.id),
      })),
    };
  });
}

export async function listCaddies(q: Queryable, clubId: string) {
  const { rows } = await q.query(
    'SELECT id, display_name AS "displayName", active FROM caddies WHERE club_id = $1 ORDER BY display_name',
    [clubId],
  );
  return rows;
}

export async function listUnits(q: Queryable, clubId: string) {
  const { rows } = await q.query(
    `SELECT u.id, u.label, u.status, rt.id AS "resourceTypeId", rt.code, rt.name
       FROM resource_units u JOIN resource_types rt ON rt.id = u.resource_type_id
      WHERE rt.club_id = $1 ORDER BY rt.sort_order, u.label`,
    [clubId],
  );
  return rows;
}

/** Réservations confirmées d'un départ (pour relier l'événement à chacune). */
async function teeTimeBookings(q: Queryable, teeTimeId: string): Promise<Array<{ id: string; reference: string }>> {
  const { rows } = await q.query(
    `SELECT id, reference FROM bookings WHERE tee_time_id = $1 AND status = 'confirmed' ORDER BY created_at`, [teeTimeId]);
  return rows;
}

/**
 * Attribue (ou retire, caddieId = null) le caddie nommé d'un départ.
 * La capacité doit déjà être réservée ; un caddie ne peut pas être sur deux
 * départs dont les périodes se chevauchent, ni pendant une absence déclarée.
 */
export async function assignCaddie(db: Db, teeTimeId: string, caddieId: string | null, actor: Actor): Promise<void> {
  await withTransaction(db, async (tx) => {
    const tt = await tx.query(
      `SELECT t.id, t.club_id AS "clubId", t.caddie_id AS "caddieId", t.starts_at AS "startsAt", c.timezone, pc.display_name AS "previousName"
         FROM tee_times t JOIN clubs c ON c.id = t.club_id LEFT JOIN caddies pc ON pc.id = t.caddie_id
        WHERE t.id = $1 FOR UPDATE OF t`,
      [teeTimeId],
    );
    if (!tt.rows[0]) throw new DomainError('NOT_FOUND', 'Départ introuvable.');
    const { clubId, caddieId: previous, startsAt, timezone, previousName } = tt.rows[0];
    if (previous === caddieId) return;
    const alloc = await tx.query(
      `SELECT a.period::text AS period FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id
        WHERE a.tee_time_id = $1 AND a.status = 'active' AND rt.kind = 'caddie'`,
      [teeTimeId],
    );
    let name: string | null = null;
    if (caddieId !== null) {
      if (!alloc.rows[0]) throw new DomainError('NO_CADDIE_RESERVED', "Aucun caddie n'est réservé pour ce départ.");
      const c = await tx.query('SELECT display_name FROM caddies WHERE id = $1 AND club_id = $2 AND active', [caddieId, clubId]);
      if (!c.rowCount) throw new DomainError('NOT_FOUND', 'Caddie introuvable pour ce golf.');
      name = c.rows[0].display_name;
      await lockCaddie(tx, caddieId);
      const conflict = await caddieClash(tx, caddieId, teeTimeId, alloc.rows[0].period, timezone);
      if (conflict) {
        throw new DomainError(conflict.startsWith('Déjà') ? 'CADDIE_ALREADY_ASSIGNED' : 'CADDIE_UNAVAILABLE', `${name} : ${conflict}.`);
      }
    }
    await tx.query('UPDATE tee_times SET caddie_id = $2, updated_at = now() WHERE id = $1', [teeTimeId, caddieId]);
    const bookings = await teeTimeBookings(tx, teeTimeId);
    const local = instantToLocal(startsAt, timezone);
    await audit(tx, {
      clubId,
      actor,
      action: caddieId ? 'tee_time.caddie_assigned' : 'tee_time.caddie_unassigned',
      entityType: 'tee_time',
      entityId: teeTimeId,
      data: { time: local.time, date: local.date, references: bookings.map((b) => b.reference),
        changes: { caddie: { from: previousName ?? null, to: name } } },
      refs: [...bookings.map((b) => b.id), previous, caddieId],
    });
  });
}

/** Attribue les unités nominatives (voiturette n°…, sac n°…) d'une allocation. */
export async function assignUnits(db: Db, allocationId: string, unitIds: string[], actor: Actor): Promise<void> {
  const ids = [...new Set(unitIds)].sort();
  await withTransaction(db, async (tx) => {
    const a = await tx.query(
      `SELECT a.id, a.club_id AS "clubId", a.resource_type_id AS "resourceTypeId", a.booking_id AS "bookingId",
              a.quantity, a.period::text AS period, a.status, rt.name AS "typeName", c.timezone, b.reference
         FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id JOIN clubs c ON c.id = a.club_id
         LEFT JOIN bookings b ON b.id = a.booking_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [allocationId],
    );
    const alloc = a.rows[0];
    if (!alloc || alloc.status !== 'active' || !alloc.bookingId) throw new DomainError('NOT_FOUND', 'Allocation introuvable.');
    if (ids.length > alloc.quantity) {
      throw new DomainError('VALIDATION', `Au plus ${alloc.quantity} unité(s) pour cette réservation.`);
    }
    const before = await tx.query(
      `SELECT u.id, u.label FROM allocation_units au JOIN resource_units u ON u.id = au.unit_id WHERE au.allocation_id = $1 ORDER BY u.label`,
      [allocationId],
    );
    let labels: string[] = [];
    if (ids.length) {
      const units = await tx.query(
        `SELECT id, label FROM resource_units WHERE id = ANY($1) AND resource_type_id = $2 ORDER BY label`,
        [ids, alloc.resourceTypeId],
      );
      if (units.rowCount !== ids.length) throw new DomainError('VALIDATION', 'Unité inconnue ou de mauvais type.');
      labels = units.rows.map((u) => u.label);
      for (const id of ids) await lockUnit(tx, id);
      for (const u of units.rows) {
        const conflict = await unitClash(tx, u.id, allocationId, alloc.period, alloc.timezone);
        if (conflict) throw new DomainError('UNIT_UNAVAILABLE', `${u.label} : ${conflict}.`);
      }
    }
    const previousLabels = before.rows.map((u) => u.label);
    if (JSON.stringify(previousLabels) === JSON.stringify(labels)) return;
    await tx.query('DELETE FROM allocation_units WHERE allocation_id = $1', [allocationId]);
    for (const id of ids) {
      await tx.query('INSERT INTO allocation_units (allocation_id, unit_id) VALUES ($1, $2)', [allocationId, id]);
    }
    await audit(tx, {
      clubId: alloc.clubId,
      actor,
      action: 'allocation.units_assigned',
      entityType: 'booking',
      entityId: alloc.bookingId,
      data: { reference: alloc.reference, allocationId, resource: alloc.typeName,
        changes: { units: { from: previousLabels, to: labels } } },
      refs: [...ids, ...before.rows.map((u) => u.id)],
    });
  });
}
