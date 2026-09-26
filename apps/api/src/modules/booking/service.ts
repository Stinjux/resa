// Service de réservation : seule porte d'entrée pour créer, modifier,
// déplacer (réunir) ou annuler une réservation.
//
// Protection contre la surréservation :
//  1. le départ est créé s'il n'existe pas (INSERT … ON CONFLICT DO NOTHING)
//     puis verrouillé (SELECT … FOR UPDATE) : toutes les écritures sur un même
//     départ sont sérialisées ;
//  2. les types de ressources (caddie, matériel) sont verrouillés ensuite par
//     verrou consultatif, dans un ordre fixe ;
//  3. les règles sont vérifiées sur l'état relu SOUS verrou, puis écrites.
// Ordre des verrous : départs (par id) → types de ressources (par id).

import type { Db, Tx } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { usagePeriod } from '../../domain/resource-usage.js';
import {
  applyJoin,
  assertCanJoin,
  assertValidPlayers,
  type Holes,
  type TeeTimeState,
} from '../../domain/tee-time-rules.js';
import { audit, type Actor } from '../../shared/audit.js';
import { DomainError } from '../../shared/errors.js';
import { instantToLocal } from '../../shared/time.js';
import {
  getClub,
  getCourse,
  listResourceTypes,
  type Club,
  type Course,
  type ResourceType,
} from '../catalog/repository.js';
import {
  lockResourceTypes,
  releaseBookingAllocations,
  releaseTeeTimeAllocations,
  reserve,
} from '../resources/service.js';
import { syncOrder, syncOrders } from '../orders/service.js';
import { recomputeTeeTimeCharges } from '../pricing/service.js';
import { caddieTypes, computeGrid, type GridSlot } from '../teesheet/service.js';
import type { Payable } from '../../domain/pricing.js';

export type Channel = 'web' | 'phone' | 'group' | 'walk_in' | 'staff' | 'whatsapp' | 'sms';

export interface OptionRequest {
  resourceTypeId?: string;
  code?: string;
  quantity: number;
}

export interface BookingItemInput {
  courseId: string;
  startsAt: Date;
  players: number;
  holes: Holes;
  isPrivate?: boolean;
  options?: OptionRequest[];
  playerNames?: Array<string | null>;
  notes?: string | null;
  /** Catégorie tarifaire (ex. standard, resident). Le web impose 'standard'. */
  customerCategory?: string;
  /** Caddie payé avec la réservation ou sur place (défaut : réglage du golf). */
  caddiePayment?: Payable;
}

export interface CustomerInput {
  firstName?: string | null;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  preferredLocale?: string | null;
}

export interface BookingContext {
  channel: Channel;
  actor: Actor;
  customerId?: string | null;
  customer?: CustomerInput | null;
  idempotencyKey?: string | null;
}

export interface BookingDeps {
  db: Db;
  now: () => Date;
}

// ---------------------------------------------------------------------------
// Transactions avec reprise sur interblocage / conflit de sérialisation.

const RETRYABLE = new Set(['40P01', '40001']);

async function runTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(db, fn);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (attempt < 4 && code && RETRYABLE.has(code)) continue;
      throw err;
    }
  }
}

/** Recalcule les prix de tout le départ et aligne les commandes concernées. */
async function reprice(tx: Tx, teeTimeId: string, club: Club, course: Course) {
  const quotes = await recomputeTeeTimeCharges(tx, teeTimeId, club, course);
  await syncOrders(tx, quotes.keys());
  return quotes;
}

/** Frais d'annulation selon la politique du golf (0 dans le délai gratuit). */
export function cancellationFee(club: Pick<Club, 'cancellationFreeHours' | 'cancellationFeePercent'>, startsAt: Date, now: Date, totalMinor: number): number {
  const deadline = startsAt.getTime() - club.cancellationFreeHours * 3_600_000;
  if (now.getTime() < deadline) return 0;
  return Math.round((totalMinor * club.cancellationFeePercent) / 100);
}

function isIdempotencyConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'bookings_club_id_idempotency_key_key';
}

// ---------------------------------------------------------------------------
// Lecture

export interface BookingDetail {
  id: string;
  reference: string;
  clubId: string;
  status: 'confirmed' | 'cancelled';
  channel: Channel;
  players: number;
  holes: Holes;
  isPrivate: boolean;
  groupId: string | null;
  notes: string | null;
  customerId: string | null;
  teeTime: { id: string; courseId: string; startsAt: string; localDate: string; localTime: string };
  playerNames: Array<string | null>;
  options: Array<{ resourceTypeId: string; code: string; name: string; quantity: number }>;
  customerCategory: string;
  caddiePayment: Payable;
  pricing: {
    currency: string | null;
    totalMinor: number | null;
    dueWithBookingMinor: number | null;
    dueOnSiteMinor: number | null;
    lines: Array<{
      kind: string;
      label: string;
      quantity: number;
      unitAmountMinor: number;
      totalMinor: number;
      taxMinor: number;
      payable: Payable;
    }>;
  };
  createdAt: string;
  cancelledAt: string | null;
}

