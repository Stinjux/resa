import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { computeAnalytics, analyticsCsv } from '../src/modules/analytics/service.js';
import { createStaffUser } from '../src/modules/auth/service.js';
import type { Role } from '../src/modules/auth/permissions.js';
import { cancelBooking, createBooking, moveBooking, updateBooking } from '../src/modules/booking/service.js';
import { getClub, listResourceTypes } from '../src/modules/catalog/repository.js';
import { bookingHistory, searchHistory } from '../src/modules/history/service.js';
import { blockRange, setCheckin } from '../src/modules/operations/service.js';
import { recordStaffPayment, recordStaffRefund } from '../src/modules/orders/service.js';
import {
  declareUnavailability, endUnavailability, getResourceBoard, listConflicts, unitOptions,
} from '../src/modules/resources/availability.js';
import { availableQuantity } from '../src/modules/resources/service.js';
import { assignCaddie, assignUnits } from '../src/modules/starter/service.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const d = deps(db);

async function user(f: Fixture, name: string, role: Role = 'receptionist') {
  const id = await createStaffUser(db, { organizationId: f.organizationId, email: `${name}.${Date.now()}.${Math.random()}@t.ma`,
    password: 'motdepasse-test', displayName: name, roles: [{ clubId: role === 'org_admin' ? null : f.clubId, role }] });
  return { type: 'user' as const, id };
}
async function units(f: Fixture, code: 'CART' | 'BAG_MEN_RH', labels: string[]) {
  const ids: Record<string, string> = {};
  for (const l of labels) {
    ids[l] = (await db.query('INSERT INTO resource_units (resource_type_id, label) VALUES ($1, $2) RETURNING id', [f.rt[code], l])).rows[0].id;
  }
  return ids;
}
async function caddie(f: Fixture, name: string) {
  return (await db.query('INSERT INTO caddies (club_id, display_name) VALUES ($1, $2) RETURNING id', [f.clubId, name])).rows[0].id as string;
}
async function cartAllocation(bookingId: string) {
  return (await db.query(
    `SELECT a.id FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id
      WHERE a.booking_id = $1 AND a.status = 'active' AND rt.code = 'CART'`, [bookingId])).rows[0]?.id as string | undefined;
}
async function freeCarts(f: Fixture, from: string, to: string) {
  const rt = (await listResourceTypes(db, f.clubId)).find((r) => r.code === 'CART')!;
  return availableQuantity(db, rt, DAY, at(from), at(to));
}
const withCart = (time: string, extra: object = {}) => ({ courseId: '', startsAt: at(time), players: 2, holes: 18 as const,
  options: [{ code: 'CART', quantity: 1 }], ...extra });

