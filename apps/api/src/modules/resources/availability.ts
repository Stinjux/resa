// Disponibilité des ressources au quotidien : tableau du jour (types, unités
// nominatives, caddies), indisponibilités datées (maintenance, absence),
// conflits à résoudre et choix d'affectation avec explication des conflits.
//
// Statuts affichés (mêmes mots partout) :
//  - available   « Disponible »      : ni affecté, ni indisponible ;
//  - reserved    « Réservé »         : affecté à un départ à venir de la journée ;
//  - in_use      « En utilisation »  : affecté à un départ en cours (maintenant
//                                      dans la période d'utilisation) ;
//  - unavailable « Indisponible »    : maintenance / absence, ou unité retirée.

import { DateTime } from 'luxon';
import type { Db, Queryable, Tx } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { peakUsage, type Usage } from '../../domain/resource-usage.js';
import { audit, type Actor } from '../../shared/audit.js';
import { DomainError } from '../../shared/errors.js';
import { instantToLocal } from '../../shared/time.js';
import { getClub, listResourceTypes, type Club } from '../catalog/repository.js';
import { caddieTypes } from '../teesheet/service.js';
import { capacityOn, lockResourceTypes } from './service.js';

export type ResourceStatus = 'available' | 'reserved' | 'in_use' | 'unavailable';

export interface Unavailability {
  id: string;
  kind: 'maintenance' | 'unavailable';
  startsAt: string;
  endsAt: string | null;
  reason: string;
}

const fmt = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz });
/** « 14:45 » le même jour, sinon « 12/06 14:45 ». */
function when(d: Date, tz: string, sameDay?: string): string {
  const l = fmt(d, tz);
  return l.toISODate() === sameDay ? l.toFormat('HH:mm') : l.toFormat('dd/LL HH:mm');
}
export function describeUnavailability(u: { kind: string; startsAt: Date; endsAt: Date | null; reason: string }, tz: string): string {
  const what = u.kind === 'maintenance' ? 'En maintenance' : 'Indisponible';
  const until = u.endsAt ? ` jusqu'au ${fmt(u.endsAt, tz).toFormat('dd/LL HH:mm')}` : " jusqu'à nouvel ordre";
  return `${what}${until} : ${u.reason}`;
}

async function lock(q: Queryable, key: string): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}
export const lockUnit = (q: Queryable, unitId: string) => lock(q, `unit:${unitId}`);
export const lockCaddie = (q: Queryable, caddieId: string) => lock(q, `caddie:${caddieId}`);

const UNAV_COLUMNS = `id, kind, starts_at AS "startsAt", ends_at AS "endsAt", reason`;

/** Indisponibilité d'une unité ou d'un caddie qui chevauche la période. */
export async function unavailabilityDuring(
  q: Queryable, target: { unitId: string } | { caddieId: string }, period: string,
): Promise<{ id: string; kind: string; startsAt: Date; endsAt: Date | null; reason: string } | null> {
  const col = 'unitId' in target ? 'unit_id' : 'caddie_id';
  const { rows } = await q.query(
    `SELECT ${UNAV_COLUMNS} FROM resource_unavailabilities
      WHERE ${col} = $1 AND cancelled_at IS NULL AND tstzrange(starts_at, ends_at, '[)') && $2::tstzrange
      ORDER BY starts_at LIMIT 1`,
    ['unitId' in target ? target.unitId : target.caddieId, period],
  );
  return rows[0] ?? null;
}

/** Le caddie est-il libre (ni affecté ailleurs, ni absent) sur la période ? */
export async function caddieClash(q: Queryable, caddieId: string, teeTimeId: string, period: string, tz: string): Promise<string | null> {
  const un = await unavailabilityDuring(q, { caddieId }, period);
  if (un) return describeUnavailability(un, tz);
  const { rows } = await q.query(
    `SELECT t.starts_at AS "startsAt" FROM tee_times t
       JOIN resource_allocations a ON a.tee_time_id = t.id AND a.status = 'active'
       JOIN resource_types rt ON rt.id = a.resource_type_id AND rt.kind = 'caddie'
      WHERE t.caddie_id = $1 AND t.id <> $2 AND a.period && $3::tstzrange LIMIT 1`,
    [caddieId, teeTimeId, period],
  );
  return rows[0] ? `Déjà affecté au départ de ${fmt(rows[0].startsAt, tz).toFormat('HH:mm')}` : null;
}

