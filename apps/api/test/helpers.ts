import { afterAll } from 'vitest';
import { createPool, type Db } from '../src/db/pool.js';
import type { BookingDeps } from '../src/modules/booking/service.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://resa:resa@localhost:5432/resa_test';

/** Pool partagé par un fichier de test, fermé à la fin. */
export function useTestDb(): Db {
  const db = createPool(TEST_DATABASE_URL);
  afterAll(() => db.end());
  return db;
}

// « Maintenant » fixe pour des tests reproductibles : 1er juin 2030, 06:00 UTC.
export const NOW = new Date('2030-06-01T06:00:00Z');
export const DAY = '2030-06-10'; // lundi
export function deps(db: Db, now: Date = NOW): BookingDeps {
  return { db, now: () => now };
}

/** Heure locale Casablanca (UTC+1 hors ramadan) → instant. Le 10/06/2030 est UTC+1. */
export function at(time: string, date = DAY): Date {
  return new Date(`${date}T${time}:00+01:00`);
}

let counter = 0;

export interface FixtureOptions {
  caddies?: number;
  carts?: number;
  bagsMenRight?: number;
  interval?: number;
  open?: string;
  close?: string;
}

export interface Fixture {
  clubId: string;
  courseId: string;
  rt: Record<'CADDIE' | 'CART' | 'TROLLEY' | 'BAG_MEN_RH', string>;
}

/** Crée un golf isolé (codes uniques) pour chaque test. */
export async function createClub(db: Db, o: FixtureOptions = {}): Promise<Fixture> {
  counter += 1;
  const code = `T${process.pid}_${counter}_${Math.random().toString(36).slice(2, 6)}`;
  const org = await db.query(`INSERT INTO organizations (code, name) VALUES ($1, 'Test') RETURNING id`, [code]);
  const club = await db.query(
    `INSERT INTO clubs (organization_id, code, name, timezone, currency)
     VALUES ($1, $2, 'Golf test', 'Africa/Casablanca', 'MAD') RETURNING id`,
    [org.rows[0].id, code],
  );
  const clubId = club.rows[0].id;
  const course = await db.query(
    `INSERT INTO courses (club_id, code, name, default_interval_minutes) VALUES ($1, 'MAIN', 'Parcours', $2) RETURNING id`,
    [clubId, o.interval ?? 6],
  );
  await db.query(
    `INSERT INTO schedule_rules (club_id, name, kind, start_time, end_time) VALUES ($1, 'Ouverture', 'open', $2, $3)`,
    [clubId, o.open ?? '07:00', o.close ?? '17:00'],
  );
  const rts = await db.query(
    `INSERT INTO resource_types (club_id, code, kind, name, variant, scope, required_per_tee_time, total_quantity,
                                 price_9_minor, price_18_minor, buffer_minutes, max_per_booking)
     VALUES ($1, 'CADDIE', 'caddie', 'Caddie', NULL, 'tee_time', true, $2, 10000, 20000, 0, NULL),
            ($1, 'CART', 'cart', 'Voiturette', NULL, 'booking', false, $3, 0, 0, 0, NULL),
            ($1, 'TROLLEY', 'trolley', 'Chariot', NULL, 'booking', false, 10, 0, 0, 0, 4),
            ($1, 'BAG_MEN_RH', 'rental_bag', 'Sac homme droitier', 'men_right', 'booking', false, $4, 0, 0, 0, 4)
     RETURNING id, code`,
    [clubId, o.caddies ?? 10, o.carts ?? 5, o.bagsMenRight ?? 2],
  );
  const rt = Object.fromEntries(rts.rows.map((r) => [r.code, r.id])) as Fixture['rt'];
  return { clubId, courseId: course.rows[0].id, rt };
}

export const staff = { channel: 'phone' as const, actor: { type: 'system' as const } };
export const web = { channel: 'web' as const, actor: { type: 'system' as const } };
