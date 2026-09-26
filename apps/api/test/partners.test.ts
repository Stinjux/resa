import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { createStaffUser } from '../src/modules/auth/service.js';
import { issueInvoice } from '../src/modules/billing/service.js';
import { createBooking } from '../src/modules/booking/service.js';
import {
  cancelAllotment, createAllotment, createPartnerUser, listAllotments, partnerStatement, releaseDueAllotments, savePartner,
} from '../src/modules/partners/service.js';
import { getAvailability } from '../src/modules/teesheet/service.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const d = deps(db);
const actor = { type: 'system' as const };

async function setup(): Promise<Fixture & { partnerId: string; otherId: string }> {
  const f = await createClub(db);
  // Tarif négocié tour-opérateur : 1 000 MAD au lieu de 1 300.
  await db.query(
    `INSERT INTO tariffs (club_id, product, name, holes, customer_category, amount_minor, basis, priority)
     VALUES ($1, 'green_fee', 'Green fee TO', 18, 'to', 100000, 'per_player', 5)`, [f.clubId]);
  const p = await savePartner(db, f.organizationId, null, { code: 'ATLAS', name: 'Atlas Golf Tours', priceCategory: 'to',
    legalName: 'Atlas Golf Tours SARL', ice: '001122334000055', address: 'Marrakech' }, actor);
  const o = await savePartner(db, f.organizationId, null, { code: 'OTHER', name: 'Autre TO', priceCategory: 'to' }, actor);
  return { ...f, partnerId: p.id, otherId: o.id };
}
const avail = (f: Fixture, partnerId?: string) =>
  getAvailability(db, { courseId: f.courseId, date: DAY, players: 2, holes: 18, now: NOW, enforceBookingWindow: false, partnerId })
    .then((r) => r.slots);

