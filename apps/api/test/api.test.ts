import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { createStaffUser, registerCustomer } from '../src/modules/auth/service.js';
import type { Role } from '../src/modules/auth/permissions.js';
import { at, createClub, NOW, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const app = buildServer({ db, now: () => NOW });
const SOON = '2030-06-03'; // dans la semaine du starter (aujourd'hui = 01/06)
const LATER = '2030-06-12';
const PASSWORD = 'motdepasse-test';

let n = 0;
async function staffToken(f: Fixture, role: Role): Promise<string> {
  const email = `${role}.${++n}.${Date.now()}@test.ma`;
  await createStaffUser(db, { organizationId: f.organizationId, email, password: PASSWORD, displayName: role,
    roles: [{ clubId: role === 'org_admin' ? null : f.clubId, role }] });
  return login(email);
}
async function customerToken(f: Fixture): Promise<string> {
  const email = `client.${++n}.${Date.now()}@test.ma`;
  await registerCustomer(db, { organizationId: f.organizationId, email, password: PASSWORD, lastName: 'Client' });
  return login(email);
}
async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return res.json().token;
}
function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, token?: string | null, payload?: object) {
  return app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
}
function bookingPayload(f: Fixture, time: string, date: string, extra: object = {}) {
  return { courseId: f.courseId, startsAt: at(time, date).toISOString(), players: 2, holes: 18, ...extra };
}

describe('authentification', () => {
  it('refuse un mauvais mot de passe et un jeton invalide', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@test.ma', password: 'x' } });
    expect(res.statusCode).toBe(401);
    expect((await call('GET', '/api/me', 'faux-jeton')).statusCode).toBe(401);
  });
});

describe('réceptionniste : uniquement son golf', () => {
  it('voit la feuille de son golf, pas celle d’un autre golf du groupe', async () => {
    const a = await createClub(db);
    const b = await createClub(db, { organizationId: a.organizationId });
    const token = await staffToken(a, 'receptionist');
    expect((await call('GET', `/api/courses/${a.courseId}/tee-sheet?date=${LATER}`)).statusCode).toBe(401);
    expect((await call('GET', `/api/courses/${a.courseId}/tee-sheet?date=${LATER}`, token)).statusCode).toBe(200);
    expect((await call('GET', `/api/courses/${b.courseId}/tee-sheet?date=${LATER}`, token)).statusCode).toBe(403);
    const res = await call('POST', '/api/bookings', token, { ...bookingPayload(b, '08:00', LATER), channel: 'phone', customer: { lastName: 'X' } });
    expect(res.statusCode).toBe(403);
  });

  it('ne retrouve que les golfeurs ayant réservé dans son golf', async () => {
    const a = await createClub(db);
    const b = await createClub(db, { organizationId: a.organizationId });
    const recA = await staffToken(a, 'receptionist');
    const recB = await staffToken(b, 'receptionist');
    const ra = await call('POST', '/api/bookings', recA, { ...bookingPayload(a, '08:00', LATER), channel: 'phone', customer: { lastName: 'Golfeur-A', phone: '+212600000001' } });
    expect(ra.statusCode).toBe(201);
    await call('POST', '/api/bookings', recB, { ...bookingPayload(b, '08:00', LATER), channel: 'phone', customer: { lastName: 'Golfeur-B' } });

    const list = (await call('GET', `/api/clubs/${a.clubId}/customers?q=Golfeur`, recA)).json().customers;
    expect(list.map((c: { lastName: string }) => c.lastName)).toEqual(['Golfeur-A']);
    const idA = ra.json().booking.customerId;
    expect((await call('GET', `/api/clubs/${b.clubId}/customers/${idA}`, recB)).statusCode).toBe(404); // inexistant pour ce golf
    // Même en connaissant l'identifiant, la réception B ne peut pas l'utiliser.
    const reuse = await call('POST', '/api/bookings', recB, { ...bookingPayload(b, '09:00', LATER), channel: 'phone', customerId: idA });
    expect(reuse.statusCode).toBe(404);
  });

  it('crée une réservation téléphonique tarifée, historisée avec son auteur', async () => {
    const a = await createClub(db);
    const rec = await staffToken(a, 'receptionist');
    const res = await call('POST', '/api/bookings', rec, {
      ...bookingPayload(a, '08:00', LATER), channel: 'phone', customer: { lastName: 'Alami' }, caddiePayment: 'with_booking',
    });
    expect(res.statusCode).toBe(201);
    const booking = res.json().booking;
    expect(booking.pricing.totalMinor).toBe(2 * 130000 + 20000);
    expect(booking.pricing.dueOnSiteMinor).toBe(0);
    const history = (await call('GET', `/api/bookings/${booking.id}/history`, rec)).json().history;
    expect(history[0]).toMatchObject({ action: 'booking.created', actorType: 'user', actorName: 'receptionist' });
  });
});