describe('disponibilité des ressources', () => {
  it('deux réservations simultanées de la dernière voiturette : une seule passe', async () => {
    const f = await createClub(db, { carts: 1 });
    const results = await Promise.allSettled([
      createBooking(d, staff, { ...withCart('08:00'), courseId: f.courseId }),
      createBooking(d, staff, { ...withCart('08:06'), courseId: f.courseId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'RESOURCE_UNAVAILABLE' } });
    // Toute la durée de jeu compte (18 trous = 270 min) : 12:00 chevauche encore, 12:30 est libre.
    const first = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>;
    const start = first.value.booking.teeTime.localTime;
    await expect(createBooking(d, staff, { ...withCart('12:00'), courseId: f.courseId })).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    const end = start === '08:00' ? '12:30' : '12:36';
    await expect(createBooking(d, staff, { ...withCart(end), courseId: f.courseId })).resolves.toBeTruthy();
  });

  it('déplacement : la période suit, le n° est conservé ; annulation : tout est libéré', async () => {
    const f = await createClub(db, { carts: 2 });
    const u = await units(f, 'CART', ['V-01', 'V-02']);
    const sarah = await user(f, 'Sarah');
    const b = await createBooking(d, { ...staff, actor: sarah }, { ...withCart('10:00'), courseId: f.courseId });
    await assignUnits(db, (await cartAllocation(b.booking.id))!, [u['V-01']!], sarah);
    expect(await freeCarts(f, '10:00', '14:00')).toBe(1);

    await moveBooking(d, b.booking.id, { courseId: f.courseId, startsAt: at('10:12') }, { actor: sarah });
    const alloc = (await db.query(
      `SELECT lower(period) AS s, (SELECT array_agg(unit_id) FROM allocation_units WHERE allocation_id = a.id) AS units
         FROM resource_allocations a WHERE id = $1`, [await cartAllocation(b.booking.id)])).rows[0];
    expect(alloc.s.toISOString()).toBe(at('10:12').toISOString());
    expect(alloc.units).toEqual([u['V-01']]);
    expect(await freeCarts(f, '14:35', '14:40')).toBe(1); // 10:12 + 270 min = 14:42

    await cancelBooking(d, b.booking.id, { actor: sarah, reason: 'Client malade' });
    expect(await cartAllocation(b.booking.id)).toBeUndefined();
    expect(await freeCarts(f, '10:00', '15:00')).toBe(2);
    const caddieAllocs = await db.query(`SELECT 1 FROM resource_allocations WHERE tee_time_id = $1 AND status = 'active'`, [b.booking.teeTime.id]);
    expect(caddieAllocs.rowCount).toBe(0);

    const h = await bookingHistory(db, b.booking.id);
    expect(h.map((e) => e.action)).toEqual(['booking.created', 'allocation.units_assigned', 'booking.moved', 'booking.cancelled']);
    expect(h[2]!.text).toBe(`Sarah a déplacé le départ de ${b.booking.reference} de 10 h à 10 h 12`);
    expect(h[1]!.text).toBe(`Sarah a affecté Voiturette V-01 à ${b.booking.reference}`);
    expect(h[3]).toMatchObject({ reason: 'Client malade', actor: { name: 'Sarah' } });
  });

  it('une maintenance qui chevauche une réservation la signale et permet la réaffectation', async () => {
    const f = await createClub(db, { carts: 2 });
    const u = await units(f, 'CART', ['V-01', 'V-02']);
    const manager = await user(f, 'Karim', 'club_admin');
    const a = await createBooking(d, staff, { ...withCart('08:00'), courseId: f.courseId });
    const allocA = (await cartAllocation(a.booking.id))!;
    await assignUnits(db, allocA, [u['V-01']!], manager);

    const r = await declareUnavailability(db, f.clubId, { unitId: u['V-01']!, startsAt: at('07:00'), endsAt: at('18:00'), reason: 'Pneu crevé' }, manager, NOW);
    expect(r.affected.map((c) => c.references).flat()).toEqual([a.booking.reference]);
    expect(r.overflow).toBe(0);
    // Même unité, même période : refusé (pas de double comptage).
    await expect(declareUnavailability(db, f.clubId, { unitId: u['V-01']!, startsAt: at('09:00'), endsAt: null, reason: 'x' }, manager, NOW))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    // La capacité baisse : 2 voiturettes − 1 en maintenance − 1 réservée = 0.
    await expect(createBooking(d, staff, { ...withCart('08:30'), courseId: f.courseId })).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });

    const opts = await unitOptions(db, allocA);
    expect(opts.units.find((x) => x.label === 'V-01')).toMatchObject({ free: false, conflict: expect.stringMatching(/^En maintenance .*Pneu crevé/) });
    expect(opts.units.find((x) => x.label === 'V-02')).toMatchObject({ free: true, conflict: null });
    const club = await getClub(db, f.clubId);
    expect((await getResourceBoard(db, club, DAY, NOW)).units.find((x) => x.label === 'V-01')).toMatchObject({ status: 'unavailable' });

    await assignUnits(db, allocA, [u['V-02']!], manager);
    expect(await listConflicts(db, club, NOW)).toEqual([]);
    const h = await bookingHistory(db, a.booking.id);
    expect(h.map((e) => e.text)).toContain(`Karim a remplacé V-01 par V-02 (Voiturette) sur ${a.booking.reference}`);
    expect(h.find((e) => e.action === 'resource.unavailability_declared')).toMatchObject({ reason: 'Pneu crevé' });

    // Remise en service (pas encore commencée → annulée) : la voiturette redevient réservable.
    expect((await endUnavailability(db, r.unavailability.id, manager, NOW)).cancelled).toBe(true);
    await expect(createBooking(d, staff, { ...withCart('08:30'), courseId: f.courseId })).resolves.toBeTruthy();
  });

  it('un caddie absent ne peut pas être affecté et réduit le nombre de caddies', async () => {
    const f = await createClub(db, { caddies: 2 });
    const c1 = await caddie(f, 'Ahmed');
    const manager = await user(f, 'Karim', 'club_admin');
    await declareUnavailability(db, f.clubId, { caddieId: c1, startsAt: at('06:00'), endsAt: at('20:00'), reason: 'Congé' }, manager, NOW);
    const a = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18 });
    await expect(assignCaddie(db, a.booking.teeTime.id, c1, manager)).rejects.toMatchObject({ code: 'CADDIE_UNAVAILABLE' });
    // 2 caddies − 1 absent = 1 : un second départ qui chevauche n'a plus de caddie.
    await expect(createBooking(d, staff, { courseId: f.courseId, startsAt: at('09:00'), players: 2, holes: 18 }))
      .rejects.toMatchObject({ code: 'CADDIE_UNAVAILABLE' });
  });

  it('deux réservations réunies sur un départ partagent son unique caddie', async () => {
    const f = await createClub(db, { caddies: 1 });
    const ali = await caddie(f, 'Ali');
    const starter = await user(f, 'Youssef', 'starter');
    const a = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18 });
    const b = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18 });
    const allocs = await db.query(`SELECT 1 FROM resource_allocations WHERE tee_time_id = $1 AND status = 'active'`, [a.booking.teeTime.id]);
    expect(allocs.rowCount).toBe(1);
    await expect(createBooking(d, staff, { courseId: f.courseId, startsAt: at('09:00'), players: 1, holes: 18 }))
      .rejects.toMatchObject({ code: 'CADDIE_UNAVAILABLE' });
    await assignCaddie(db, a.booking.teeTime.id, ali, starter);

    await cancelBooking(d, a.booking.id, { actor: starter });
    expect((await db.query(`SELECT 1 FROM resource_allocations WHERE tee_time_id = $1 AND status = 'active'`, [a.booking.teeTime.id])).rowCount).toBe(1);
    await cancelBooking(d, b.booking.id, { actor: starter });
    expect((await db.query(`SELECT 1 FROM resource_allocations WHERE tee_time_id = $1 AND status = 'active'`, [a.booking.teeTime.id])).rowCount).toBe(0);
    await expect(createBooking(d, staff, { courseId: f.courseId, startsAt: at('09:00'), players: 1, holes: 18 })).resolves.toBeTruthy();

    // L'affectation du caddie apparaît dans l'historique des deux réservations ; la réunion est tracée.
    const hb = await bookingHistory(db, b.booking.id);
    expect(hb[0]!.text).toContain(`sur un départ partagé avec ${a.booking.reference}`);
    expect(hb.map((e) => e.text)).toContain(`Youssef a affecté Ali au départ de 8 h (${a.booking.reference}, ${b.booking.reference})`);
    expect((await bookingHistory(db, a.booking.id)).some((e) => e.action === 'tee_time.caddie_assigned')).toBe(true);
    // Le partage du caddie modifie le prix de la première réservation : tracé aussi.
    expect((await bookingHistory(db, a.booking.id)).some((e) => e.action === 'booking.price_recalculated')).toBe(true);
  });
});