export async function getBooking(q: Db | Tx, bookingId: string): Promise<BookingDetail> {
  const { rows } = await q.query(
    `SELECT b.id, b.reference, b.club_id AS "clubId", b.status, b.channel, b.players, b.holes,
            b.is_private AS "isPrivate", b.group_id AS "groupId", b.notes, b.customer_id AS "customerId",
            b.created_at AS "createdAt", b.cancelled_at AS "cancelledAt",
            b.customer_category AS "customerCategory", b.caddie_payment AS "caddiePayment",
            b.currency, b.total_minor AS "totalMinor", b.due_with_booking_minor AS "dueWithBookingMinor",
            b.due_on_site_minor AS "dueOnSiteMinor",
            t.id AS "teeTimeId", t.course_id AS "courseId", t.starts_at AS "startsAt",
            t.local_date AS "localDate", c.timezone
       FROM bookings b
       JOIN tee_times t ON t.id = b.tee_time_id
       JOIN clubs c ON c.id = b.club_id
      WHERE b.id = $1`,
    [bookingId],
  );
  const b = rows[0];
  if (!b) throw new DomainError('NOT_FOUND', 'Réservation introuvable.');
  const players = await q.query('SELECT position, name FROM booking_players WHERE booking_id = $1 ORDER BY position', [
    bookingId,
  ]);
  const options = await q.query(
    `SELECT rt.id AS "resourceTypeId", rt.code, rt.name, sum(a.quantity)::int AS quantity
       FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id
      WHERE a.booking_id = $1 AND a.status = 'active'
      GROUP BY rt.id, rt.code, rt.name, rt.sort_order ORDER BY rt.sort_order`,
    [bookingId],
  );
  const charges = await q.query(
    `SELECT kind, label, quantity, unit_amount_minor AS "unitAmountMinor", total_minor AS "totalMinor",
            tax_minor AS "taxMinor", payable
       FROM booking_charges WHERE booking_id = $1 ORDER BY position`,
    [bookingId],
  );
  return {
    id: b.id,
    reference: b.reference,
    clubId: b.clubId,
    status: b.status,
    channel: b.channel,
    players: b.players,
    holes: b.holes,
    isPrivate: b.isPrivate,
    groupId: b.groupId,
    notes: b.notes,
    customerId: b.customerId,
    teeTime: {
      id: b.teeTimeId,
      courseId: b.courseId,
      startsAt: b.startsAt.toISOString(),
      localDate: b.localDate,
      localTime: instantToLocal(b.startsAt, b.timezone).time,
    },
    playerNames: players.rows.map((p) => p.name),
    options: options.rows,
    customerCategory: b.customerCategory,
    caddiePayment: b.caddiePayment,
    pricing: {
      currency: b.currency,
      totalMinor: b.totalMinor,
      dueWithBookingMinor: b.dueWithBookingMinor,
      dueOnSiteMinor: b.dueOnSiteMinor,
      lines: charges.rows,
    },
    createdAt: b.createdAt.toISOString(),
    cancelledAt: b.cancelledAt ? b.cancelledAt.toISOString() : null,
  };
}

