import { describe, expect, it } from 'vitest';
import { createBooking } from '../src/modules/booking/service.js';
import { blockRange } from '../src/modules/operations/service.js';
import { getAvailability, getCalendar } from '../src/modules/teesheet/service.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb } from './helpers.js';

const db = useTestDb();
const d = deps(db);

describe('états des créneaux (grille client)', () => {
  it('disponible, complet, bloqué avec motif, heures creuses, membres', async () => {
    const f = await createClub(db);
    await db.query(`UPDATE clubs SET booking_horizon_days = 7 WHERE id = $1`, [f.clubId]);
    // Twilight après 15 h : 1 040 au lieu de 1 300 (−20 %).
    await db.query(`INSERT INTO tariffs (club_id, product, name, holes, start_time, end_time, amount_minor, basis, priority)
                    VALUES ($1, 'green_fee', 'Twilight', 18, '15:00', '23:59', 104000, 'per_player', 1)`, [f.clubId]);
    await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:00'), players: 4, holes: 18 });
    await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:06'), players: 3, holes: 18 });
    await blockRange(db, { courseId: f.courseId, date: DAY, from: '09:00', to: '09:00', reason: 'Compétition' }, { type: 'system' });

    const grid = async (horizonDays?: number, includeUnavailable = true) => (await getAvailability(db, {
      courseId: f.courseId, date: DAY, players: 2, holes: 18, now: NOW, enforceBookingWindow: true, includeUnavailable, horizonDays })).slots;
    // J+9 hors horizon public (7 j) : rien pour le public ; tout « membres » avec un horizon de 30 j.
    expect(await grid()).toHaveLength(0);
    const slots = await grid(30);
    const at_ = (t: string) => slots.find((s) => s.localTime === t)!;
    expect(at_('08:00')).toMatchObject({ state: 'full', remaining: 0 });
    expect(at_('08:06')).toMatchObject({ state: 'full', remaining: 1 }); // 1 place pour 2 joueurs
    expect(at_('09:00')).toMatchObject({ state: 'blocked', reason: 'Compétition' });
    expect(at_('10:00')).toMatchObject({ state: 'available', remaining: 4, membersOnly: true, discountPercent: null });
    expect(at_('15:00')).toMatchObject({ state: 'available', discountPercent: 20 });
    // Sans includeUnavailable : uniquement les créneaux réservables.
    expect((await grid(30, false)).every((s) => s.state === 'available')).toBe(true);

    const cal = await getCalendar(db, { courseId: f.courseId, from: DAY, days: 2, players: 2, holes: 18, now: NOW, horizonDays: 30 });
    expect(cal[0]).toMatchObject({ date: DAY, deal: true });
    expect(cal[0]!.available).toBeGreaterThan(50);
  });
});
