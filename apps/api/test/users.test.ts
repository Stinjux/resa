import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { createStaffUser } from '../src/modules/auth/service.js';
import type { Role } from '../src/modules/auth/permissions.js';
import { createClub, NOW, useTestDb } from './helpers.js';

const db = useTestDb();
const PW = 'motdepasse-test';

async function world() {
  const a = await createClub(db);
  const b = await createClub(db, { organizationId: a.organizationId });
  const app = buildServer({ db, now: () => NOW });
  const login = async (email: string, password = PW) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const auth = async (email: string, password = PW) => ({ authorization: `Bearer ${(await login(email, password)).json().token}` });
  const make = async (roles: Array<{ clubId: string | null; role: Role }>) => {
    const email = `u.${Date.now()}.${Math.random()}@test.ma`;
    const id = await createStaffUser(db, { organizationId: a.organizationId, email, password: PW, displayName: 'X', roles });
    return { id, email, h: await auth(email) };
  };
  return { a, b, app, login, auth, make };
}

describe('comptes du personnel', () => {
  it('création avec mot de passe provisoire à changer, puis connexion normale', async () => {
    const { a, app, login, auth, make } = await world();
    const dir = await make([{ clubId: a.clubId, role: 'club_admin' }]);
    const email = `nouveau.${Date.now()}@test.ma`;
    const r = await app.inject({ method: 'POST', url: '/api/staff-users', headers: dir.h,
      payload: { email, displayName: 'Nouvelle réceptionniste', roles: [{ clubId: a.clubId, role: 'receptionist' }] } });
    expect(r.statusCode).toBe(201);
    const temp = r.json().temporaryPassword;
    expect(temp).toHaveLength(12);

    const h = await auth(email, temp);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: h })).json().user.mustChangePassword).toBe(true);
    const blocked = await app.inject({ method: 'GET', url: `/api/courses/${a.courseId}/tee-sheet?date=2030-06-10`, headers: h });
    expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await app.inject({ method: 'POST', url: '/api/me/password', headers: h, payload: { current: 'faux-mot-de-passe', next: 'nouveau-mdp-solide' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/me/password', headers: h, payload: { current: temp, next: 'court' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/api/me/password', headers: h, payload: { current: temp, next: 'nouveau-mdp-solide' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/courses/${a.courseId}/tee-sheet?date=2030-06-10`, headers: h })).statusCode).toBe(200);
    expect((await login(email, temp)).statusCode).toBe(401);
    expect((await login(email, 'nouveau-mdp-solide')).statusCode).toBe(200);
    await app.close();
  });

  it('la direction ne gère que ses golfs ; l’administrateur du groupe gère tout', async () => {
    const { a, b, app, make } = await world();
    const dirA = await make([{ clubId: a.clubId, role: 'club_admin' }]);
    const admin = await make([{ clubId: null, role: 'org_admin' }]);
    const recA = await make([{ clubId: a.clubId, role: 'receptionist' }]);
    const both = await make([{ clubId: a.clubId, role: 'receptionist' }, { clubId: b.clubId, role: 'receptionist' }]);
    const recB = await make([{ clubId: b.clubId, role: 'receptionist' }]);

    const list = (await app.inject({ method: 'GET', url: '/api/staff-users', headers: dirA.h })).json().users;
    const ids = list.map((u: { id: string }) => u.id);
    expect(ids).toContain(recA.id);
    expect(ids).not.toContain(recB.id);
    expect(list.find((u: { id: string }) => u.id === both.id).editable).toBe(false);

    const post = (h: object, roles: unknown) => app.inject({ method: 'POST', url: '/api/staff-users', headers: h as never,
      payload: { email: `x.${Math.random()}@test.ma`, displayName: 'X', roles } });
    expect((await post(dirA.h, [{ clubId: b.clubId, role: 'receptionist' }])).statusCode).toBe(403);
    expect((await post(dirA.h, [{ clubId: null, role: 'org_admin' }])).statusCode).toBe(403);
    expect((await post(dirA.h, [{ clubId: a.clubId, role: 'org_admin' }])).statusCode).toBe(422);
    expect((await post(recA.h, [{ clubId: a.clubId, role: 'starter' }])).statusCode).toBe(403);
    expect((await post(admin.h, [{ clubId: b.clubId, role: 'club_admin' }])).statusCode).toBe(201);

    expect((await app.inject({ method: 'PATCH', url: `/api/staff-users/${both.id}`, headers: dirA.h, payload: { active: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/staff-users/${recB.id}`, headers: dirA.h, payload: { active: false } })).statusCode).toBe(403);
    // Pas d'auto-blocage.
    expect((await app.inject({ method: 'PATCH', url: `/api/staff-users/${dirA.id}`, headers: dirA.h, payload: { active: false } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: `/api/staff-users/${dirA.id}`, headers: dirA.h,
      payload: { roles: [{ clubId: a.clubId, role: 'receptionist' }] } })).statusCode).toBe(422);

    // Changement de rôle et désactivation : effet immédiat (sessions fermées).
    expect((await app.inject({ method: 'PATCH', url: `/api/staff-users/${recA.id}`, headers: dirA.h,
      payload: { roles: [{ clubId: a.clubId, role: 'starter' }] } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: recA.h })).json().user.roles).toEqual([{ clubId: a.clubId, role: 'starter' }]);
    expect((await app.inject({ method: 'PATCH', url: `/api/staff-users/${recA.id}`, headers: dirA.h, payload: { active: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: recA.h })).statusCode).toBe(401);
    await app.close();
  });

  it('réinitialisation du mot de passe : sessions fermées, nouveau mot de passe provisoire', async () => {
    const { a, app, login, make } = await world();
    const dir = await make([{ clubId: a.clubId, role: 'club_admin' }]);
    const rec = await make([{ clubId: a.clubId, role: 'receptionist' }]);
    const r = await app.inject({ method: 'POST', url: `/api/staff-users/${rec.id}/reset-password`, headers: dir.h });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: rec.h })).statusCode).toBe(401);
    expect((await login(rec.email)).statusCode).toBe(401);
    const s = await login(rec.email, r.json().temporaryPassword);
    expect(s.json().user.mustChangePassword).toBe(true);
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [rec.id]);
    expect(audit.rows.map((x) => x.action)).toContain('user.password_reset');
    await app.close();
  });
});