async function findByIdempotencyKey(db: Db, key: string): Promise<BookingDetail[] | null> {
  const { rows } = await db.query(
    `SELECT id, group_id AS "groupId" FROM bookings WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  if (!rows[0]) return null;
  if (!rows[0].groupId) return [await getBooking(db, rows[0].id)];
  const group = await db.query('SELECT id FROM bookings WHERE group_id = $1 ORDER BY created_at, id', [rows[0].groupId]);
  return Promise.all(group.rows.map((r) => getBooking(db, r.id)));
}

// ---------------------------------------------------------------------------
// Utilitaires internes (toujours appelés dans une transaction)

interface LockedTeeTime {
  id: string;
  clubId: string;
  courseId: string;
  startsAt: Date;
  localDate: string;
  maxPlayers: number;
  holes: Holes | null;
  isPrivate: boolean;
  blockedReason: string | null;
}

async function upsertTeeTime(tx: Tx, club: Club, course: Course, slot: GridSlot, localDate: string): Promise<string> {
  await tx.query(
    `INSERT INTO tee_times (club_id, course_id, starts_at, local_date, max_players)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (course_id, starts_at) DO NOTHING`,
    [club.id, course.id, slot.startsAt, localDate, slot.maxPlayers],
  );
  const { rows } = await tx.query('SELECT id FROM tee_times WHERE course_id = $1 AND starts_at = $2', [
    course.id,
    slot.startsAt,
  ]);
  return rows[0].id;
}

function assertNotBlocked(teeTime: LockedTeeTime): void {
  if (teeTime.blockedReason) {
    throw new DomainError('TEE_TIME_BLOCKED', `Départ bloqué : ${teeTime.blockedReason}`, { reason: teeTime.blockedReason });
  }
}

async function lockTeeTimes(tx: Tx, ids: string[]): Promise<Map<string, LockedTeeTime>> {
  const { rows } = await tx.query<LockedTeeTime>(
    `SELECT id, club_id AS "clubId", course_id AS "courseId", starts_at AS "startsAt", local_date AS "localDate",
            max_players AS "maxPlayers", holes, is_private AS "isPrivate", blocked_reason AS "blockedReason"
       FROM tee_times WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
    [[...new Set(ids)]],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** État d'occupation relu sous verrou, en excluant éventuellement une réservation. */
async function occupancy(
  tx: Tx,
  teeTime: LockedTeeTime,
  excludeBookingId: string | null = null,
): Promise<TeeTimeState> {
  const { rows } = await tx.query(
    `SELECT coalesce(sum(players), 0)::int AS booked, coalesce(bool_or(is_private), false) AS private
       FROM bookings
      WHERE tee_time_id = $1 AND status = 'confirmed' AND ($2::uuid IS NULL OR id <> $2)`,
    [teeTime.id, excludeBookingId],
  );
  const booked: number = rows[0].booked;
  return {
    maxPlayers: teeTime.maxPlayers,
    holes: booked > 0 ? teeTime.holes : null,
    isPrivate: booked > 0 && rows[0].private,
    bookedPlayers: booked,
  };
}

async function hasActiveTeeTimeAllocation(tx: Tx, teeTimeId: string, resourceTypeId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM resource_allocations
      WHERE tee_time_id = $1 AND resource_type_id = $2 AND status = 'active'`,
    [teeTimeId, resourceTypeId],
  );
  return (rowCount ?? 0) > 0;
}

/** Réserve le caddie du départ s'il ne l'est pas déjà (un seul par départ). */
async function ensureCaddie(
  tx: Tx,
  teeTime: LockedTeeTime,
  course: Course,
  holes: Holes,
  caddieRts: ResourceType[],
): Promise<void> {
  for (const rt of caddieRts) {
    if (await hasActiveTeeTimeAllocation(tx, teeTime.id, rt.id)) continue;
    const p = usagePeriod(teeTime.startsAt, holes, course, rt.bufferMinutes);
    await reserve(tx, {
      resourceType: rt,
      clubId: teeTime.clubId,
      date: teeTime.localDate,
      start: p.start,
      end: p.end,
      quantity: 1,
      teeTimeId: teeTime.id,
    });
  }
}

interface ResolvedOption {
  rt: ResourceType;
  quantity: number;
}

function resolveOptions(options: OptionRequest[] | undefined, resourceTypes: ResourceType[]): ResolvedOption[] {
  const merged = new Map<string, ResolvedOption>();
  for (const o of options ?? []) {
    const rt = resourceTypes.find((r) => (o.resourceTypeId ? r.id === o.resourceTypeId : r.code === o.code));
    if (!rt) throw new DomainError('VALIDATION', `Option inconnue : ${o.resourceTypeId ?? o.code}`);
    if (rt.scope !== 'booking') {
      throw new DomainError('VALIDATION', `${rt.name} n'est pas une option réservable par réservation.`);
    }
    if (!Number.isInteger(o.quantity) || o.quantity < 0) {
      throw new DomainError('VALIDATION', `Quantité invalide pour ${rt.name}.`);
    }
    const quantity = (merged.get(rt.id)?.quantity ?? 0) + o.quantity;
    if (rt.maxPerBooking !== null && quantity > rt.maxPerBooking) {
      throw new DomainError('VALIDATION', `${rt.name} : maximum ${rt.maxPerBooking} par réservation.`);
    }
    merged.set(rt.id, { rt, quantity });
  }
  return [...merged.values()].filter((o) => o.quantity > 0);
}

async function reserveOptions(
  tx: Tx,
  teeTime: LockedTeeTime,
  course: Course,
  holes: Holes,
  bookingId: string,
  options: ResolvedOption[],
): Promise<void> {
  for (const { rt, quantity } of options) {
    const p = usagePeriod(teeTime.startsAt, holes, course, rt.bufferMinutes);
    await reserve(tx, {
      resourceType: rt,
      clubId: teeTime.clubId,
      date: teeTime.localDate,
      start: p.start,
      end: p.end,
      quantity,
      bookingId,
    });
  }
}