describe('rapports de gestion', () => {
  it('occupation hors départs fermés, exclusivité à part, montants séparés, données non disponibles', async () => {
    const f = await createClub(db, { interval: 60 });
    const actor = await user(f, 'Nadia', 'club_admin');
    const exclusive = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18, isPrivate: true });
    const b = await createBooking(d, staff, { ...withCart('09:00'), courseId: f.courseId, players: 3 });
    const c = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('11:00'), players: 1, holes: 18 });
    await cancelBooking(d, c.booking.id, { actor, waiveFee: true });
    await blockRange(db, { courseId: f.courseId, date: DAY, from: '10:00', to: '10:00', reason: 'Entretien' }, actor);
    await recordStaffPayment(db, b.booking.id, { amountMinor: 100_000, method: 'cash' }, actor);
    await recordStaffRefund(db, b.booking.id, { amountMinor: 20_000, method: 'cash', reason: 'Geste commercial' }, actor);

    const cfg = { clubIds: [f.clubId], from: DAY, to: DAY, compare: 'none' as const,
      blocks: ['kpis', 'occupancy', 'amounts', 'cancellations', 'equipment', 'caddieStaff'] as any };
    const r = await computeAnalytics(db, cfg, NOW);
    const o = r.data.occupancy;
    expect(o.gridSeats).toBe(40); // 07:00 → 16:00, un départ par heure, 4 places
    expect(o).toMatchObject({ closedSeats: 4, closedTeeTimes: 1, openSeats: 36, players: 5, exclusiveTeeTimes: 1, exclusivePlayers: 2, exclusiveNeutralizedSeats: 2 });
    expect(o.occupancyRate).toBeCloseTo(5 / 36);
    expect(o.soldRate).toBeCloseTo(7 / 36);
    expect(r.data.kpis.current).toMatchObject({ bookings: 2, players: 5, teeTimes: 2, cancellations: 1 });

    const totals = (await db.query('SELECT sum(total_minor)::int AS t FROM bookings WHERE id = ANY($1)', [[exclusive.booking.id, b.booking.id]])).rows[0].t;
    expect(r.data.amounts).toEqual([{ currency: 'MAD', bookedMinor: totals, cancellationFeesMinor: 0, paidMinor: 100_000, refundedMinor: 20_000,
      netMinor: 80_000, receivableMinor: totals - 80_000, refundDueMinor: 0 }]);

    // Départs pas encore joués : absences non disponibles (pas un faux zéro).
    expect(r.data.cancellations).toMatchObject({ cancellations: 1, noShows: null });
    expect(r.notes.cancellations?.[0]).toMatch(/Données non disponibles/i);
    // Matériel : 1 voiturette réservée, pic 1 sur 5.
    expect(r.data.equipment.find((e: any) => e.name === 'Voiturette')).toMatchObject({ quantity: 1, bookings: 1, peak: 1, capacity: 5, assignedUnits: 0 });
    // Aucun caddie nommé : répartition non disponible, avec explication.
    expect(r.data.caddieStaff).toMatchObject({ teeTimes: 2, withCaddie: 2, named: 0, perCaddie: null });
    expect(r.notes.caddieStaff?.[0]).toMatch(/aucun caddie n'a été nommé/);

    // Après les départs : absence pointée, caddie nommé.
    const ali = await caddie(f, 'Ali');
    await assignCaddie(db, b.booking.teeTime.id, ali, actor);
    await setCheckin(db, exclusive.booking.id, 'no_show', actor);
    await setCheckin(db, b.booking.id, 'arrived', actor);
    const after = await computeAnalytics(db, cfg, new Date('2030-06-11T12:00:00Z'));
    expect(after.data.cancellations).toMatchObject({ noShows: 1, noShowPlayers: 2, pastBookings: 2 });
    expect(after.data.cancellations.noShowRate).toBeCloseTo(0.5);
    expect(after.data.caddieStaff.perCaddie).toEqual([expect.objectContaining({ name: 'Ali', teeTimes: 1, days: 1 })]);

    const csv = analyticsCsv(after);
    expect(csv).toContain('Occupation et départs exclusifs');
    expect(csv).toContain('Calcul :');
  });

  it('ne mélange jamais deux devises', async () => {
    const a = await createClub(db);
    const b = await createClub(db, { organizationId: a.organizationId });
    await db.query(`UPDATE clubs SET currency = 'EUR' WHERE id = $1`, [b.clubId]);
    await createBooking(d, staff, { courseId: a.courseId, startsAt: at('08:00'), players: 2, holes: 18 });
    await createBooking(d, staff, { courseId: b.courseId, startsAt: at('08:00'), players: 2, holes: 18 });
    const r = await computeAnalytics(db, { clubIds: [a.clubId, b.clubId], from: DAY, to: DAY, blocks: ['kpis', 'amounts', 'revenue', 'channels', 'clubs'] }, NOW);
    expect(r.currency).toBeNull();
    expect(r.data.amounts.map((x: any) => x.currency)).toEqual(['EUR', 'MAD']);
    expect(r.data.kpis.current).toMatchObject({ players: 4, revenueMinor: null });
    expect(r.unavailable.revenue).toMatch(/devises différentes/);
    expect(r.data.channels[0].revenueMinor).toBeNull();
    expect(r.data.clubs.map((c: any) => c.currency)).toEqual(['MAD', 'EUR']);
  });

  it('restrictions d’accès : rapports et historique global', async () => {
    const a = await createClub(db);
    const b = await createClub(db, { organizationId: a.organizationId });
    const app = buildServer({ db, now: () => NOW });
    const token = async (role: Role, f: Fixture = a) => {
      const email = `${role}.${Date.now()}.${Math.random()}@t.ma`;
      await createStaffUser(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', displayName: role,
        roles: [{ clubId: role === 'org_admin' ? null : f.clubId, role }] });
      return (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token;
    };
    const call = (method: 'GET' | 'POST', url: string, t: string, payload?: object) =>
      app.inject({ method, url, payload, headers: { authorization: `Bearer ${t}` } });
    const cfg = (clubIds: string[]) => ({ clubIds, from: DAY, to: DAY, blocks: ['kpis'] });
    const rec = await token('receptionist');
    const admin = await token('club_admin');
    const group = await token('org_admin');
    await createBooking(d, staff, { courseId: b.courseId, startsAt: at('08:00'), players: 2, holes: 18 });

    expect((await call('POST', '/api/analytics', rec, cfg([a.clubId]))).statusCode).toBe(403);
    expect((await call('POST', '/api/analytics', admin, cfg([a.clubId]))).statusCode).toBe(200);
    expect((await call('POST', '/api/analytics', admin, cfg([a.clubId, b.clubId]))).statusCode).toBe(403);
    expect((await call('POST', '/api/analytics', group, cfg([a.clubId, b.clubId]))).json().report.data.kpis.current.players).toBe(2);
    expect((await call('GET', `/api/analytics.csv?config=${encodeURIComponent(JSON.stringify(cfg([b.clubId])))}`, admin)).statusCode).toBe(403);

    expect((await call('GET', '/api/history', rec)).statusCode).toBe(403);
    const own = (await call('GET', '/api/history', admin)).json();
    expect(own.events.every((e: any) => e.clubId === a.clubId)).toBe(true);
    expect((await call('GET', `/api/history?clubId=${b.clubId}`, admin)).statusCode).toBe(403);
    expect((await call('GET', `/api/history?clubId=${b.clubId}`, group)).json().events[0]).toMatchObject({ action: 'booking.created' });
    // Ressources : tout le personnel consulte ; seul le gestionnaire déclare une maintenance.
    expect((await call('GET', `/api/clubs/${a.clubId}/resources?date=${DAY}`, rec)).statusCode).toBe(200);
    const [unit] = Object.values(await units(a, 'CART', ['V-99']));
    const body = { unitId: unit, startsAt: at('07:00').toISOString(), endsAt: null, reason: 'Batterie' };
    expect((await call('POST', `/api/clubs/${a.clubId}/unavailabilities`, rec, body)).statusCode).toBe(403);
    expect((await call('POST', `/api/clubs/${a.clubId}/unavailabilities`, admin, body)).statusCode).toBe(201);
  });
});

