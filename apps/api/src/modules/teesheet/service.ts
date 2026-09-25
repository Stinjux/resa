// Feuille de départs : combine la grille calculée (règles) et l'état réel
// (départs créés, réservations, caddie, matériel).

import type { Queryable } from '../../db/pool.js';
import { generateDaySlots } from '../../domain/schedule.js';
import { available, usagePeriod } from '../../domain/resource-usage.js';
import { remainingSeats, type Holes, type TeeTimeState } from '../../domain/tee-time-rules.js';
import { DomainError } from '../../shared/errors.js';
import { instantToLocal, isoWeekday, isValidIsoDate, localToInstant } from '../../shared/time.js';
import {
  getClub,
  getCourse,
  listResourceTypes,
  listScheduleRules,
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
  notes: string | null;
}

async function loadDay(q: Queryable, courseId: string, date: string) {
  const teeTimes = (
    await q.query<TeeTimeRow>(
      `SELECT t.id, t.starts_at AS "startsAt", t.max_players AS "maxPlayers", t.holes,
              t.is_private AS "isPrivate", t.caddie_id AS "caddieId", c.display_name AS "caddieName", t.notes
         FROM tee_times t LEFT JOIN caddies c ON c.id = t.caddie_id
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
                  NULLIF(concat_ws(' ', cu.first_name, cu.last_name), '') AS "customerName", b.notes
             FROM bookings b LEFT JOIN customers cu ON cu.id = b.customer_id
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
      remaining: remainingSeats(state),
      holes: state.holes,
      allowedHoles: existing?.allowedHoles ?? course.allowedHoles,
      isPrivate: booked > 0 && tt.isPrivate,
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
}

/**
 * Créneaux proposables à un client : places suffisantes, non privés, même
 * formule de trous, dans la fenêtre de réservation, avec caddie disponible.
 * Indicatif : la vérification qui fait foi a lieu sous verrou à la réservation.
 */
export async function getAvailability(
  q: Queryable,
  params: { courseId: string; date: string; players: number; holes: Holes; now: Date; enforceBookingWindow: boolean },
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
  const latest = params.now.getTime() + club.bookingHorizonDays * 86_400_000;

  const slots: AvailableSlot[] = [];
  for (const row of grid) {
    const start = new Date(row.startsAt);
    if (start.getTime() < earliest) continue;
    if (params.enforceBookingWindow && start.getTime() > latest) continue;
    if (!row.allowedHoles.includes(params.holes)) continue;
    if (row.bookedPlayers > 0 && (row.isPrivate || row.holes !== params.holes)) continue;
    if (row.remaining < params.players) continue;
    if (!row.caddie.reserved) {
      const ok = caddieData.every(({ rt, capacity, usages }) => {
        const p = usagePeriod(start, params.holes, course, rt.bufferMinutes);
        return available(capacity, usages, p.start.getTime(), p.end.getTime()) >= 1;
      });
      if (!ok) continue;
    }
    slots.push({
      startsAt: row.startsAt,
      localTime: row.localTime,
      remaining: row.remaining,
      canBePrivate: row.bookedPlayers === 0,
    });
  }
  return { club, course, slots };
}

/** Options (matériel) disponibles pour un créneau et une formule donnés. */
export async function getOptionsAvailability(
  q: Queryable,
  params: { courseId: string; startsAt: Date; holes: Holes },
) {
  const course = await getCourse(q, params.courseId);
  const club = await getClub(q, course.clubId);
  const date = instantToLocal(params.startsAt, club.timezone).date;
  const types = (await listResourceTypes(q, club.id)).filter((rt) => rt.scope === 'booking');
  return Promise.all(
    types.map(async (rt) => {
      const p = usagePeriod(params.startsAt, params.holes, course, rt.bufferMinutes);
      const free = await availableQuantity(q, rt, date, p.start, p.end);
      return {
        resourceTypeId: rt.id,
        code: rt.code,
        kind: rt.kind,
        name: rt.name,
        variant: rt.variant,
        unitPriceMinor: params.holes === 9 ? rt.price9Minor : rt.price18Minor,
        currency: club.currency,
        available: rt.maxPerBooking ? Math.min(free, rt.maxPerBooking) : free,
      };
    }),
  );
}