async function currentOptions(tx: Tx, bookingId: string, resourceTypes: ResourceType[]): Promise<ResolvedOption[]> {
  const { rows } = await tx.query(
    `SELECT resource_type_id AS id, sum(quantity)::int AS quantity FROM resource_allocations
      WHERE booking_id = $1 AND status = 'active' GROUP BY resource_type_id`,
    [bookingId],
  );
  return rows.map((r) => ({ rt: resourceTypes.find((t) => t.id === r.id)!, quantity: r.quantity }));
}

/** Aligne l'état du départ sur ses réservations confirmées ; libère le caddie
 *  quand le départ redevient vide. */
async function syncTeeTime(tx: Tx, teeTimeId: string): Promise<void> {
  const { rows } = await tx.query(
    `SELECT count(*)::int AS n, coalesce(bool_or(is_private), false) AS private, max(holes) AS holes
       FROM bookings WHERE tee_time_id = $1 AND status = 'confirmed'`,
    [teeTimeId],
  );
  const { n, private: isPrivate, holes } = rows[0];
  if (n === 0) {
    await releaseTeeTimeAllocations(tx, teeTimeId);
    await tx.query(
      `UPDATE tee_times SET holes = NULL, is_private = false, caddie_id = NULL, updated_at = now() WHERE id = $1`,
      [teeTimeId],
    );
  } else {
    await tx.query(`UPDATE tee_times SET holes = $2, is_private = $3, updated_at = now() WHERE id = $1`, [
      teeTimeId,
      holes,
      isPrivate,
    ]);
  }
}

async function resolveSlot(
  tx: Tx,
  club: Club,
  course: Course,
  startsAt: Date,
  gridCache: Map<string, GridSlot[]>,
): Promise<{ slot: GridSlot; localDate: string }> {
  if (Number.isNaN(startsAt.getTime())) throw new DomainError('VALIDATION', 'Heure de départ invalide.');
  const localDate = instantToLocal(startsAt, club.timezone).date;
  const key = `${course.id}|${localDate}`;
  let grid = gridCache.get(key);
  if (!grid) {
    grid = await computeGrid(tx, club, course, localDate);
    gridCache.set(key, grid);
  }
  const slot = grid.find((s) => s.startsAt.getTime() === startsAt.getTime());
  if (!slot) throw new DomainError('SLOT_NOT_AVAILABLE', "Ce créneau n'existe pas ou le parcours est fermé.");
  return { slot, localDate };
}

function assertBookingWindow(club: Club, startsAt: Date, now: Date, channel: Channel): void {
  if (startsAt.getTime() <= now.getTime()) {
    throw new DomainError('OUTSIDE_BOOKING_WINDOW', 'Ce départ est déjà passé.');
  }
  if (channel !== 'web') return; // Le personnel n'est pas soumis au délai ni à l'horizon.
  if (startsAt.getTime() < now.getTime() + club.minLeadMinutes * 60_000) {
    throw new DomainError('OUTSIDE_BOOKING_WINDOW', 'Délai minimal de réservation dépassé.');
  }
  if (startsAt.getTime() > now.getTime() + club.bookingHorizonDays * 86_400_000) {
    throw new DomainError('OUTSIDE_BOOKING_WINDOW', 'Date au-delà de la période de réservation ouverte.');
  }
}

async function nextReference(tx: Tx, club: Club): Promise<string> {
  const { rows } = await tx.query(`SELECT nextval('booking_reference_seq') AS n`);
  return `${club.code}-${String(rows[0].n).padStart(6, '0')}`;
}