describe('historique des modifications', () => {
  it('enregistre les changements avec ancienne et nouvelle valeur, motif et auteur', async () => {
    const f = await createClub(db);
    const sarah = await user(f, 'Sarah');
    const b = await createBooking(d, { ...staff, actor: sarah }, { courseId: f.courseId, startsAt: at('10:00'), players: 2, holes: 18 });
    await updateBooking(d, b.booking.id, { players: 3 }, { actor: sarah });
    await updateBooking(d, b.booking.id, { notes: 'Client VIP' }, { actor: sarah });
    await updateBooking(d, b.booking.id, { players: 3 }, { actor: sarah }); // rien ne change : pas de ligne
    await recordStaffPayment(db, b.booking.id, { amountMinor: 50_000, method: 'card_terminal', note: 'Acompte' }, sarah);

    const h = await bookingHistory(db, b.booking.id);
    expect(h.map((e) => e.action)).toEqual(['booking.created', 'booking.updated', 'booking.updated', 'payment.recorded']);
    expect(h[1]!.text).toMatch(new RegExp(`^Sarah a modifié la réservation ${b.booking.reference} : joueurs 2 → 3, prix .* MAD → .* MAD$`));
    expect(h[1]!.details).toEqual(expect.arrayContaining([
      { label: 'Joueurs', from: '2', to: '3' },
      expect.objectContaining({ label: 'Prix' }),
    ]));
    // Le contenu des notes (donnée personnelle possible) n'est pas copié.
    expect(h[2]!.details).toEqual([{ label: 'Notes', from: '…', to: 'modifiées' }]);
    expect(JSON.stringify(h)).not.toContain('Client VIP');
    expect(h[3]).toMatchObject({ reason: 'Acompte', text: `Sarah a encaissé 500 MAD (carte (TPE)) pour ${b.booking.reference}` });
    expect(h[0]!.text).toMatch(/^Sarah a créé la réservation .* pour le 10\/06\/2030 à 10 h \(2 joueurs, 18 trous\)$/);

    // Vue globale filtrable.
    const payments = await searchHistory(db, { clubIds: [f.clubId], category: 'payments' });
    expect(payments.events.map((e) => e.action)).toEqual(['payment.recorded']);
    const bySarah = await searchHistory(db, { clubIds: [f.clubId], actorId: sarah.id, reference: b.booking.reference.toLowerCase() });
    expect(bySarah.events).toHaveLength(4);
    const page = await searchHistory(db, { clubIds: [f.clubId], limit: 2 });
    expect(page.events).toHaveLength(2);
    expect((await searchHistory(db, { clubIds: [f.clubId], before: page.next })).events.length).toBeGreaterThan(0);
    expect((await searchHistory(db, { clubIds: [f.clubId], from: '2000-01-01', to: '2000-01-02' })).events).toEqual([]);
  });

  it('est non modifiable, même directement en base', async () => {
    const f = await createClub(db);
    const b = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('10:00'), players: 2, holes: 18 });
    await expect(db.query(`UPDATE audit_log SET action = 'x' WHERE entity_id = $1`, [b.booking.id])).rejects.toThrow(/lecture seule/);
    await expect(db.query(`DELETE FROM audit_log WHERE entity_id = $1`, [b.booking.id])).rejects.toThrow(/lecture seule/);
    expect((await bookingHistory(db, b.booking.id))[0]).toMatchObject({ action: 'booking.created', actor: { name: 'Système' } });
  });
});