describe('client', () => {
  it('réserve en ligne au tarif standard, voit ses réservations mais pas celles des autres', async () => {
    const f = await createClub(db);
    await db.query(
      `INSERT INTO tariffs (club_id, product, name, holes, customer_category, amount_minor, basis, priority)
       VALUES ($1, 'green_fee', 'Résident', 18, 'resident', 90000, 'per_player', 5)`,
      [f.clubId],
    );
    const token = await customerToken(f);
    const res = await call('POST', '/api/bookings', token, { ...bookingPayload(f, '08:00', LATER), customerCategory: 'resident' });
    expect(res.statusCode).toBe(201);
    const mine = res.json().booking;
    expect(mine.channel).toBe('web');
    expect(mine.customerCategory).toBe('standard'); // la catégorie n'est pas choisie par le client
    expect(mine.pricing.lines[0].unitAmountMinor).toBe(130000);
    expect(mine.caddiePayment).toBe('on_site');

    expect((await call('GET', `/api/bookings/${mine.id}`, token)).statusCode).toBe(200);
    const anon = await call('POST', '/api/bookings', null, { ...bookingPayload(f, '09:00', LATER), customer: { lastName: 'Invité' } });
    expect(anon.statusCode).toBe(201);
    expect((await call('GET', `/api/bookings/${anon.json().booking.id}`, token)).statusCode).toBe(403);
    expect((await call('POST', '/api/bookings', token, { ...bookingPayload(f, '10:00', LATER), channel: 'phone' })).statusCode).toBe(403);
    expect((await call('POST', `/api/bookings/${mine.id}/cancel`, token)).statusCode).toBe(403);
  });
});