async function resolveCustomer(tx: Tx, club: Club, ctx: BookingContext): Promise<string | null> {
  if (ctx.customerId) {
    const { rowCount } = await tx.query('SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2', [
      ctx.customerId,
      club.organizationId,
    ]);
    if (!rowCount) throw new DomainError('NOT_FOUND', 'Client introuvable.');
    return ctx.customerId;
  }
  if (!ctx.customer) return null;
  const c = ctx.customer;
  const { rows } = await tx.query(
    `INSERT INTO customers (organization_id, first_name, last_name, email, phone, preferred_locale)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [club.organizationId, c.firstName ?? null, c.lastName, c.email ?? null, c.phone ?? null, c.preferredLocale ?? null],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Création (simple ou groupe)

async function placeBookings(
  tx: Tx,
  deps: BookingDeps,
  ctx: BookingContext,
  items: BookingItemInput[],
  groupId: string | null,
): Promise<string[]> {
  if (items.length === 0) throw new DomainError('VALIDATION', 'Aucun départ demandé.');
  const now = deps.now();

  // 1. Résolution : parcours, golf unique, créneau de la grille.
  const courses = new Map<string, Course>();
  let club: Club | null = null;
  const gridCache = new Map<string, GridSlot[]>();
  const resolved: Array<{ item: BookingItemInput; course: Course; slot: GridSlot; localDate: string }> = [];
  for (const item of items) {
    assertValidPlayers(item.players);
    if (item.holes !== 9 && item.holes !== 18) throw new DomainError('VALIDATION', 'Formule : 9 ou 18 trous.');
    const course = courses.get(item.courseId) ?? (await getCourse(tx, item.courseId));
    courses.set(course.id, course);
    club ??= await getClub(tx, course.clubId);
    if (course.clubId !== club.id) throw new DomainError('VALIDATION', 'Tous les départs doivent être dans le même golf.');
    assertBookingWindow(club, item.startsAt, now, ctx.channel);
    const { slot, localDate } = await resolveSlot(tx, club, course, item.startsAt, gridCache);
    if (!slot.allowedHoles.includes(item.holes)) {
      throw new DomainError('HOLES_NOT_ALLOWED', `Formule ${item.holes} trous non proposée sur ce créneau.`);
    }
    resolved.push({ item, course, slot, localDate });
  }
  const theClub = club!;

  // 2. Départs : création si besoin, puis verrou.
  const teeTimeIds: string[] = [];
  for (const r of resolved) teeTimeIds.push(await upsertTeeTime(tx, theClub, r.course, r.slot, r.localDate));
  const locked = await lockTeeTimes(tx, teeTimeIds);
  const states = new Map<string, TeeTimeState>();
  for (const [i, id] of teeTimeIds.entries()) {
    if (states.has(id)) continue;
    const state = await occupancy(tx, locked.get(id)!);
    // Départ vide : la capacité suit la grille en vigueur.
    if (state.bookedPlayers === 0) state.maxPlayers = resolved[i]!.slot.maxPlayers;
    states.set(id, state);
  }

  // 3. Ressources : verrou puis vérification sous verrou.
  const resourceTypes = await listResourceTypes(tx, theClub.id);
  const caddieRts = caddieTypes(resourceTypes);
  const optionsPerItem = resolved.map((r) => resolveOptions(r.item.options, resourceTypes));
  await lockResourceTypes(tx, [...caddieRts.map((r) => r.id), ...optionsPerItem.flat().map((o) => o.rt.id)]);

  const customerId = await resolveCustomer(tx, theClub, ctx);

  // 4. Règles + écriture, dans l'ordre de la demande.
  const bookingIds: string[] = [];
  for (const [i, r] of resolved.entries()) {
    const teeTime = locked.get(teeTimeIds[i]!)!;
    const req = { players: r.item.players, holes: r.item.holes, isPrivate: r.item.isPrivate ?? false };
    const state = states.get(teeTime.id)!;
    assertNotBlocked(teeTime);
    assertCanJoin(state, req);
    states.set(teeTime.id, applyJoin(state, req));
    if (state.bookedPlayers === 0) {
      await tx.query('UPDATE tee_times SET max_players = $2 WHERE id = $1', [teeTime.id, state.maxPlayers]);
    }

    const reference = await nextReference(tx, theClub);
    const idempotencyKey = ctx.idempotencyKey ? (i === 0 ? ctx.idempotencyKey : `${ctx.idempotencyKey}#${i}`) : null;
    const { rows } = await tx.query(
      `INSERT INTO bookings (reference, club_id, tee_time_id, customer_id, channel, players, holes, is_private,
                             group_id, notes, idempotency_key, customer_category, caddie_payment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        reference,
        theClub.id,
        teeTime.id,
        customerId,
        ctx.channel,
        req.players,
        req.holes,
        req.isPrivate,
        groupId,
        r.item.notes ?? null,
        idempotencyKey,
        ctx.channel === 'web' ? 'standard' : (r.item.customerCategory ?? 'standard'),
        r.item.caddiePayment ?? theClub.defaultCaddiePayment,
      ],
    );
    const bookingId: string = rows[0].id;
    for (let p = 1; p <= req.players; p++) {
      await tx.query('INSERT INTO booking_players (booking_id, position, name) VALUES ($1, $2, $3)', [
        bookingId,
        p,
        r.item.playerNames?.[p - 1] ?? null,
      ]);
    }

    await ensureCaddie(tx, teeTime, r.course, req.holes, caddieRts);
    await reserveOptions(tx, teeTime, r.course, req.holes, bookingId, optionsPerItem[i]!);
    await syncTeeTime(tx, teeTime.id);
    const priced = (await reprice(tx, teeTime.id, theClub, r.course)).get(bookingId)!;

    await audit(tx, {
      clubId: theClub.id,
      actor: ctx.actor,
      action: 'booking.created',
      entityType: 'booking',
      entityId: bookingId,
      data: {
        reference,
        teeTimeId: teeTime.id,
        startsAt: teeTime.startsAt.toISOString(),
        players: req.players,
        holes: req.holes,
        isPrivate: req.isPrivate,
        channel: ctx.channel,
        groupId,
        options: optionsPerItem[i]!.map((o) => ({ code: o.rt.code, quantity: o.quantity })),
        totalMinor: priced.totalMinor,
        currency: priced.currency,
      },
    });
    bookingIds.push(bookingId);
  }
  return bookingIds;
}

export async function createBooking(
  deps: BookingDeps,
  ctx: BookingContext,
  item: BookingItemInput,
): Promise<{ booking: BookingDetail; replayed: boolean }> {
  if (ctx.idempotencyKey) {
    const existing = await findByIdempotencyKey(deps.db, ctx.idempotencyKey);
    if (existing?.[0]) return { booking: existing[0], replayed: true };
  }
  try {
    const [id] = await runTx(deps.db, (tx) => placeBookings(tx, deps, ctx, [item], null));
    return { booking: await getBooking(deps.db, id!), replayed: false };
  } catch (err) {
    if (ctx.idempotencyKey && isIdempotencyConflict(err)) {
      const existing = await findByIdempotencyKey(deps.db, ctx.idempotencyKey);
      if (existing?.[0]) return { booking: existing[0], replayed: true };
    }
    throw err;
  }
}

/** Réservation de groupe : plusieurs départs, tout ou rien. */
export async function createGroupBooking(
  deps: BookingDeps,
  ctx: BookingContext,
  items: BookingItemInput[],
): Promise<{ groupId: string; bookings: BookingDetail[]; replayed: boolean }> {
  if (ctx.idempotencyKey) {
    const existing = await findByIdempotencyKey(deps.db, ctx.idempotencyKey);
    if (existing?.length) return { groupId: existing[0]!.groupId!, bookings: existing, replayed: true };
  }
  const groupId = crypto.randomUUID();
  try {
    const ids = await runTx(deps.db, (tx) => placeBookings(tx, deps, ctx, items, groupId));
    return { groupId, bookings: await Promise.all(ids.map((id) => getBooking(deps.db, id))), replayed: false };
  } catch (err) {
    if (ctx.idempotencyKey && isIdempotencyConflict(err)) {
      const existing = await findByIdempotencyKey(deps.db, ctx.idempotencyKey);
      if (existing?.length) return { groupId: existing[0]!.groupId!, bookings: existing, replayed: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Modification, déplacement / réunion, annulation

interface LockedBooking {
  id: string;
  clubId: string;
  teeTimeId: string;
  status: 'confirmed' | 'cancelled';
  players: number;
  holes: Holes;
  isPrivate: boolean;
  reference: string;
}

async function readBookingForUpdate(tx: Tx, bookingId: string): Promise<LockedBooking> {
  const { rows } = await tx.query<LockedBooking>(
    `SELECT id, club_id AS "clubId", tee_time_id AS "teeTimeId", status, players, holes,
            is_private AS "isPrivate", reference
       FROM bookings WHERE id = $1 FOR UPDATE`,
    [bookingId],
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Réservation introuvable.');
  return rows[0];
}

/** Verrouille le(s) départ(s) puis la réservation, en vérifiant qu'elle n'a pas
 *  été déplacée entre-temps (sinon on recommence). */
async function lockBookingWith(
  tx: Tx,
  bookingId: string,
  extraTeeTimeIds: string[] = [],
): Promise<{ booking: LockedBooking; teeTimes: Map<string, LockedTeeTime> }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows } = await tx.query('SELECT tee_time_id FROM bookings WHERE id = $1', [bookingId]);
    if (!rows[0]) throw new DomainError('NOT_FOUND', 'Réservation introuvable.');
    const teeTimes = await lockTeeTimes(tx, [rows[0].tee_time_id, ...extraTeeTimeIds]);
    const booking = await readBookingForUpdate(tx, bookingId);
    if (teeTimes.has(booking.teeTimeId)) return { booking, teeTimes };
  }
  throw Object.assign(new Error('Réservation modifiée en parallèle'), { code: '40001' });
}

export async function cancelBooking(
  deps: BookingDeps,
  bookingId: string,
  opts: { actor: Actor; reason?: string | null; waiveFee?: boolean },
): Promise<BookingDetail> {
  await runTx(deps.db, async (tx) => {
    const { booking, teeTimes } = await lockBookingWith(tx, bookingId);
    if (booking.status === 'cancelled') return; // idempotent
    const club = await getClub(tx, booking.clubId);
    const { rows: [t] } = await tx.query('SELECT coalesce(total_minor, 0) AS total FROM bookings WHERE id = $1', [bookingId]);
    const fee = opts.waiveFee ? 0 : cancellationFee(club, teeTimes.get(booking.teeTimeId)!.startsAt, deps.now(), t.total);
    await tx.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, cancellation_fee_minor = $3,
              updated_at = now()
        WHERE id = $1`,
      [bookingId, opts.reason ?? null, fee],
    );
    const released = await releaseBookingAllocations(tx, bookingId);
    await syncTeeTime(tx, booking.teeTimeId);
    // Les réservations restantes se partagent désormais le caddie.
    const tt = teeTimes.get(booking.teeTimeId)!;
    await reprice(tx, tt.id, club, await getCourse(tx, tt.courseId));
    await syncOrder(tx, bookingId); // commande : frais d'annulation éventuels
    await audit(tx, {
      clubId: booking.clubId,
      actor: opts.actor,
      action: 'booking.cancelled',
      entityType: 'booking',
      entityId: bookingId,
      data: { reference: booking.reference, teeTimeId: booking.teeTimeId, releasedAllocations: released, reason: opts.reason ?? null,
        cancellationFeeMinor: fee, feeWaived: !!opts.waiveFee },
    });
  });
  return getBooking(deps.db, bookingId);
}