/** L'unité est-elle libre (ni affectée ailleurs, ni en maintenance, ni retirée) sur la période ? */
export async function unitClash(q: Queryable, unitId: string, allocationId: string | null, period: string, tz: string): Promise<string | null> {
  const { rows: [u] } = await q.query('SELECT label, status FROM resource_units WHERE id = $1', [unitId]);
  if (!u) return 'Unité inconnue';
  if (u.status === 'retired') return 'Retirée du service';
  const un = await unavailabilityDuring(q, { unitId }, period);
  if (un) return describeUnavailability(un, tz);
  const { rows } = await q.query(
    `SELECT b.reference, lower(a.period) AS start, upper(a.period) AS "end" FROM allocation_units au
       JOIN resource_allocations a ON a.id = au.allocation_id AND a.status = 'active'
       LEFT JOIN bookings b ON b.id = a.booking_id
      WHERE au.unit_id = $1 AND ($2::uuid IS NULL OR a.id <> $2) AND a.period && $3::tstzrange
      ORDER BY lower(a.period) LIMIT 1`,
    [unitId, allocationId, period],
  );
  if (!rows[0]) return null;
  const day = instantToLocal(rows[0].start, tz).date;
  return `Déjà prise ${when(rows[0].start, tz, day)}–${when(rows[0].end, tz, day)} (${rows[0].reference ?? 'autre réservation'})`;
}

// ---------------------------------------------------------------------------
// Choix d'affectation : chaque unité / caddie avec son état sur la période

export async function unitOptions(q: Queryable, allocationId: string) {
  const { rows: [a] } = await q.query(
    `SELECT a.id, a.club_id AS "clubId", a.resource_type_id AS "resourceTypeId", a.quantity, a.period::text AS period,
            lower(a.period) AS start, upper(a.period) AS "end", a.status, rt.name AS "typeName",
            coalesce((SELECT array_agg(unit_id) FROM allocation_units WHERE allocation_id = a.id), '{}') AS assigned
       FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id WHERE a.id = $1`,
    [allocationId],
  );
  if (!a || a.status !== 'active') throw new DomainError('NOT_FOUND', 'Allocation introuvable.');
  const club = await getClub(q, a.clubId);
  const { rows: units } = await q.query(
    `SELECT id, label FROM resource_units WHERE resource_type_id = $1 AND status <> 'retired' ORDER BY label`, [a.resourceTypeId]);
  const options = [];
  for (const u of units) {
    const conflict = await unitClash(q, u.id, a.id, a.period, club.timezone);
    options.push({ id: u.id, label: u.label, free: !conflict, conflict });
  }
  return { allocationId: a.id, typeName: a.typeName, quantity: a.quantity, assigned: a.assigned as string[],
    start: a.start.toISOString(), end: a.end.toISOString(), units: options };
}

export async function caddieOptions(q: Queryable, teeTimeId: string) {
  const { rows: [t] } = await q.query(
    `SELECT t.id, t.club_id AS "clubId", t.caddie_id AS "caddieId",
            (SELECT a.period::text FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id
              WHERE a.tee_time_id = t.id AND a.status = 'active' AND rt.kind = 'caddie' LIMIT 1) AS period
       FROM tee_times t WHERE t.id = $1`, [teeTimeId]);
  if (!t) throw new DomainError('NOT_FOUND', 'Départ introuvable.');
  const club = await getClub(q, t.clubId);
  const { rows: caddies } = await q.query(
    'SELECT id, display_name AS "displayName" FROM caddies WHERE club_id = $1 AND active ORDER BY display_name', [t.clubId]);
  const options = [];
  for (const c of caddies) {
    const conflict = t.period ? await caddieClash(q, c.id, t.id, t.period, club.timezone) : null;
    options.push({ id: c.id, displayName: c.displayName, free: !conflict, conflict });
  }
  return { teeTimeId: t.id, reserved: !!t.period, caddieId: t.caddieId, caddies: options };
}

