import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { createStaffUser, registerCustomer } from '../src/modules/auth/service.js';
import { createBooking } from '../src/modules/booking/service.js';
import { createMembership, myRounds, openGames, updateProfile } from '../src/modules/members/service.js';
import { getAvailability } from '../src/modules/teesheet/service.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const d = deps(db);
const actor = { type: 'system' as const };

async function setup() {
  const f = await createClub(db);
  // Membres : green fee inclus dans l'abonnement ; réservation jusqu'à 30 jours (public : horizon du golf).
  await db.query(`UPDATE clubs SET booking_horizon_days = 7 WHERE id = $1`, [f.clubId]);
  await db.query(`INSERT INTO tariffs (club_id, product, name, holes, customer_category, amount_minor, basis, priority)
                  VALUES ($1, 'green_fee', 'Green fee membre', NULL, 'member', 0, 'per_player', 5)`, [f.clubId]);
  const plan = (await db.query(
    `INSERT INTO membership_plans (club_id, code, name, price_category, booking_horizon_days) VALUES ($1, 'ANNUEL', 'Membre annuel', 'member', 30) RETURNING id`,
    [f.clubId])).rows[0].id as string;
  return { ...f, planId: plan };
}
const customer = async (f: Fixture, first: string, last: string, extra: { handicapIndex?: number; shareProfile?: boolean } = {}) => {
  const { rows } = await db.query(`INSERT INTO customers (organization_id, first_name, last_name) VALUES ($1, $2, $3) RETURNING id`,
    [f.organizationId, first, last]);
  if (Object.keys(extra).length) await updateProfile(db, rows[0].id, extra, actor);
  return rows[0].id as string;
};
const web = (customerId: string) => ({ channel: 'web' as const, actor, customerId });

describe('membres', () => {
  it('tarif membre et réservation ouverte plus tôt, seulement pendant la validité', async () => {
    const f = await setup();
    const member = await customer(f, 'Karim', 'Bennani');
    await createMembership(db, { id: f.clubId, organizationId: f.organizationId },
      { customerId: member, planId: f.planId, cardNumber: 'M-001', validFrom: '2030-01-01', validTo: '2030-12-31' }, actor);
    const visitor = await customer(f, 'Paul', 'Martin');

    // J+9 : au-delà des 7 jours publics, dans les 30 jours membres.
    const b = await createBooking(d, web(member), { courseId: f.courseId, startsAt: at('08:00'), players: 1, holes: 18 });
    expect(b.booking.customerCategory).toBe('member');
    expect(b.booking.pricing.totalMinor).toBe(20_000); // green fee inclus, caddie seul
    await expect(createBooking(d, web(visitor), { courseId: f.courseId, startsAt: at('09:00'), players: 1, holes: 18 }))
      .rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
    const avail = (horizonDays?: number) => getAvailability(db, { courseId: f.courseId, date: DAY, players: 1, holes: 18, now: NOW, enforceBookingWindow: true, horizonDays });
    expect((await avail()).slots).toHaveLength(0);
    expect((await avail(30)).slots.length).toBeGreaterThan(0);

    // Abonnement échu : tarif public.
    const expired = await customer(f, 'Ali', 'Ex');
    await createMembership(db, { id: f.clubId, organizationId: f.organizationId },
      { customerId: expired, planId: f.planId, validFrom: '2029-01-01', validTo: '2029-12-31' }, actor);
    const e = await createBooking(d, { ...staff, customerId: expired }, { courseId: f.courseId, startsAt: at('10:00'), players: 1, holes: 18 });
    expect(e.booking.customerCategory).toBe('standard');
    // Réservé par la réception pour un membre : tarif membre aussi.
    const s = await createBooking(d, { ...staff, customerId: member }, { courseId: f.courseId, startsAt: at('11:00'), players: 1, holes: 18 });
    expect(s.booking.customerCategory).toBe('member');
  });
});

