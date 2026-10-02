// Feuille de départs : combine la grille calculée (règles) et l'état réel
// (départs créés, réservations, caddie, matériel).

import type { Queryable } from '../../db/pool.js';
import { selectTariff } from '../../domain/pricing.js';
import { generateDaySlots } from '../../domain/schedule.js';
import { available, usagePeriod } from '../../domain/resource-usage.js';
import { remainingSeats, type Holes, type TeeTimeState } from '../../domain/tee-time-rules.js';
import { DomainError } from '../../shared/errors.js';
import { paymentStatusOf, type PaymentStatus } from '../orders/service.js';
import { instantToLocal, isoWeekday, isValidIsoDate, localToInstant } from '../../shared/time.js';
import {
  getClub,
  getCourse,
  listResourceTypes,
  listScheduleRules,
  listTariffs,
  type Club,
  type Course,
  type ResourceType,
} from '../catalog/repository.js';
import { activeUsages, availableQuantity, capacityOn } from '../resources/service.js';

export interface GridSlot {
  startsAt: Date;
  localTime: string;
  maxPlayers: number;
  allowedHoles: number[];
  intervalMinutes: number;
}

export async function computeGrid(q: Queryable, club: Club, course: Course, date: string): Promise<GridSlot[]> {
  if (!isValidIsoDate(date)) throw new DomainError('VALIDATION', `Date invalide : ${date}`);
  const rules = await listScheduleRules(q, club.id);
  const slots = generateDaySlots(date, isoWeekday(date), rules, {
    courseId: course.id,
    intervalMinutes: course.defaultIntervalMinutes,
    maxPlayers: course.defaultMaxPlayers,
    allowedHoles: course.allowedHoles,
  });
  const grid: GridSlot[] = [];
  for (const s of slots) {
    const startsAt = localToInstant(date, s.minuteOfDay, club.timezone);
    if (!startsAt) continue;
    grid.push({
      startsAt,
      localTime: s.localTime,
      maxPlayers: s.maxPlayers,
      allowedHoles: s.allowedHoles,
      intervalMinutes: s.intervalMinutes,
    });
  }
  return grid;
}

export function caddieTypes(resourceTypes: ResourceType[]): ResourceType[] {
  return resourceTypes.filter((rt) => rt.scope === 'tee_time' && rt.requiredPerTeeTime);
}

/** Fenêtre large couvrant tous les départs du jour et leur durée de jeu. */
function dayWindow(starts: number[], course: Course, extraMinutes: number): { start: Date; end: Date } | null {
  if (starts.length === 0) return null;
  const first = Math.min(...starts);
  const last = Math.max(...starts);
  const tail = (Math.max(course.playMinutes9, course.playMinutes18) + extraMinutes) * 60_000;
  return { start: new Date(first), end: new Date(last + tail) };
}

interface TeeTimeRow {
  id: string;
  startsAt: Date;
  maxPlayers: number;
  holes: Holes | null;
  isPrivate: boolean;
  caddieId: string | null;
  caddieName: string | null;
  notes: string | null;
  blockedReason: string | null;
  startedAt: Date | null;
  heldPartnerId: string | null;
  heldPartnerName: string | null;
  heldUntil: Date | null;
}

interface BookingRow {
  id: string;
  reference: string;
  teeTimeId: string;
  players: number;
  holes: Holes;
  isPrivate: boolean;
  channel: string;
  groupId: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  partnerName: string | null;
  partnerReference: string | null;
  isOpen: boolean;
  customerHandicap: number | null;
  notes: string | null;
  checkinStatus: 'expected' | 'arrived' | 'no_show';
  customerNoShows: number;
  orderTotalMinor: number | null;
  paidMinor: number | null;
  paymentStatus?: PaymentStatus;
  balanceMinor?: number;
}