// ---------------------------------------------------------------------------
// Conflits : une affectation tombe pendant une maintenance / absence

export interface Conflict {
  kind: 'unit' | 'caddie';
  targetId: string;
  label: string;
  unavailabilityId: string;
  reason: string;
  bookingIds: string[];
  references: string[];
  allocationId: string | null;
  teeTimeId: string;
  startsAt: string;
  localDate: string;
  localTime: string;
}

export async function listConflicts(q: Queryable, club: Club, now: Date, filter: { unavailabilityId?: string } = {}): Promise<Conflict[]> {
  const { rows } = await q.query(
    `SELECT 'unit' AS kind, u.id AS "targetId", u.label, ua.id AS "unavailabilityId", ua.reason,
            ARRAY[b.id] AS "bookingIds", ARRAY[b.reference] AS "references", a.id AS "allocationId",
            b.tee_time_id AS "teeTimeId", lower(a.period) AS "startsAt"
       FROM allocation_units au
       JOIN resource_allocations a ON a.id = au.allocation_id AND a.status = 'active'
       JOIN bookings b ON b.id = a.booking_id AND b.status = 'confirmed'
       JOIN resource_units u ON u.id = au.unit_id
       JOIN resource_unavailabilities ua ON ua.unit_id = au.unit_id AND ua.cancelled_at IS NULL
                                        AND tstzrange(ua.starts_at, ua.ends_at, '[)') && a.period
      WHERE a.club_id = $1 AND upper(a.period) > $2 AND ($3::uuid IS NULL OR ua.id = $3)
     UNION ALL
     SELECT 'caddie', c.id, c.display_name, ua.id, ua.reason,
            (SELECT array_agg(id ORDER BY created_at) FROM bookings WHERE tee_time_id = t.id AND status = 'confirmed'),
            (SELECT array_agg(reference ORDER BY created_at) FROM bookings WHERE tee_time_id = t.id AND status = 'confirmed'),
            NULL, t.id, t.starts_at
       FROM tee_times t
       JOIN caddies c ON c.id = t.caddie_id
       JOIN resource_allocations a ON a.tee_time_id = t.id AND a.status = 'active'
       JOIN resource_types rt ON rt.id = a.resource_type_id AND rt.kind = 'caddie'
       JOIN resource_unavailabilities ua ON ua.caddie_id = t.caddie_id AND ua.cancelled_at IS NULL
                                        AND tstzrange(ua.starts_at, ua.ends_at, '[)') && a.period
      WHERE t.club_id = $1 AND upper(a.period) > $2 AND ($3::uuid IS NULL OR ua.id = $3)
      ORDER BY "startsAt"`,
    [club.id, now, filter.unavailabilityId ?? null],
  );
  return rows.map((r) => {
    const l = instantToLocal(r.startsAt, club.timezone);
    return { ...r, startsAt: r.startsAt.toISOString(), localDate: l.date, localTime: l.time, bookingIds: r.bookingIds ?? [], references: r.references ?? [] };
  });
}

// ---------------------------------------------------------------------------
// Déclarer / lever une indisponibilité (gestionnaire)

export interface DeclareInput {
  unitId?: string | null;
  caddieId?: string | null;
  startsAt: Date;
  endsAt: Date | null;
  reason: string;
}