describe('starter', () => {
  async function setup() {
    const f = await createClub(db, { carts: 2 });
    const rec = await staffToken(f, 'receptionist');
    const starter = await staffToken(f, 'starter');
    const caddies = await db.query(
      `INSERT INTO caddies (club_id, display_name) VALUES ($1, 'Caddie A'), ($1, 'Caddie B') RETURNING id`,
      [f.clubId],
    );
    const units = await db.query(
      `INSERT INTO resource_units (resource_type_id, label) VALUES ($1, 'V-01'), ($1, 'V-02') RETURNING id`,
      [f.rt.CART],
    );
    return { f, rec, starter, caddieIds: caddies.rows.map((r) => r.id), unitIds: units.rows.map((r) => r.id) };
  }

  it('voit le jour et la semaine, sans les coordonnées des golfeurs, et ne peut pas réserver', async () => {
    const { f, rec, starter } = await setup();
    await call('POST', '/api/bookings', rec, {
      ...bookingPayload(f, '08:00', SOON), channel: 'phone', customer: { lastName: 'Alami', phone: '+212611111111' },
    });
    const board = await call('GET', `/api/clubs/${f.clubId}/starter?date=2030-06-01&days=7`, starter);
    expect(board.statusCode).toBe(200);
    expect(board.json().teeTimes).toHaveLength(1);
    expect(board.json().teeTimes[0].bookings[0].customerName).toBe('Alami');
    expect(JSON.stringify(board.json())).not.toContain('+212611111111');

    const sheet = await call('GET', `/api/courses/${f.courseId}/tee-sheet?date=${SOON}`, starter);
    expect(sheet.statusCode).toBe(200);
    expect(JSON.stringify(sheet.json())).not.toContain('+212611111111');
    expect((await call('GET', `/api/courses/${f.courseId}/tee-sheet?date=${LATER}`, starter)).statusCode).toBe(403);
    expect((await call('GET', `/api/clubs/${f.clubId}/starter?date=2030-06-05&days=7`, starter)).statusCode).toBe(403);
    expect((await call('GET', `/api/clubs/${f.clubId}/customers`, starter)).statusCode).toBe(403);
    expect((await call('POST', '/api/bookings', starter, { ...bookingPayload(f, '09:00', SOON), channel: 'phone' })).statusCode).toBe(403);
  });

  it('attribue un caddie nommé sans doublon sur des départs qui se chevauchent', async () => {
    const { f, rec, starter, caddieIds } = await setup();
    const b1 = (await call('POST', '/api/bookings', rec, { ...bookingPayload(f, '08:00', SOON), channel: 'phone' })).json().booking;
    const b2 = (await call('POST', '/api/bookings', rec, { ...bookingPayload(f, '08:30', SOON), channel: 'phone' })).json().booking;

    expect((await call('PUT', `/api/tee-times/${b1.teeTime.id}/caddie`, rec, { caddieId: caddieIds[0] })).statusCode).toBe(403);
    expect((await call('PUT', `/api/tee-times/${b1.teeTime.id}/caddie`, starter, { caddieId: caddieIds[0] })).statusCode).toBe(204);
    const clash = await call('PUT', `/api/tee-times/${b2.teeTime.id}/caddie`, starter, { caddieId: caddieIds[0] });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('CADDIE_ALREADY_ASSIGNED');
    expect((await call('PUT', `/api/tee-times/${b2.teeTime.id}/caddie`, starter, { caddieId: caddieIds[1] })).statusCode).toBe(204);

    const board = (await call('GET', `/api/clubs/${f.clubId}/starter?date=${SOON}`, starter)).json();
    expect(board.teeTimes.map((t: { caddie: { name: string } }) => t.caddie.name)).toEqual(['Caddie A', 'Caddie B']);

    // Annulation : le départ se vide, le caddie nommé est libéré.
    await call('POST', `/api/bookings/${b1.id}/cancel`, rec, {});
    expect((await call('PUT', `/api/tee-times/${b2.teeTime.id}/caddie`, starter, { caddieId: caddieIds[0] })).statusCode).toBe(204);
  });

  it('attribue le matériel nominatif sans doublon sur la même période', async () => {
    const { f, rec, starter, unitIds } = await setup();
    const opt = { options: [{ code: 'CART', quantity: 1 }] };
    await call('POST', '/api/bookings', rec, { ...bookingPayload(f, '08:00', SOON, opt), channel: 'phone' });
    await call('POST', '/api/bookings', rec, { ...bookingPayload(f, '09:00', SOON, opt), channel: 'phone' });
    const board = (await call('GET', `/api/clubs/${f.clubId}/starter?date=${SOON}`, starter)).json();
    const [a1, a2] = board.teeTimes.map((t: { bookings: Array<{ equipment: Array<{ allocationId: string }> }> }) => t.bookings[0]!.equipment[0]!.allocationId);

    expect((await call('PUT', `/api/allocations/${a1}/units`, starter, { unitIds: [unitIds[0]] })).statusCode).toBe(204);
    const clash = await call('PUT', `/api/allocations/${a2}/units`, starter, { unitIds: [unitIds[0]] });
    expect(clash.statusCode).toBe(409);
    expect((await call('PUT', `/api/allocations/${a2}/units`, starter, { unitIds: unitIds })).statusCode).toBe(422); // 2 > quantité 1
    expect((await call('PUT', `/api/allocations/${a2}/units`, starter, { unitIds: [unitIds[1]] })).statusCode).toBe(204);
    const after = (await call('GET', `/api/clubs/${f.clubId}/starter?date=${SOON}`, starter)).json();
    expect(after.teeTimes[0].bookings[0].equipment[0].units).toEqual([{ id: unitIds[0], label: 'V-01' }]);
  });
});

describe('administration', () => {
  it('l’admin du groupe voit tous les golfs ; seul un admin lit l’historique du golf', async () => {
    const a = await createClub(db);
    const b = await createClub(db, { organizationId: a.organizationId });
    const admin = await staffToken(a, 'org_admin');
    const rec = await staffToken(a, 'receptionist');
    expect((await call('GET', `/api/courses/${b.courseId}/tee-sheet?date=${LATER}`, admin)).statusCode).toBe(200);
    expect((await call('GET', `/api/clubs/${a.clubId}/audit`, admin)).statusCode).toBe(200);
    expect((await call('GET', `/api/clubs/${a.clubId}/audit`, rec)).statusCode).toBe(403);
  });
});

describe('sécurité', () => {
  it('limite les tentatives de connexion et envoie les en-têtes de sécurité', async () => {
    const strictApp = buildServer({ db, now: () => NOW }, { loginRateLimit: 3 });
    const attempt = () => strictApp.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@test.ma', password: 'mauvais' } });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    const health = await strictApp.inject({ method: 'GET', url: '/health' });
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    await strictApp.close();
  });
});
