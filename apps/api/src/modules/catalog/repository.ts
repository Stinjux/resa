// Lecture de la configuration d'un golf : golf, parcours, règles de grille,
// types de ressources. Aucune valeur métier n'est codée en dur ici.

import type { Queryable } from '../../db/pool.js';
import type { Tariff } from '../../domain/pricing.js';
import type { ScheduleRule } from '../../domain/schedule.js';
import { DomainError } from '../../shared/errors.js';

export interface Club {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  timezone: string;
  currency: string;
  defaultLocale: string;
  pricesIncludeTax: boolean;
  bookingHorizonDays: number;
  minLeadMinutes: number;
  taxRateBp: number;
  defaultCaddiePayment: 'on_site' | 'with_booking';
}

export interface Course {
  id: string;
  clubId: string;
  code: string;
  name: string;
  allowedHoles: number[];
  defaultIntervalMinutes: number;
  defaultMaxPlayers: number;
  playMinutes9: number;
  playMinutes18: number;
}

export interface ResourceType {
  id: string;
  clubId: string;
  code: string;
  kind: 'caddie' | 'cart' | 'trolley' | 'rental_bag' | 'other';
  name: string;
  variant: string | null;
  scope: 'tee_time' | 'booking';
  requiredPerTeeTime: boolean;
  totalQuantity: number;
  price9Minor: number;
  price18Minor: number;
  bufferMinutes: number;
  maxPerBooking: number | null;
  active: boolean;
  sortOrder: number;
}

const CLUB_COLUMNS = `id, organization_id AS "organizationId", code, name, timezone, currency,
  default_locale AS "defaultLocale", prices_include_tax AS "pricesIncludeTax",
  booking_horizon_days AS "bookingHorizonDays", min_lead_minutes AS "minLeadMinutes",
  tax_rate_bp AS "taxRateBp", default_caddie_payment AS "defaultCaddiePayment"`;

const COURSE_COLUMNS = `id, club_id AS "clubId", code, name, allowed_holes AS "allowedHoles",
  default_interval_minutes AS "defaultIntervalMinutes", default_max_players AS "defaultMaxPlayers",
  play_minutes_9 AS "playMinutes9", play_minutes_18 AS "playMinutes18"`;

const RESOURCE_TYPE_COLUMNS = `id, club_id AS "clubId", code, kind, name, variant, scope,
  required_per_tee_time AS "requiredPerTeeTime", total_quantity AS "totalQuantity",
  price_9_minor AS "price9Minor", price_18_minor AS "price18Minor", buffer_minutes AS "bufferMinutes",
  max_per_booking AS "maxPerBooking", active, sort_order AS "sortOrder"`;

export async function listClubs(q: Queryable): Promise<Club[]> {
  const { rows } = await q.query(`SELECT ${CLUB_COLUMNS} FROM clubs WHERE active ORDER BY name`);
  return rows;
}

export async function getClub(q: Queryable, clubId: string): Promise<Club> {
  const { rows } = await q.query(`SELECT ${CLUB_COLUMNS} FROM clubs WHERE id = $1`, [clubId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Golf introuvable.');
  return rows[0];
}

export async function listCourses(q: Queryable, clubId: string): Promise<Course[]> {
  const { rows } = await q.query(`SELECT ${COURSE_COLUMNS} FROM courses WHERE club_id = $1 AND active ORDER BY name`, [
    clubId,
  ]);
  return rows;
}

export async function getCourse(q: Queryable, courseId: string): Promise<Course> {
  const { rows } = await q.query(`SELECT ${COURSE_COLUMNS} FROM courses WHERE id = $1 AND active`, [courseId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Parcours introuvable.');
  return rows[0];
}

export async function listScheduleRules(q: Queryable, clubId: string): Promise<ScheduleRule[]> {
  const { rows } = await q.query(
    `SELECT id, course_id AS "courseId", kind, valid_from AS "validFrom", valid_to AS "validTo",
            weekdays, start_time::text AS "startTime", end_time::text AS "endTime",
            interval_minutes AS "intervalMinutes", max_players AS "maxPlayers",
            allowed_holes AS "allowedHoles", priority
       FROM schedule_rules WHERE club_id = $1 AND active`,
    [clubId],
  );
  return rows;
}

export async function listResourceTypes(q: Queryable, clubId: string, opts: { activeOnly?: boolean } = {}): Promise<ResourceType[]> {
  const { rows } = await q.query(
    `SELECT ${RESOURCE_TYPE_COLUMNS} FROM resource_types
      WHERE club_id = $1 ${opts.activeOnly === false ? '' : 'AND active'}
      ORDER BY sort_order, name`,
    [clubId],
  );
  return rows;
}

export async function listTariffs(q: Queryable, clubId: string): Promise<Tariff[]> {
  const { rows } = await q.query(
    `SELECT id, course_id AS "courseId", product, name, holes, customer_category AS "customerCategory",
            valid_from AS "validFrom", valid_to AS "validTo", weekdays,
            start_time::text AS "startTime", end_time::text AS "endTime",
            amount_minor AS "amountMinor", basis, priority
       FROM tariffs WHERE club_id = $1 AND active`,
    [clubId],
  );
  return rows;
}