export type MoveTarget = { teeTimeId: string } | { courseId: string; startsAt: Date };

/**
 * Déplace une réservation vers un autre départ. Sert aussi à réunir deux
 * réservations : on déplace l'une sur le départ de l'autre. Chaque réservation
 * garde son identité (référence, client, options, facturation) ; le départ
 * cible garde son unique caddie.
 */
export async function moveBooking(
  deps: BookingDeps,
  bookingId: string,
  target: MoveTarget,
  opts: { actor: Actor },
): Promise<BookingDetail> {
  await runTx(deps.db, async (tx) => {
    const { rows } = await tx.query('SELECT club_id FROM bookings WHERE id = $1', [bookingId]);
    if (!rows[0]) throw new DomainError('NOT_FOUND', 'Réservation introuvable.');
    const club = await getClub(tx, rows[0].club_id);

    let targetId: string;
    if ('teeTimeId' in target) {
      targetId = target.teeTimeId;
    } else {
      const course = await getCourse(tx, target.courseId);
      if (course.clubId !== club.id) throw new DomainError('VALIDATION', 'Le départ cible doit être dans le même golf.');
      const { slot, localDate } = await resolveSlot(tx, club, course, target.startsAt, new Map());
      targetId = await upsertTeeTime(tx, club, course, slot, localDate);
    }

    const { booking, teeTimes } = await lockBookingWith(tx, bookingId, [targetId]);
    const targetTt = teeTimes.get(targetId);
    if (!targetTt) throw new DomainError('NOT_FOUND', 'Départ cible introuvable.');
    if (targetTt.clubId !== booking.clubId) throw new DomainError('VALIDATION', 'Le départ cible doit être dans le même golf.');
    if (booking.status !== 'confirmed') throw new DomainError('BOOKING_CANCELLED', 'Réservation annulée.');
    if (targetId === booking.teeTimeId) throw new DomainError('VALIDATION', 'La réservation est déjà sur ce départ.');
    if (targetTt.startsAt.getTime() <= deps.now().getTime()) {
      throw new DomainError('OUTSIDE_BOOKING_WINDOW', 'Ce départ est déjà passé.');
    }

    const course = await getCourse(tx, targetTt.courseId);
    if (!course.allowedHoles.includes(booking.holes)) {
      throw new DomainError('HOLES_NOT_ALLOWED', `Formule ${booking.holes} trous non proposée sur ce parcours.`);
    }
    assertNotBlocked(targetTt);
    const state = await occupancy(tx, targetTt);
    assertCanJoin(state, { players: booking.players, holes: booking.holes, isPrivate: booking.isPrivate });

    const resourceTypes = await listResourceTypes(tx, club.id, { activeOnly: false });
    const caddieRts = caddieTypes(resourceTypes.filter((r) => r.active));
    const options = await currentOptions(tx, booking.id, resourceTypes);
    await lockResourceTypes(tx, [...caddieRts.map((r) => r.id), ...options.map((o) => o.rt.id)]);

    await releaseBookingAllocations(tx, booking.id);
    await tx.query('UPDATE bookings SET tee_time_id = $2, updated_at = now() WHERE id = $1', [booking.id, targetId]);
    await ensureCaddie(tx, targetTt, course, booking.holes, caddieRts);
    await reserveOptions(tx, targetTt, course, booking.holes, booking.id, options);
    await syncTeeTime(tx, targetId);
    await syncTeeTime(tx, booking.teeTimeId);
    const priced = (await reprice(tx, targetId, club, course)).get(booking.id)!;
    // Les réservations restées sur l'ancien départ reprennent le caddie à leur compte.
    const sourceTt = teeTimes.get(booking.teeTimeId)!;
    await reprice(tx, sourceTt.id, club, await getCourse(tx, sourceTt.courseId));

    await audit(tx, {
      clubId: booking.clubId,
      actor: opts.actor,
      action: 'booking.moved',
      entityType: 'booking',
      entityId: booking.id,
      data: {
        reference: booking.reference,
        fromTeeTimeId: booking.teeTimeId,
        toTeeTimeId: targetId,
        joinedExistingTeeTime: state.bookedPlayers > 0,
        totalMinor: priced.totalMinor,
      },
    });
  });
  return getBooking(deps.db, bookingId);
}