async function loadDay(q: Queryable, courseId: string, date: string) {
  const teeTimes = (
    await q.query<TeeTimeRow>(
      `SELECT t.id, t.starts_at AS "startsAt", t.max_players AS "maxPlayers", t.holes,
              t.is_private AS "isPrivate", t.caddie_id AS "caddieId", c.display_name AS "caddieName", t.notes,
              t.blocked_reason AS "blockedReason", t.started_at AS "startedAt",
              al.partner_id AS "heldPartnerId", hp.name AS "heldPartnerName", t.held_until AS "heldUntil"
         FROM tee_times t LEFT JOIN caddies c ON c.id = t.caddie_id
         LEFT JOIN allotments al ON al.id = t.held_allotment_id LEFT JOIN partners hp ON hp.id = al.partner_id
        WHERE t.course_id = $1 AND t.local_date = $2`,
      [courseId, date],
    )
  ).rows;
  const ids = teeTimes.map((t) => t.id);
  const bookings = ids.length
    ? (
        await q.query<BookingRow>(
          `SELECT b.id, b.reference, b.tee_time_id AS "teeTimeId", b.players, b.holes,
                  b.is_private AS "isPrivate", b.channel, b.group_id AS "groupId",
                  b.customer_id AS "customerId",
                  NULLIF(concat_ws(' ', cu.first_name, cu.last_name), '') AS "customerName",
                  cu.phone AS "customerPhone", cu.email AS "customerEmail", b.notes,
                  pa.name AS "partnerName", b.partner_reference AS "partnerReference",
                  b.is_open AS "isOpen", cu.handicap_index::float AS "customerHandicap",
                  b.checkin_status AS "checkinStatus",
                  (SELECT count(*)::int FROM bookings nb WHERE nb.customer_id = b.customer_id AND nb.checkin_status = 'no_show' AND nb.id <> b.id) AS "customerNoShows",
                  (SELECT o.total_minor FROM orders o WHERE o.booking_id = b.id) AS "orderTotalMinor",
                  (SELECT coalesce((SELECT sum(amount_minor) FROM payments WHERE order_id = o.id AND status = 'confirmed'), 0)
                        - coalesce((SELECT sum(amount_minor) FROM refunds WHERE order_id = o.id AND status = 'confirmed'), 0)
                     FROM orders o WHERE o.booking_id = b.id)::int AS "paidMinor"
             FROM bookings b LEFT JOIN customers cu ON cu.id = b.customer_id LEFT JOIN partners pa ON pa.id = b.partner_id
            WHERE b.tee_time_id = ANY($1) AND b.status = 'confirmed'
            ORDER BY b.created_at`,
          [ids],
        )
      ).rows
    : [];
  const allocations = ids.length
    ? (
        await q.query(
          `SELECT a.id, a.tee_time_id AS "teeTimeId", a.booking_id AS "bookingId", a.quantity,
                  rt.id AS "resourceTypeId", rt.code, rt.kind, rt.name
             FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id
            WHERE a.status = 'active'
              AND (a.tee_time_id = ANY($1)
                   OR a.booking_id IN (SELECT id FROM bookings WHERE tee_time_id = ANY($1) AND status = 'confirmed'))`,
          [ids],
        )
      ).rows
    : [];
  return { teeTimes, bookings, allocations };
}

export interface TeeSheetRow {
  teeTimeId: string | null;
  startsAt: string;
  localTime: string;
  inGrid: boolean;
  maxPlayers: number;
  bookedPlayers: number;
  remaining: number;
  holes: Holes | null;
  allowedHoles: number[];
  isPrivate: boolean;
  blockedReason: string | null;
  /** Départ tenu pour l'allotement d'un partenaire (places restantes pour lui). */
  held: { partnerId: string; partnerName: string; until: string | null; remaining: number } | null;
  startedAt: string | null;
  caddie: { reserved: boolean; caddieId: string | null; name: string | null };
  bookings: Array<
    BookingRow & { resources: Array<{ resourceTypeId: string; code: string; name: string; quantity: number }> }
  >;
}