describe('partenaires', () => {
  it('tarifs négociés appliqués aux réservations du partenaire ; voucher conservé', async () => {
    const f = await setup();
    const b = await createBooking(d, { ...staff, partnerId: f.partnerId, partnerReference: 'V-2030-001', customer: { lastName: 'Smith' } },
      { courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18 });
    expect(b.booking.partner).toMatchObject({ id: f.partnerId, name: 'Atlas Golf Tours', reference: 'V-2030-001' });
    expect(b.booking.customerCategory).toBe('to');
    expect(b.booking.pricing.totalMinor).toBe(2 * 100_000 + 20_000);
    // Même si le personnel choisit une autre catégorie, le partenaire garde la sienne.
    const b2 = await createBooking(d, { ...staff, partnerId: f.partnerId }, { courseId: f.courseId, startsAt: at('09:00'), players: 1, holes: 18, customerCategory: 'standard' });
    expect(b2.booking.customerCategory).toBe('to');

    // Facture partenaire (sa part : green fees) pour cette réservation.
    await db.query(`UPDATE clubs SET legal_name = 'Golf SARL', legal_address = 'Adresse', ice = '000000000000009' WHERE id = $1`, [f.clubId]);
    const inv = await issueInvoice(db, b.booking.id, { payer: 'partner' }, actor);
    expect(inv.buyer).toEqual({ name: 'Atlas Golf Tours SARL', address: 'Marrakech', ice: '001122334000055' });
    expect(inv.totalMinor).toBe(200_000);

    const s = await partnerStatement(db, f.partnerId, f.clubId, DAY, DAY);
    expect(s.totals).toMatchObject({ players: 3, totalMinor: 300_000, paidMinor: 0 });
    expect(s.bookings[0]).toMatchObject({ partnerReference: 'V-2030-001', leadName: 'Smith', invoiceNumbers: inv.number, customerMinor: 20_000 });
  });

  it('allotement : départs tenus pour le partenaire, puis rendus à la vente à la date de release', async () => {
    const f = await setup();
    await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:18'), players: 1, holes: 18 }); // déjà réservé : pas tenu
    const a = await createAllotment(db, f.clubId, { partnerId: f.partnerId, courseId: f.courseId, dateFrom: DAY, dateTo: DAY,
      startTime: '08:00', endTime: '08:30', releaseDays: 3 }, actor, NOW);
    expect(a.held).toBe(5); // 08:00 → 08:30 toutes les 6 min, sauf 08:18

    expect((await avail(f)).map((s) => s.localTime)).not.toContain('08:12');
    const mine = (await avail(f, f.partnerId)).find((s) => s.localTime === '08:12');
    expect(mine).toMatchObject({ heldForPartner: true, remaining: 4 });
    expect((await avail(f, f.otherId)).map((s) => s.localTime)).not.toContain('08:12');

    await expect(createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:12'), players: 2, holes: 18 }))
      .rejects.toMatchObject({ code: 'TEE_TIME_BLOCKED' });
    await expect(createBooking(d, { ...staff, partnerId: f.otherId }, { courseId: f.courseId, startsAt: at('08:12'), players: 2, holes: 18 }))
      .rejects.toMatchObject({ code: 'TEE_TIME_BLOCKED' });
    await createBooking(d, { ...staff, partnerId: f.partnerId }, { courseId: f.courseId, startsAt: at('08:12'), players: 2, holes: 18 });
    expect((await avail(f, f.partnerId)).find((s) => s.localTime === '08:12')?.remaining).toBe(2);
    expect((await listAllotments(db, f.clubId))[0]).toMatchObject({ heldTeeTimes: 5, bookedPlayers: 2 });

    // Avant la release : rien ne bouge ; après (J-3 à minuit) : tout revient à la vente.
    expect(await releaseDueAllotments(db, new Date('2030-06-06T12:00:00Z'))).toBe(0);
    await releaseDueAllotments(db, new Date('2030-06-07T00:00:00Z'));
    expect((await avail(f)).find((s) => s.localTime === '08:12')?.remaining).toBe(2);
    await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:00'), players: 4, holes: 18 });
  });

  it('allotement annulé : départs libérés ; jours déjà échus ignorés', async () => {
    const f = await setup();
    const late = await createAllotment(db, f.clubId, { partnerId: f.partnerId, courseId: f.courseId, dateFrom: '2030-06-02', dateTo: '2030-06-02',
      startTime: '08:00', endTime: '09:00', releaseDays: 7 }, actor, NOW);
    expect(late.held).toBe(0);
    const a = await createAllotment(db, f.clubId, { partnerId: f.partnerId, courseId: f.courseId, dateFrom: DAY, dateTo: DAY,
      startTime: '10:00', endTime: '10:06', releaseDays: 1 }, actor, NOW);
    expect(a.held).toBe(2);
    expect(await cancelAllotment(db, f.clubId, a.id, actor)).toEqual({ released: 2 });
    expect((await avail(f)).map((s) => s.localTime)).toContain('10:00');
  });
});

describe('portail partenaire', () => {
  it('le partenaire réserve sur ses allotements, voit et annule ses réservations, rien d’autre', async () => {
    const f = await setup();
    const app = buildServer({ db, now: () => NOW });
    const login = async (email: string) =>
      ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token}` });
    const email = `to.${Date.now()}@test.ma`;
    await createPartnerUser(db, f.partnerId, { email, displayName: 'Agent Atlas', password: 'motdepasse-test' }, actor);
    const h = await login(email);
    await createAllotment(db, f.clubId, { partnerId: f.partnerId, courseId: f.courseId, dateFrom: DAY, dateTo: DAY,
      startTime: '08:00', endTime: '08:00', releaseDays: 3 }, actor, NOW);

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: h });
    expect(me.json().user).toMatchObject({ partnerId: f.partnerId, partnerName: 'Atlas Golf Tours', roles: [] });
    const slots = (await app.inject({ method: 'GET', url: `/api/partner/availability?courseId=${f.courseId}&date=${DAY}&players=3&holes=18`, headers: h })).json().slots;
    expect(slots.find((s: { localTime: string }) => s.localTime === '08:00')).toMatchObject({ heldForPartner: true });
    const q = await app.inject({ method: 'POST', url: '/api/partner/quote', headers: h, payload: { courseId: f.courseId, startsAt: at('08:00').toISOString(), players: 3, holes: 18 } });
    expect(q.json().quote.totalMinor).toBe(3 * 100_000 + 20_000);

    const payload = { courseId: f.courseId, startsAt: at('08:00').toISOString(), players: 3, holes: 18, partnerReference: 'VCH-77', leadName: 'Müller' };
    const r = await app.inject({ method: 'POST', url: '/api/partner/bookings', headers: { ...h, 'idempotency-key': 'k1' }, payload });
    expect(r.statusCode).toBe(201);
    expect(r.json().booking).toMatchObject({ channel: 'partner', customerCategory: 'to', partner: { reference: 'VCH-77' } });
    expect((await app.inject({ method: 'POST', url: '/api/partner/bookings', headers: { ...h, 'idempotency-key': 'k1' }, payload })).statusCode).toBe(200);

    const list = (await app.inject({ method: 'GET', url: `/api/partner/bookings?from=${DAY}&to=${DAY}`, headers: h })).json().bookings;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ partnerReference: 'VCH-77', leadName: 'Müller', players: 3 });

    // Pas d'accès aux écrans du personnel ni aux réservations des autres.
    expect((await app.inject({ method: 'GET', url: '/api/partners', headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/courses/${f.courseId}/tee-sheet?date=${DAY}`, headers: h })).statusCode).toBe(403);
    const other = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('11:00'), players: 1, holes: 18 });
    expect((await app.inject({ method: 'POST', url: `/api/partner/bookings/${other.booking.id}/cancel`, headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/bookings/${other.booking.id}`, headers: h })).statusCode).toBe(403);
    // Un client web ne peut pas se déclarer partenaire.
    expect((await app.inject({ method: 'POST', url: '/api/bookings', payload: { courseId: f.courseId, startsAt: at('12:00').toISOString(),
      players: 1, holes: 18, partnerId: f.partnerId, customer: { lastName: 'X' } } })).statusCode).toBe(403);

    const c = await app.inject({ method: 'POST', url: `/api/partner/bookings/${r.json().booking.id}/cancel`, headers: h });
    expect(c.json().booking.status).toBe('cancelled');

    // Relevé : direction seulement.
    const adminEmail = `dir.${Date.now()}@test.ma`;
    await createStaffUser(db, { organizationId: f.organizationId, email: adminEmail, password: 'motdepasse-test', displayName: 'Dir', roles: [{ clubId: f.clubId, role: 'club_admin' }] });
    const admin = await login(adminEmail);
    const url = `/api/partners/${f.partnerId}/statement.csv?clubId=${f.clubId}&from=${DAY}&to=${DAY}`;
    expect((await app.inject({ method: 'GET', url, headers: h })).statusCode).toBe(403);
    const csv = await app.inject({ method: 'GET', url, headers: admin });
    expect(csv.body).toContain('VCH-77');
    expect(csv.body).toContain('annulée');
    await app.close();
  });
});