async function resolveTarget(tx: Tx, clubId: string, input: { unitId?: string | null; caddieId?: string | null }) {
  if (input.unitId) {
    const { rows: [u] } = await tx.query(
      `SELECT u.id, u.label, u.status, rt.id AS "resourceTypeId", rt.name AS "typeName", rt.club_id AS "clubId"
         FROM resource_units u JOIN resource_types rt ON rt.id = u.resource_type_id WHERE u.id = $1`, [input.unitId]);
    if (!u || u.clubId !== clubId) throw new DomainError('NOT_FOUND', 'Matériel introuvable pour ce golf.');
    return { kind: 'maintenance' as const, entityType: 'resource_unit', id: u.id as string, label: `${u.typeName} ${u.label}`,
      resourceTypeId: u.resourceTypeId as string, typeName: u.typeName as string, unitId: u.id as string, caddieId: null };
  }
  if (input.caddieId) {
    const { rows: [c] } = await tx.query('SELECT id, display_name, club_id FROM caddies WHERE id = $1', [input.caddieId]);
    if (!c || c.club_id !== clubId) throw new DomainError('NOT_FOUND', 'Caddie introuvable pour ce golf.');
    const rt = caddieTypes(await listResourceTypes(tx, clubId))[0];
    return { kind: 'unavailable' as const, entityType: 'caddie', id: c.id as string, label: c.display_name as string,
      resourceTypeId: rt?.id ?? null, typeName: rt?.name ?? 'Caddie', unitId: null, caddieId: c.id as string };
  }
  throw new DomainError('VALIDATION', 'Choisir un matériel ou un caddie.');
}

/** Réservations au-delà de la capacité sur la période (pic − capacité). */
async function overflow(tx: Tx, club: Club, resourceTypeId: string, start: Date, end: Date | null): Promise<number> {
  const rt = (await listResourceTypes(tx, club.id, { activeOnly: false })).find((r) => r.id === resourceTypeId);
  if (!rt) return 0;
  const until = end ?? new Date(start.getTime() + 31 * 86_400_000); // horizon raisonnable pour « jusqu'à nouvel ordre »
  const { rows } = await tx.query(
    `SELECT lower(period) AS s, upper(period) AS e, quantity FROM resource_allocations
      WHERE resource_type_id = $1 AND status = 'active' AND period && tstzrange($2, $3, '[)')
     UNION ALL
     SELECT starts_at, coalesce(ends_at, 'infinity'), 1 FROM resource_unavailabilities
      WHERE resource_type_id = $1 AND cancelled_at IS NULL AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')`,
    [resourceTypeId, start, until],
  );
  const usages: Usage[] = rows.map((r) => ({ start: r.s.getTime(), end: Number.isFinite(r.e?.getTime?.()) ? r.e.getTime() : until.getTime(), quantity: r.quantity }));
  const capacity = await capacityOn(tx, rt, instantToLocal(start, club.timezone).date);
  return Math.max(0, peakUsage(usages, start.getTime(), until.getTime()) - capacity);
}

export async function declareUnavailability(db: Db, clubId: string, input: DeclareInput, actor: Actor, now: Date) {
  if (!input.reason.trim()) throw new DomainError('VALIDATION', 'Le motif est obligatoire.');
  if (Number.isNaN(input.startsAt.getTime()) || (input.endsAt && Number.isNaN(input.endsAt.getTime()))) {
    throw new DomainError('VALIDATION', 'Dates invalides.');
  }
  if (input.endsAt && input.endsAt <= input.startsAt) throw new DomainError('VALIDATION', 'La fin doit être après le début.');
  if (input.endsAt && input.endsAt <= now) throw new DomainError('VALIDATION', 'Cette période est déjà terminée.');
  const club = await getClub(db, clubId);
  return withTransaction(db, async (tx) => {
    const target = await resolveTarget(tx, clubId, input);
    // Même ordre de verrous que la réservation : type de ressource, puis unité / caddie.
    if (target.resourceTypeId) await lockResourceTypes(tx, [target.resourceTypeId]);
    if (target.unitId) await lockUnit(tx, target.unitId); else await lockCaddie(tx, target.caddieId!);
    const range = `[${input.startsAt.toISOString()},${input.endsAt ? input.endsAt.toISOString() : ''})`;
    const existing = await unavailabilityDuring(tx, target.unitId ? { unitId: target.unitId } : { caddieId: target.caddieId! }, range);
    if (existing) {
      throw new DomainError('VALIDATION', `${target.label} est déjà indisponible sur cette période (${describeUnavailability(existing, club.timezone)}).`);
    }
    const { rows: [u] } = await tx.query(
      `INSERT INTO resource_unavailabilities (club_id, resource_type_id, unit_id, caddie_id, kind, starts_at, ends_at, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${UNAV_COLUMNS}`,
      [clubId, target.resourceTypeId, target.unitId, target.caddieId, target.kind, input.startsAt, input.endsAt, input.reason.trim().slice(0, 300),
        actor.type === 'user' ? actor.id ?? null : null],
    );
    const affected = await listConflicts(tx, club, now, { unavailabilityId: u.id });
    const over = target.resourceTypeId ? await overflow(tx, club, target.resourceTypeId, input.startsAt, input.endsAt) : 0;
    const s = instantToLocal(input.startsAt, club.timezone);
    const e = input.endsAt ? instantToLocal(input.endsAt, club.timezone) : null;
    await audit(tx, {
      clubId, actor, action: 'resource.unavailability_declared', entityType: target.entityType, entityId: target.id,
      data: { label: target.label, kind: target.kind, from: `${s.date} ${s.time}`, to: e ? `${e.date} ${e.time}` : null,
        affected: affected.flatMap((c) => c.references), overflow: over },
      refs: [...affected.flatMap((c) => c.bookingIds), u.id], reason: input.reason,
    });
    return { unavailability: serializeUnav(u), label: target.label, affected, overflow: over, typeName: target.typeName };
  });
}

