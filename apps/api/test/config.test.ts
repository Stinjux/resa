import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { createStaffUser } from '../src/modules/auth/service.js';
import type { Role } from '../src/modules/auth/permissions.js';
import { createBooking } from '../src/modules/booking/service.js';
import { at, createClub, deps, DAY, NOW, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const app = buildServer({ db, now: () => NOW });
let n = 0;

async function token(f: Fixture, role: Role): Promise<string> {
  const email = `cfg.${role}.${++n}.${Date.now()}@test.ma`;
  await createStaffUser(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', displayName: role,
    roles: [{ clubId: role === 'org_admin' ? null : f.clubId, role }] });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } });
  return res.json().token;
}
function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, tok: string, payload?: object) {
  return app.inject({ method, url, payload, headers: { authorization: `Bearer ${tok}` } });
}

describe('configuration par golf', () => {
  it('réservée à la direction du golf', async () => {
    const a = await createClub(db);
    const b = await createClub(db, { organizationId: a.organizationId });
    const dirA = await token(a, 'club_admin');
    expect((await call('GET', `/api/clubs/${a.clubId}/config`, dirA)).statusCode).toBe(200);
    expect((await call('GET', `/api/clubs/${b.clubId}/config`, dirA)).statusCode).toBe(403);
    expect((await call('GET', `/api/clubs/${a.clubId}/config`, await token(a, 'receptionist'))).statusCode).toBe(403);
    expect((await call('GET', `/api/clubs/${b.clubId}/config`, await token(a, 'org_admin'))).statusCode).toBe(200);
  });

  it('modifie un tarif et le prix suivant en tient compte ; historisé', async () => {
    const f = await createClub(db);
    const dir = await token(f, 'club_admin');
    const cfg = (await call('GET', `/api/clubs/${f.clubId}/config`, dir)).json();
    const gf18 = cfg.tariffs.find((t: any) => t.product === 'green_fee' && t.holes === 18);
    expect((await call('PATCH', `/api/clubs/${f.clubId}/config/tariffs/${gf18.id}`, dir, { amountMinor: 140000 })).statusCode).toBe(200);
    const b = await createBooking(deps(db), staff, { courseId: f.courseId, startsAt: at('08:00'), players: 1, holes: 18 });
    expect(b.booking.pricing.lines[0]!.unitAmountMinor).toBe(140000);
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_id = $1`, [gf18.id]);
    expect(audit.rows.map((r) => r.action)).toContain('config.tariffs.updated');
  });

  it('une fermeture ajoutée retire les créneaux de la grille', async () => {
    const f = await createClub(db);
    const dir = await token(f, 'club_admin');
    const preview = async () => (await call('GET', `/api/clubs/${f.clubId}/config/grid-preview?courseId=${f.courseId}&date=${DAY}`, dir)).json().slots;
    expect((await preview()).length).toBe(100);
    const res = await call('POST', `/api/clubs/${f.clubId}/config/schedule-rules`, dir, {
      name: 'Entretien', kind: 'closed', validFrom: DAY, validTo: DAY, startTime: '07:00', endTime: '09:00', priority: 10,
    });
    expect(res.statusCode).toBe(201);
    const slots = await preview();
    expect(slots.length).toBe(80);
    expect(slots[0].localTime).toBe('09:00');
  });

  it('refuse les valeurs invalides et les éléments d’un autre golf', async () => {
    const a = await createClub(db);
    const b = await createClub(db, { organizationId: a.organizationId });
    const dirA = await token(a, 'club_admin');
    const bad = await call('POST', `/api/clubs/${a.clubId}/config/schedule-rules`, dirA, { name: 'X', kind: 'open', startTime: '17:00', endTime: '07:00' });
    expect(bad.statusCode).toBe(422);
    expect((await call('PATCH', `/api/clubs/${a.clubId}/config`, dirA, { timezone: 'Mars/Olympus' })).statusCode).toBe(422);
    expect((await call('PATCH', `/api/clubs/${a.clubId}/config/courses/${b.courseId}`, dirA, { name: 'Piraté' })).statusCode).toBe(404);
    expect((await call('PATCH', `/api/clubs/${a.clubId}/config/resource-types/${a.rt.CART}`, dirA, { kind: 'other' })).statusCode).toBe(422);
    expect((await call('POST', `/api/clubs/${a.clubId}/config/resource-types`, dirA, { code: 'CADDIE2', kind: 'caddie', name: 'X', totalQuantity: 1 })).statusCode).toBe(422);
  });

  it('exception de stock pour une journée et nouvelle unité de matériel', async () => {
    const f = await createClub(db, { carts: 3 });
    const dir = await token(f, 'club_admin');
    expect((await call('PUT', `/api/clubs/${f.clubId}/config/resource-types/${f.rt.CART}/overrides/${DAY}`, dir, { quantity: 0, reason: 'Révision' })).statusCode).toBe(200);
    await expect(createBooking(deps(db), staff, { courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18, options: [{ code: 'CART', quantity: 1 }] }))
      .rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    const unit = await call('POST', `/api/clubs/${f.clubId}/config/resource-units`, dir, { resourceTypeId: f.rt.CART, label: 'V-99' });
    expect(unit.statusCode).toBe(201);
    expect((await call('POST', `/api/clubs/${f.clubId}/config/resource-units`, dir, { resourceTypeId: f.rt.CART, label: 'V-99' })).statusCode).toBe(422);
  });
});

describe('nouveau golf', () => {
  it('seul l’administrateur du groupe peut créer un golf ; aucun tarif n’est inventé', async () => {
    const a = await createClub(db);
    const admin = await token(a, 'org_admin');
    const dir = await token(a, 'club_admin');
    const payload = { code: `NEW${n}${Date.now() % 100000}`, name: 'Golf de Lisbonne', timezone: 'Europe/Lisbon', currency: 'EUR', defaultLocale: 'en', countryCode: 'PT', taxRateBp: 2300 };
    expect((await call('POST', '/api/clubs', dir, payload)).statusCode).toBe(403);
    const res = await call('POST', '/api/clubs', admin, payload);
    expect(res.statusCode).toBe(201);
    const cfg = (await call('GET', `/api/clubs/${res.json().id}/config`, admin)).json();
    expect(cfg.club).toMatchObject({ timezone: 'Europe/Lisbon', currency: 'EUR', taxRateBp: 2300 });
    expect(cfg.courses).toHaveLength(1);
    expect(cfg.tariffs).toHaveLength(0);
    expect(cfg.resourceTypes.map((r: any) => r.kind)).toEqual(['caddie']);
    expect((await call('POST', '/api/clubs', admin, payload)).statusCode).toBe(422); // code déjà pris
  });
});