export interface BookingPatch {
  players?: number;
  holes?: Holes;
  isPrivate?: boolean;
  options?: OptionRequest[]; // remplace l'ensemble des options
  playerNames?: Array<string | null>;
  notes?: string | null;
  customerCategory?: string;
  caddiePayment?: Payable;
}

export async function updateBooking(
  deps: BookingDeps,
  bookingId: string,
  patch: BookingPatch,
  opts: { actor: Actor },
): Promise<BookingDetail> {
  await runTx(deps.db, async (tx) => {
    const { booking, teeTimes } = await lockBookingWith(tx, bookingId);
    if (booking.status !== 'confirmed') throw new DomainError('BOOKING_CANCELLED', 'Réservation annulée.');
    const teeTime = teeTimes.get(booking.teeTimeId)!;
    const course = await getCourse(tx, teeTime.courseId);

    const next = {
      players: patch.players ?? booking.players,
      holes: patch.holes ?? booking.holes,
      isPrivate: patch.isPrivate ?? booking.isPrivate,
    };
    if (!course.allowedHoles.includes(next.holes)) {
      throw new DomainError('HOLES_NOT_ALLOWED', `Formule ${next.holes} trous non proposée sur ce parcours.`);
    }
    const others = await occupancy(tx, teeTime, booking.id);
    assertCanJoin(others, next);

    const holesChanged = next.holes !== booking.holes;
    const resourceTypes = await listResourceTypes(tx, booking.clubId, { activeOnly: false });
    const caddieRts = caddieTypes(resourceTypes.filter((r) => r.active));
    const oldOptions = await currentOptions(tx, booking.id, resourceTypes);
    const newOptions =
      patch.options !== undefined
        ? resolveOptions(patch.options, resourceTypes.filter((r) => r.active))
        : oldOptions;
    await lockResourceTypes(tx, [
      ...caddieRts.map((r) => r.id),
      ...oldOptions.map((o) => o.rt.id),
      ...newOptions.map((o) => o.rt.id),
    ]);

    if (patch.options !== undefined || holesChanged) {
      await releaseBookingAllocations(tx, booking.id);
      await reserveOptions(tx, teeTime, course, next.holes, booking.id, newOptions);
    }
    if (holesChanged) {
      // Seule réservation du départ (garanti par assertCanJoin) : la période du
      // caddie change avec la formule.
      await releaseTeeTimeAllocations(tx, teeTime.id);
      await ensureCaddie(tx, teeTime, course, next.holes, caddieRts);
      // La période change : l'attribution nominative est à refaire par le starter.
      await tx.query('UPDATE tee_times SET caddie_id = NULL WHERE id = $1', [teeTime.id]);
    }

    await tx.query(
      `UPDATE bookings SET players = $2, holes = $3, is_private = $4,
              notes = CASE WHEN $5 THEN $6 ELSE notes END,
              customer_category = coalesce($7, customer_category),
              caddie_payment = coalesce($8, caddie_payment), updated_at = now()
        WHERE id = $1`,
      [booking.id, next.players, next.holes, next.isPrivate, patch.notes !== undefined, patch.notes ?? null,
        patch.customerCategory ?? null, patch.caddiePayment ?? null],
    );
    if (next.players !== booking.players || patch.playerNames) {
      const existing = await tx.query('SELECT position, name FROM booking_players WHERE booking_id = $1', [booking.id]);
      const names = new Map<number, string | null>(existing.rows.map((r) => [r.position, r.name]));
      await tx.query('DELETE FROM booking_players WHERE booking_id = $1', [booking.id]);
      for (let p = 1; p <= next.players; p++) {
        const name = patch.playerNames ? (patch.playerNames[p - 1] ?? null) : (names.get(p) ?? null);
        await tx.query('INSERT INTO booking_players (booking_id, position, name) VALUES ($1, $2, $3)', [
          booking.id,
          p,
          name,
        ]);
      }
    }
    await syncTeeTime(tx, teeTime.id);
    const priced = (await reprice(tx, teeTime.id, await getClub(tx, booking.clubId), course)).get(booking.id)!;

    await audit(tx, {
      clubId: booking.clubId,
      actor: opts.actor,
      action: 'booking.updated',
      entityType: 'booking',
      entityId: booking.id,
      data: {
        reference: booking.reference,
        before: { players: booking.players, holes: booking.holes, isPrivate: booking.isPrivate,
          options: oldOptions.map((o) => ({ code: o.rt.code, quantity: o.quantity })) },
        after: { ...next, options: newOptions.map((o) => ({ code: o.rt.code, quantity: o.quantity })) },
        totalMinor: priced.totalMinor,
      },
    });
  });
  return getBooking(deps.db, bookingId);
}
