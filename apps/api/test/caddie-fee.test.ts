import { describe, expect, it } from 'vitest';
import { cancelBooking, createBooking, getBooking, moveBooking, updateBooking } from '../src/modules/booking/service.js';
import { at, createClub, deps, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const d = deps(db);
const book = (f: Fixture, time: string, players: number, holes: 9 | 18 = 18) =>
  createBooking(d, staff, { courseId: f.courseId, startsAt: at(time), players, holes });

async function caddieShares(...ids: string[]): Promise<number[]> {
  const out = [];
  for (const id of ids) {
    const b = await getBooking(db, id);
    out.push(b.pricing.lines.filter((l) => l.kind === 'caddie').reduce((n, l) => n + l.totalMinor, 0));
  }
  return out;
}

describe('un seul prix de caddie par départ, quel que soit le nombre de réservations', () => {
  it('deux réservations de 2 joueurs réunies paient 100 + 100 DH au lieu de 200 + 200', async () => {
    const f = await createClub(db);
    const a = await book(f, '08:00', 2);
    const b = await book(f, '08:30', 2);
    expect(await caddieShares(a.booking.id, b.booking.id)).toEqual([20000, 20000]); // deux départs, deux caddies
    await moveBooking(d, b.booking.id, { teeTimeId: a.booking.teeTime.id }, { actor: staff.actor });
    expect(await caddieShares(a.booking.id, b.booking.id)).toEqual([10000, 10000]);
  });

  it('3 + 1 joueurs : 150 + 50 DH ; en 9 trous : 100 DH au total', async () => {
    const f = await createClub(db);
    const a = await book(f, '08:00', 3);
    const b = await book(f, '08:00', 1);
    expect(await caddieShares(a.booking.id, b.booking.id)).toEqual([15000, 5000]);
    const c = await book(f, '09:00', 2, 9);
    const e = await book(f, '09:00', 2, 9);
    expect(await caddieShares(c.booking.id, e.booking.id)).toEqual([5000, 5000]);
  });

  it('se recalcule à la modification et à l’annulation', async () => {
    const f = await createClub(db);
    const a = await book(f, '08:00', 2);
    const b = await book(f, '08:00', 2);
    await updateBooking(d, b.booking.id, { players: 1 }, { actor: staff.actor });
    const [sa, sb] = await caddieShares(a.booking.id, b.booking.id);
    expect(sa! + sb!).toBe(20000);
    expect(sa).toBe(13300);
    await cancelBooking(d, b.booking.id, { actor: staff.actor });
    expect(await caddieShares(a.booking.id)).toEqual([20000]); // la réservation restante reprend le caddie entier
  });

  it('un départ déplacé libère sa part pour les réservations restées', async () => {
    const f = await createClub(db);
    const a = await book(f, '08:00', 2);
    const b = await book(f, '08:00', 2);
    await moveBooking(d, b.booking.id, { courseId: f.courseId, startsAt: at('10:00') }, { actor: staff.actor });
    expect(await caddieShares(a.booking.id, b.booking.id)).toEqual([20000, 20000]);
  });

  it('mode « première réservation » configurable par golf', async () => {
    const f = await createClub(db);
    await db.query(`UPDATE clubs SET caddie_fee_split = 'first_booking' WHERE id = $1`, [f.clubId]);
    const a = await book(f, '08:00', 1);
    const b = await book(f, '08:00', 3);
    expect(await caddieShares(a.booking.id, b.booking.id)).toEqual([20000, 0]);
  });
});
