import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { createStaffUser } from '../src/modules/auth/service.js';
import type { Role } from '../src/modules/auth/permissions.js';
import { createBooking } from '../src/modules/booking/service.js';
import { blockRange, setCheckin, teeSheetCsv, unblockRange } from '../src/modules/operations/service.js';
import { getBookingOrder } from '../src/modules/orders/service.js';
import { getAvailability, getTeeSheet } from '../src/modules/teesheet/service.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const d = deps(db);
const actor = { type: 'system' as const };

describe('départs bloqués', () => {
  it('un départ bloqué n’est plus proposé ni réservable ; le déblocage le rend disponible', async () => {
    const f = await createClub(db);
    const r = await blockRange(db, { courseId: f.courseId, date: DAY, from: '08:00', to: '08:30', reason: 'Tournoi' }, actor);
    expect(r.blocked).toBe(6);
    const avail = async () => (await getAvailability(db, { courseId: f.courseId, date: DAY, players: 2, holes: 18, now: NOW, enforceBookingWindow: true }))
      .slots.map((s) => s.localTime);
    expect(await avail()).not.toContain('08:12');
    expect(await avail()).toContain('08:36');
    await expect(createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:12'), players: 2, holes: 18 }))
      .rejects.toMatchObject({ code: 'TEE_TIME_BLOCKED' });
    const row = (await getTeeSheet(db, f.courseId, DAY)).rows.find((x) => x.localTime === '08:12')!;
    expect(row).toMatchObject({ blockedReason: 'Tournoi', remaining: 0 });
    await unblockRange(db, { courseId: f.courseId, date: DAY, from: '08:12', to: '08:12' }, actor);
    await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:12'), players: 2, holes: 18 });
    expect(await avail()).not.toContain('08:06');
  });

  it('bloquer un départ déjà réservé conserve la réservation et le signale', async () => {
    const f = await createClub(db);
    await createBooking(d, staff, { courseId: f.courseId, startsAt: at('09:00'), players: 2, holes: 18 });
    const r = await blockRange(db, { courseId: f.courseId, date: DAY, from: '09:00', to: '09:00', reason: 'VIP' }, actor);
    expect(r).toEqual({ blocked: 1, withBookings: 1 });
    await expect(createBooking(d, staff, { courseId: f.courseId, startsAt: at('09:00'), players: 1, holes: 18 }))
      .rejects.toMatchObject({ code: 'TEE_TIME_BLOCKED' });
  });
});

describe('arrivées et absences', () => {
  it('absence : 100 % dû par défaut ; frais réduits selon la politique du golf ; annulable', async () => {
    const f = await createClub(db);
    const b = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18 });
    const total = (await getBookingOrder(db, b.booking.id)).totalMinor;
    await setCheckin(db, b.booking.id, 'no_show', actor);
    expect((await getBookingOrder(db, b.booking.id)).totalMinor).toBe(total);

    await db.query('UPDATE clubs SET no_show_fee_percent = 50 WHERE id = $1', [f.clubId]);
    const b2 = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('09:00'), players: 2, holes: 18 });
    await setCheckin(db, b2.booking.id, 'no_show', actor);
    const o = await getBookingOrder(db, b2.booking.id);
    expect(o.totalMinor).toBe(total / 2);
    expect(o.lines[0].sku).toBe('NO_SHOW_FEE');
    await setCheckin(db, b2.booking.id, 'arrived', actor); // erreur de saisie corrigée
    expect((await getBookingOrder(db, b2.booking.id)).totalMinor).toBe(total);

    // Le nombre d'absences du client apparaît sur ses réservations suivantes.
    const c = await db.query('SELECT customer_id FROM bookings WHERE id = $1', [b.booking.id]);
    const b3 = await createBooking(d, { ...staff, customerId: c.rows[0].customer_id }, { courseId: f.courseId, startsAt: at('10:00'), players: 1, holes: 18 });
    const row = (await getTeeSheet(db, f.courseId, DAY)).rows.find((x) => x.teeTimeId === b3.booking.teeTime.id)!;
    expect(row.bookings[0]).toMatchObject({ checkinStatus: 'expected' });
  });

  it('le starter enregistre les arrivées mais ne peut pas bloquer ; export CSV', async () => {
    const f: Fixture = await createClub(db);
    const app = buildServer({ db, now: () => NOW });
    const login = async (role: Role) => {
      const email = `ops.${role}.${Date.now()}.${Math.random()}@test.ma`;
      await createStaffUser(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', displayName: role, roles: [{ clubId: f.clubId, role }] });
      return (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token;
    };
    const starter = { authorization: `Bearer ${await login('starter')}` };
    const reception = { authorization: `Bearer ${await login('receptionist')}` };
    const b = await createBooking(d, { ...staff, customer: { lastName: '=Formule', phone: '+212600000000' } },
      { courseId: f.courseId, startsAt: at('08:00', '2030-06-03'), players: 3, holes: 18 });
    expect((await app.inject({ method: 'PUT', url: `/api/bookings/${b.booking.id}/checkin`, headers: starter, payload: { status: 'arrived' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: `/api/tee-times/${b.booking.teeTime.id}/started`, headers: starter, payload: { started: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/courses/${f.courseId}/blocks`, headers: starter,
      payload: { date: '2030-06-03', from: '10:00', to: '11:00', reason: 'x' } })).statusCode).toBe(403);
    const csvStarter = await app.inject({ method: 'GET', url: `/api/courses/${f.courseId}/tee-sheet.csv?date=2030-06-03`, headers: starter });
    expect(csvStarter.statusCode).toBe(200);
    expect(csvStarter.body).toContain('arrivé');
    expect(csvStarter.body).not.toContain('+212600000000'); // pas de coordonnées pour le starter
    expect(csvStarter.body).toContain("'=Formule"); // neutralisé dans Excel
    const csvReception = await teeSheetCsv(db, f.courseId, '2030-06-03', true);
    expect(csvReception).toContain('+212600000000');
    expect((await app.inject({ method: 'GET', url: `/api/courses/${f.courseId}/tee-sheet.csv?date=2030-06-03`, headers: reception })).statusCode).toBe(200);
    await app.close();
  });
});