function serializeUnav(u: { id: string; kind: Unavailability['kind']; startsAt: Date; endsAt: Date | null; reason: string }): Unavailability {
  return { id: u.id, kind: u.kind, startsAt: u.startsAt.toISOString(), endsAt: u.endsAt ? u.endsAt.toISOString() : null, reason: u.reason };
}

/** Remise en service : termine maintenant (ou annule si elle n'a pas commencé). */
export async function endUnavailability(db: Db, id: string, actor: Actor, now: Date) {
  return withTransaction(db, async (tx) => {
    const { rows: [u] } = await tx.query(
      `SELECT ua.*, coalesce(c.display_name, rt.name || ' ' || un.label) AS label
         FROM resource_unavailabilities ua LEFT JOIN caddies c ON c.id = ua.caddie_id
         LEFT JOIN resource_units un ON un.id = ua.unit_id LEFT JOIN resource_types rt ON rt.id = un.resource_type_id
        WHERE ua.id = $1 FOR UPDATE OF ua`, [id]);
    if (!u || u.cancelled_at) throw new DomainError('NOT_FOUND', 'Indisponibilité introuvable.');
    if (u.ends_at && u.ends_at <= now) throw new DomainError('VALIDATION', 'Cette indisponibilité est déjà terminée.');
    if (u.resource_type_id) await lockResourceTypes(tx, [u.resource_type_id]);
    const cancelled = u.starts_at >= now;
    if (cancelled) await tx.query('UPDATE resource_unavailabilities SET cancelled_at = $2 WHERE id = $1', [id, now]);
    else await tx.query('UPDATE resource_unavailabilities SET ends_at = $2 WHERE id = $1', [id, now]);
    await audit(tx, {
      clubId: u.club_id, actor, action: 'resource.unavailability_ended', entityType: u.unit_id ? 'resource_unit' : 'caddie',
      entityId: u.unit_id ?? u.caddie_id, data: { label: u.label, kind: u.kind, cancelled }, refs: [id],
    });
    return { clubId: u.club_id as string, cancelled };
  });
}