describe('parties ouvertes', () => {
  it('liste avec heure, joueurs et handicaps partagés ; on rejoint ; confidentialité', async () => {
    const f = await setup();
    const karim = await customer(f, 'Karim', 'Bennani', { handicapIndex: 12.4, shareProfile: true });
    const discret = await customer(f, 'Sofia', 'Alaoui', { handicapIndex: 20 });
    const moi = await customer(f, 'Moi', 'Même');
    await createBooking(d, { ...staff, customerId: karim }, { courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18, isOpen: true, openNote: 'Partie amicale' });
    await createBooking(d, { ...staff, customerId: discret }, { courseId: f.courseId, startsAt: at('08:00'), players: 1, holes: 18 });
    await createBooking(d, { ...staff, customerId: discret }, { courseId: f.courseId, startsAt: at('09:00'), players: 2, holes: 18 }); // non ouverte
    await createBooking(d, { ...staff, customerId: karim }, { courseId: f.courseId, startsAt: at('10:00'), players: 4, holes: 18, isOpen: true }); // complète

    const games = await openGames(db, { organizationId: f.organizationId, customerId: moi }, { now: NOW, days: 30 });
    expect(games).toHaveLength(1);
    const g = games[0]!;
    expect(g).toMatchObject({ localTime: '08:00', date: DAY, holes: 18, remaining: 1, averageHandicap: 12.4, joined: false });
    expect(g.bookings).toEqual([
      { players: 2, isOpen: true, note: 'Partie amicale', mine: false, name: 'Karim B.', handicapIndex: 12.4 },
      { players: 1, isOpen: false, note: null, mine: false, name: null, handicapIndex: null }, // profil non partagé
    ]);
    await expect(createBooking(d, { ...staff, customerId: karim }, { courseId: f.courseId, startsAt: at('11:00'), players: 1, holes: 18, isOpen: true, isPrivate: true }))
      .rejects.toMatchObject({ code: 'VALIDATION' });

    // Rejoindre (réservation normale sur ce départ) : le caddie est partagé.
    await createBooking(d, { ...staff, customerId: moi }, { courseId: f.courseId, startsAt: at('08:00'), players: 1, holes: 18 });
    expect(await openGames(db, { organizationId: f.organizationId, customerId: moi }, { now: NOW, days: 30 })).toHaveLength(0);

    // Historique : partenaires de jeu (nom seulement si partagé).
    const r = await myRounds(db, moi, new Date('2030-06-11T00:00:00Z'));
    expect(r.past).toHaveLength(1);
    expect(r.past[0].companions).toEqual(expect.arrayContaining([{ players: 2, name: 'Karim B.', handicapIndex: 12.4 }, { players: 1, name: null, handicapIndex: null }]));
    expect(r.stats).toMatchObject({ roundsLast12Months: 1, rounds18: 1 });
  });

  it('API : profil, ouvrir sa partie, droits (golfeur seulement ; gestion des membres par la réception)', async () => {
    const f = await setup();
    const app = buildServer({ db, now: () => NOW });
    const login = async (email: string) =>
      ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token}` });
    const email = `golfeur.${Date.now()}@test.ma`;
    await registerCustomer(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', firstName: 'Nadia', lastName: 'Tazi' });
    const h = await login(email);
    const p = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: h, payload: { handicapIndex: 8.2, shareProfile: true, licenceNumber: 'FRMG-123' } });
    expect(p.json().profile).toMatchObject({ handicapIndex: 8.2, shareProfile: true, licenceNumber: 'FRMG-123', memberships: [] });
    expect((await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: h, payload: { handicapIndex: 60 } })).statusCode).toBe(422);

    const b = await app.inject({ method: 'POST', url: '/api/bookings', headers: h,
      payload: { courseId: f.courseId, startsAt: at('08:00', '2030-06-05').toISOString(), players: 2, holes: 18 } });
    expect(b.statusCode).toBe(201);
    const id = b.json().booking.id;
    expect((await app.inject({ method: 'PUT', url: `/api/me/bookings/${id}/open`, headers: h, payload: { isOpen: true, openNote: 'Cherche 2 joueurs' } })).statusCode).toBe(200);
    const other = `autre.${Date.now()}@test.ma`;
    await registerCustomer(db, { organizationId: f.organizationId, email: other, password: 'motdepasse-test', lastName: 'Autre' });
    const h2 = await login(other);
    const games = (await app.inject({ method: 'GET', url: '/api/open-games', headers: h2 })).json().games;
    expect(games[0].bookings[0]).toMatchObject({ name: 'Nadia T.', handicapIndex: 8.2, note: 'Cherche 2 joueurs' });
    expect((await app.inject({ method: 'PUT', url: `/api/me/bookings/${id}/open`, headers: h2, payload: { isOpen: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/open-games' })).statusCode).toBe(401);

    const recEmail = `rec.${Date.now()}@test.ma`;
    await createStaffUser(db, { organizationId: f.organizationId, email: recEmail, password: 'motdepasse-test', displayName: 'Rec', roles: [{ clubId: f.clubId, role: 'receptionist' }] });
    const rec = await login(recEmail);
    const m = await app.inject({ method: 'POST', url: `/api/clubs/${f.clubId}/members`, headers: rec,
      payload: { customer: { firstName: 'Omar', lastName: 'Membre' }, planId: f.planId, cardNumber: 'C-9', validFrom: '2030-01-01', validTo: '2030-12-31', handicapIndex: 15 } });
    expect(m.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/clubs/${f.clubId}/members`, headers: rec,
      payload: { customer: { lastName: 'Doublon' }, planId: f.planId, cardNumber: 'C-9', validFrom: '2030-01-01', validTo: '2030-12-31' } })).statusCode).toBe(422);
    const list = (await app.inject({ method: 'GET', url: `/api/clubs/${f.clubId}/members?q=omar`, headers: rec })).json().members;
    expect(list[0]).toMatchObject({ lastName: 'Membre', cardNumber: 'C-9', handicapIndex: 15, planName: 'Membre annuel' });
    expect((await app.inject({ method: 'PATCH', url: `/api/clubs/${f.clubId}/members/${m.json().id}`, headers: rec, payload: { status: 'suspended' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/clubs/${f.clubId}/members`, headers: h })).statusCode).toBe(403);
    await app.close();
  });
});