/** Vue interne : tous les créneaux du jour, occupés ou non. */
export async function getTeeSheet(q: Queryable, courseId: string, date: string): Promise<{
  club: Club;
  course: Course;
  date: string;
  rows: TeeSheetRow[];
}> {
  const course = await getCourse(q, courseId);
  const club = await getClub(q, course.clubId);
  const grid = await computeGrid(q, club, course, date);
  const { teeTimes, bookings, allocations } = await loadDay(q, courseId, date);

  const byStart = new Map<number, TeeSheetRow>();
  for (const slot of grid) {
    byStart.set(slot.startsAt.getTime(), {
      teeTimeId: null,
      startsAt: slot.startsAt.toISOString(),
      localTime: slot.localTime,
      inGrid: true,
      maxPlayers: slot.maxPlayers,
      bookedPlayers: 0,
      remaining: slot.maxPlayers,
      holes: null,
      allowedHoles: slot.allowedHoles,
      isPrivate: false,
      blockedReason: null,
      held: null,
      startedAt: null,
      caddie: { reserved: false, caddieId: null, name: null },
      bookings: [],
    });
  }

  for (const tt of teeTimes) {
    const key = tt.startsAt.getTime();
    const ttBookings = bookings
      .filter((b) => b.teeTimeId === tt.id)
      .map((b) => ({
        ...b,
        paymentStatus: paymentStatusOf(b.orderTotalMinor ?? 0, b.paidMinor ?? 0),
        balanceMinor: (b.orderTotalMinor ?? 0) - (b.paidMinor ?? 0),
        resources: allocations
          .filter((a) => a.bookingId === b.id)
          .map((a) => ({ resourceTypeId: a.resourceTypeId, code: a.code, name: a.name, quantity: a.quantity })),
      }));
    const booked = ttBookings.reduce((n, b) => n + b.players, 0);
    const state: TeeTimeState = {
      maxPlayers: tt.maxPlayers,
      holes: booked > 0 ? tt.holes : null,
      isPrivate: tt.isPrivate,
      bookedPlayers: booked,
    };
    const existing = byStart.get(key);
    byStart.set(key, {
      teeTimeId: tt.id,
      startsAt: tt.startsAt.toISOString(),
      localTime: instantToLocal(tt.startsAt, club.timezone).time,
      inGrid: existing !== undefined,
      maxPlayers: tt.maxPlayers,
      bookedPlayers: booked,
      remaining: tt.blockedReason ? 0 : remainingSeats(state),
      holes: state.holes,
      allowedHoles: existing?.allowedHoles ?? course.allowedHoles,
      isPrivate: booked > 0 && tt.isPrivate,
      blockedReason: tt.blockedReason,
      held: tt.heldPartnerId && tt.blockedReason
        ? { partnerId: tt.heldPartnerId, partnerName: tt.heldPartnerName!, until: tt.heldUntil?.toISOString() ?? null, remaining: remainingSeats(state) }
        : null,
      startedAt: tt.startedAt ? tt.startedAt.toISOString() : null,
      caddie: {
        reserved: allocations.some((a) => a.teeTimeId === tt.id && a.kind === 'caddie'),
        caddieId: tt.caddieId,
        name: tt.caddieName,
      },
      bookings: ttBookings,
    });
  }

  const rows = [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  return { club, course, date, rows };
}

export interface AvailableSlot {
  startsAt: string;
  localTime: string;
  remaining: number;
  canBePrivate: boolean;
  /** Places de l'allotement du partenaire qui cherche. */
  heldForPartner?: boolean;
  /** État d'affichage (toujours 'available' sauf avec includeUnavailable). */
  state: 'available' | 'full' | 'blocked';
  /** Motif d'un départ bloqué (tournoi, entretien…) ; « Réservé » pour un allotement. */
  reason?: string | null;
  /** Ouvert uniquement grâce à l'abonnement (au-delà de l'horizon public). */
  membersOnly?: boolean;
  /** Green fee inférieur au plus cher du jour (heures creuses), en %. */
  discountPercent?: number | null;
}

/**
 * Créneaux proposables à un client : places suffisantes, non privés, même
 * formule de trous, dans la fenêtre de réservation, avec caddie disponible.
 * Indicatif : la vérification qui fait foi a lieu sous verrou à la réservation.
 */
export async function getAvailability(
  q: Queryable,
  params: { courseId: string; date: string; players: number; holes: Holes; now: Date; enforceBookingWindow: boolean; partnerId?: string | null;
    /** Horizon de réservation propre (ex. membre) ; par défaut celui du golf. */
    horizonDays?: number;
    /** Inclure les créneaux complets et bloqués (affichage de la grille complète). */
    includeUnavailable?: boolean;
    /** Catégorie tarifaire pour le calcul des remises (défaut : standard). */
    customerCategory?: string },
): Promise<{ club: Club; course: Course; slots: AvailableSlot[] }> {
  const sheet = await getTeeSheet(q, params.courseId, params.date);
  const { club, course } = sheet;
  const resourceTypes = await listResourceTypes(q, club.id);
  const caddies = caddieTypes(resourceTypes);

  const grid = sheet.rows.filter((r) => r.inGrid);
  const window = dayWindow(
    grid.map((r) => Date.parse(r.startsAt)),
    course,
    Math.max(0, ...caddies.map((c) => c.bufferMinutes)),
  );
  const caddieData = window
    ? await Promise.all(
        caddies.map(async (rt) => ({
          rt,
          capacity: await capacityOn(q, rt, params.date),
          usages: await activeUsages(q, rt.id, window.start, window.end),
        })),
      )
    : [];

  const earliest = params.now.getTime() + (params.enforceBookingWindow ? club.minLeadMinutes * 60_000 : 0);
  const publicLatest = params.now.getTime() + club.bookingHorizonDays * 86_400_000;
  const latest = params.now.getTime() + Math.max(club.bookingHorizonDays, params.horizonDays ?? 0) * 86_400_000;

  // Green fee par créneau (catégorie du demandeur) : repère « heures creuses ».
  const tariffs = await listTariffs(q, club.id);
  const weekday = isoWeekday(params.date);
  const feeAt = (localTime: string) => {
    const [h, m] = localTime.split(':').map(Number);
    const ctx = { product: 'green_fee' as const, courseId: course.id, holes: params.holes, customerCategory: params.customerCategory ?? 'standard',
      date: params.date, isoWeekday: weekday, minuteOfDay: h! * 60 + m! };
    return selectTariff(tariffs, ctx)?.amountMinor ?? null;
  };
  const fees = new Map(grid.map((r) => [r.startsAt, feeAt(r.localTime)]));
  const reference = Math.max(0, ...[...fees.values()].filter((f): f is number => f !== null));
  const discountOf = (startsAt: string) => {
    const f = fees.get(startsAt);
    if (f === null || f === undefined || reference <= 0) return null;
    const pct = Math.round((1 - f / reference) * 100);
    return pct >= 5 ? pct : null;
  };

  const slots: AvailableSlot[] = [];
  for (const row of grid) {
    const start = new Date(row.startsAt);
    if (start.getTime() < earliest) continue;
    if (params.enforceBookingWindow && start.getTime() > latest) continue;
    if (!row.allowedHoles.includes(params.holes)) continue;
    const mine = !!params.partnerId && row.held?.partnerId === params.partnerId;
    const remaining = mine ? row.held!.remaining : row.remaining;
    const extra = {
      discountPercent: discountOf(row.startsAt),
      ...(params.enforceBookingWindow && start.getTime() > publicLatest ? { membersOnly: true } : {}),
    };
    const unavailable = (state: 'full' | 'blocked', reason: string | null = null) => {
      if (params.includeUnavailable) {
        slots.push({ startsAt: row.startsAt, localTime: row.localTime, remaining: Math.max(0, remaining), canBePrivate: false, state, reason, ...extra });
      }
    };
    if (row.blockedReason && !mine) { unavailable('blocked', row.held ? 'Réservé' : row.blockedReason); continue; }
    if (row.bookedPlayers > 0 && (row.isPrivate || row.holes !== params.holes)) { unavailable('full'); continue; }
    if (remaining < params.players) { unavailable('full'); continue; }
    if (!row.caddie.reserved) {
      const ok = caddieData.every(({ rt, capacity, usages }) => {
        const p = usagePeriod(start, params.holes, course, rt.bufferMinutes);
        return available(capacity, usages, p.start.getTime(), p.end.getTime()) >= 1;
      });
      if (!ok) { unavailable('full'); continue; }
    }
    slots.push({
      startsAt: row.startsAt,
      localTime: row.localTime,
      remaining,
      canBePrivate: row.bookedPlayers === 0,
      state: 'available',
      ...extra,
      ...(mine ? { heldForPartner: true } : {}),
    });
  }
  return { club, course, slots };
}

/** Résumé par jour pour le calendrier : créneaux réservables et présence de tarifs réduits. */
export async function getCalendar(
  q: Queryable,
  params: { courseId: string; from: string; days: number; players: number; holes: Holes; now: Date; horizonDays?: number; customerCategory?: string },
) {
  const days: Array<{ date: string; available: number; deal: boolean }> = [];
  const start = new Date(`${params.from}T12:00:00Z`);
  for (let i = 0; i < Math.min(params.days, 62); i++) {
    const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const { slots } = await getAvailability(q, { ...params, date, enforceBookingWindow: true });
    days.push({ date, available: slots.length, deal: slots.some((s) => (s.discountPercent ?? 0) > 0) });
  }
  return days;
}

/** Options (matériel) disponibles pour un créneau et une formule donnés. */
export async function getOptionsAvailability(
  q: Queryable,
  params: { courseId: string; startsAt: Date; holes: Holes; excludeBookingId?: string | null },
) {
  const course = await getCourse(q, params.courseId);
  const club = await getClub(q, course.clubId);
  const date = instantToLocal(params.startsAt, club.timezone).date;
  const types = (await listResourceTypes(q, club.id)).filter((rt) => rt.scope === 'booking');
  return Promise.all(
    types.map(async (rt) => {
      const p = usagePeriod(params.startsAt, params.holes, course, rt.bufferMinutes);
      let free = await availableQuantity(q, rt, date, p.start, p.end);
      let current = 0;
      if (params.excludeBookingId) {
        // Modification : la quantité déjà tenue par cette réservation reste disponible pour elle.
        const { rows } = await q.query(
          `SELECT coalesce(sum(quantity), 0)::int AS n FROM resource_allocations WHERE booking_id = $1 AND resource_type_id = $2 AND status = 'active'`,
          [params.excludeBookingId, rt.id]);
        current = rows[0].n;
        free += current;
      }
      return {
        current,
        start: p.start.toISOString(),
        end: p.end.toISOString(),
        resourceTypeId: rt.id,
        code: rt.code,
        kind: rt.kind,
        name: rt.name,
        variant: rt.variant,
        unitPriceMinor: params.holes === 9 ? rt.price9Minor : rt.price18Minor,
        currency: club.currency,
        available: rt.maxPerBooking ? Math.min(free, rt.maxPerBooking) : free,
        /** Stock réellement libre sur toute la période (sans plafond par réservation). */
        free,
        maxPerBooking: rt.maxPerBooking,
      };
    }),
  );
}