export async function clubOfUnavailability(q: Queryable, id: string): Promise<string> {
  const { rows } = await q.query('SELECT club_id FROM resource_unavailabilities WHERE id = $1', [id]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Indisponibilité introuvable.');
  return rows[0].club_id;
}

// ---------------------------------------------------------------------------
// Tableau du jour

export async function getResourceBoard(q: Queryable, club: Club, date: string, now: Date) {
  const tz = club.timezone;
  const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day');
  if (!dayStart.isValid) throw new DomainError('VALIDATION', 'Date invalide.');
  const start = dayStart.toJSDate();
  const end = dayStart.plus({ days: 1 }).toJSDate();
  const isToday = now >= start && now < end;
  // Fenêtre d'analyse : à partir de maintenant pour aujourd'hui, toute la journée sinon.
  const from = isToday ? now : start;
  const types = await listResourceTypes(q, club.id);

  const { rows: allocs } = await q.query(
    `SELECT a.id, a.resource_type_id AS "rt", a.quantity, lower(a.period) AS s, upper(a.period) AS e,
            a.tee_time_id AS "teeTimeId", a.booking_id AS "bookingId",
            coalesce(t.id, bt.id) AS "ttId", coalesce(t.starts_at, bt.starts_at) AS "teeAt",
            b.reference, coalesce(t.caddie_id, NULL) AS "caddieId"
       FROM resource_allocations a
       LEFT JOIN tee_times t ON t.id = a.tee_time_id
       LEFT JOIN bookings b ON b.id = a.booking_id
       LEFT JOIN tee_times bt ON bt.id = b.tee_time_id
      WHERE a.club_id = $1 AND a.status = 'active' AND a.period && tstzrange($2, $3, '[)')`,
    [club.id, start, end],
  );
  const { rows: unavs } = await q.query(
    `SELECT ua.id, ua.resource_type_id AS rt, ua.unit_id AS "unitId", ua.caddie_id AS "caddieId", ua.kind,
            ua.starts_at AS "startsAt", ua.ends_at AS "endsAt", ua.reason
       FROM resource_unavailabilities ua
      WHERE ua.club_id = $1 AND ua.cancelled_at IS NULL AND tstzrange(ua.starts_at, ua.ends_at, '[)') && tstzrange($2, $3, '[)')`,
    [club.id, start, end],
  );
  const toUsage = (s: Date, e: Date | null, quantity: number): Usage => ({ start: s.getTime(), end: e ? e.getTime() : end.getTime() + 1, quantity });
  const covers = (s: Date, e: Date | null, t: Date) => s <= t && (!e || e > t);

  const typeRows = [];
  for (const rt of types) {
    const capacity = await capacityOn(q, rt, date);
    const a = allocs.filter((x) => x.rt === rt.id);
    const u = unavs.filter((x) => x.rt === rt.id);
    const allocUsages = a.map((x) => toUsage(x.s, x.e, x.quantity));
    const unavUsages = u.map((x) => toUsage(x.startsAt, x.endsAt, 1));
    const reservedPeak = peakUsage(allocUsages, from.getTime(), end.getTime());
    const unavailablePeak = peakUsage(unavUsages, from.getTime(), end.getTime());
    const lowest = Math.max(0, capacity - peakUsage([...allocUsages, ...unavUsages], from.getTime(), end.getTime()));
    const inUse = isToday ? a.filter((x) => covers(x.s, x.e, now)).reduce((n, x) => n + x.quantity, 0) : null;
    const unavailableNow = isToday ? u.filter((x) => covers(x.startsAt, x.endsAt, now)).length : null;
    typeRows.push({
      id: rt.id, code: rt.code, kind: rt.kind, name: rt.name, variant: rt.variant, scope: rt.scope, capacity,
      reservedPeak, unavailablePeak, lowestAvailable: lowest, inUseNow: inUse, unavailableNow,
      availableNow: isToday ? Math.max(0, capacity - inUse! - unavailableNow!) : null,
      reservations: a.length,
    });
  }

  const statusOf = (assignments: Array<{ s: Date; e: Date }>, unav: { startsAt: Date; endsAt: Date | null } | undefined, retired = false): ResourceStatus => {
    if (retired) return 'unavailable';
    if (isToday) {
      if (unav && covers(unav.startsAt, unav.endsAt, now)) return 'unavailable';
      if (assignments.some((x) => covers(x.s, x.e, now))) return 'in_use';
      if (assignments.some((x) => x.s > now)) return 'reserved';
      return 'available';
    }
    if (unav) return 'unavailable';
    return assignments.length ? 'reserved' : 'available';
  };

  const { rows: unitRows } = await q.query(
    `SELECT u.id, u.label, u.status, rt.id AS "resourceTypeId", rt.name AS "typeName"
       FROM resource_units u JOIN resource_types rt ON rt.id = u.resource_type_id
      WHERE rt.club_id = $1 AND rt.active ORDER BY rt.sort_order, u.label`, [club.id]);
  const { rows: unitAssign } = await q.query(
    `SELECT au.unit_id AS "unitId", a.id AS "allocationId", lower(a.period) AS s, upper(a.period) AS e, b.id AS "bookingId", b.reference
       FROM allocation_units au JOIN resource_allocations a ON a.id = au.allocation_id AND a.status = 'active'
       JOIN bookings b ON b.id = a.booking_id
      WHERE a.club_id = $1 AND a.period && tstzrange($2, $3, '[)') ORDER BY lower(a.period)`, [club.id, start, end]);
  const units = unitRows.map((u) => {
    const assignments = unitAssign.filter((x) => x.unitId === u.id);
    const unav = unavs.find((x) => x.unitId === u.id && (!isToday || covers(x.startsAt, x.endsAt, now) || x.startsAt > now))
      ?? unavs.find((x) => x.unitId === u.id);
    return {
      id: u.id, label: u.label, resourceTypeId: u.resourceTypeId, typeName: u.typeName, retired: u.status === 'retired',
      status: statusOf(assignments, unav, u.status === 'retired'),
      unavailability: unav ? { ...serializeUnav(unav), text: describeUnavailability(unav, tz) } : null,
      assignments: assignments.map((x) => ({ allocationId: x.allocationId, bookingId: x.bookingId, reference: x.reference,
        from: instantToLocal(x.s, tz).time, to: when(x.e, tz, date) })),
    };
  });

  const { rows: caddieRows } = await q.query(
    'SELECT id, display_name AS "displayName" FROM caddies WHERE club_id = $1 AND active ORDER BY display_name', [club.id]);
  const caddieAlloc = allocs.filter((x) => x.caddieId);
  const caddies = caddieRows.map((c) => {
    const assignments = caddieAlloc.filter((x) => x.caddieId === c.id);
    const mine = unavs.filter((x) => x.caddieId === c.id);
    const unav = mine.find((x) => !isToday || covers(x.startsAt, x.endsAt, now) || x.startsAt > now) ?? mine[0];
    return {
      id: c.id, displayName: c.displayName, status: statusOf(assignments, unav),
      unavailability: unav ? { ...serializeUnav(unav), text: describeUnavailability(unav, tz) } : null,
      assignments: assignments.map((x) => ({ teeTimeId: x.ttId, from: instantToLocal(x.s, tz).time, to: when(x.e, tz, date) })),
    };
  });

  const { rows: upcoming } = await q.query(
    `SELECT ua.id, ua.kind, ua.starts_at AS "startsAt", ua.ends_at AS "endsAt", ua.reason,
            coalesce(c.display_name, rt.name || ' ' || un.label) AS label, ua.unit_id AS "unitId", ua.caddie_id AS "caddieId",
            u.display_name AS "createdBy"
       FROM resource_unavailabilities ua LEFT JOIN caddies c ON c.id = ua.caddie_id
       LEFT JOIN resource_units un ON un.id = ua.unit_id LEFT JOIN resource_types rt ON rt.id = un.resource_type_id
       LEFT JOIN users u ON u.id = ua.created_by
      WHERE ua.club_id = $1 AND ua.cancelled_at IS NULL AND (ua.ends_at IS NULL OR ua.ends_at > $2)
      ORDER BY ua.starts_at`, [club.id, now]);

  return {
    date, isToday, now: now.toISOString(),
    types: typeRows, units, caddies,
    unavailabilities: upcoming.map((x) => ({ ...serializeUnav(x), label: x.label, unitId: x.unitId, caddieId: x.caddieId,
      createdBy: x.createdBy, text: describeUnavailability(x, tz), active: x.startsAt <= now })),
    conflicts: await listConflicts(q, club, now),
  };
}
