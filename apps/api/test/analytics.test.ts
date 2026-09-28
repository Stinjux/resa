import { describe, expect, it } from 'vitest';
import { LogEmailSender, type EmailMessage, type EmailSender } from '../src/integrations/email/sender.js';
import { buildServer } from '../src/http/server.js';
import { createStaffUser } from '../src/modules/auth/service.js';
import { comparisonPeriod, computeAnalytics, analyticsCsv } from '../src/modules/analytics/service.js';
import { nextRun, processDueSchedules, resolvePeriod } from '../src/modules/analytics/schedules.js';
import { createBooking, cancelBooking } from '../src/modules/booking/service.js';
import { recordStaffPayment } from '../src/modules/orders/service.js';
import { savePartner } from '../src/modules/partners/service.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb } from './helpers.js';

const db = useTestDb();
const d = deps(db);
const actor = { type: 'system' as const };

describe('rapports modulables', () => {
  it('indicateurs à la carte, filtres, plusieurs golfs, comparaison, CSV', async () => {
    const a = await createClub(db);
    const b = await createClub(db, { organizationId: a.organizationId });
    const partner = await savePartner(db, a.organizationId, null, { code: `P${Date.now()}`, name: 'Atlas' }, actor);
    const b1 = await createBooking(d, staff, { courseId: a.courseId, startsAt: at('08:00'), players: 2, holes: 18 });
    await createBooking(d, { ...staff, channel: 'walk_in' }, { courseId: a.courseId, startsAt: at('15:00'), players: 3, holes: 18 });
    await createBooking(d, { ...staff, partnerId: partner.id }, { courseId: b.courseId, startsAt: at('09:00'), players: 4, holes: 18 });
    const c = await createBooking(d, staff, { courseId: a.courseId, startsAt: at('10:00'), players: 1, holes: 18 });
    await cancelBooking(d, c.booking.id, { actor });
    await recordStaffPayment(db, b1.booking.id, { amountMinor: 100_000, method: 'cash' }, actor);

    const base = { clubIds: [a.clubId, b.clubId], from: DAY, to: DAY, compare: 'previous' as const,
      blocks: ['kpis', 'clubs', 'channels', 'partners', 'hours', 'payments', 'weekdays'] as any };
    const r = await computeAnalytics(db, base);
    expect(r.blocks).toEqual(base.blocks);
    expect(r.data.kpis.current).toMatchObject({ bookings: 3, players: 9, cancellations: 1, collectedMinor: 100_000 });
    expect(r.data.kpis.current.capacity).toBeGreaterThan(0);
    expect(r.data.kpis.previous).toMatchObject({ bookings: 0, from: '2030-06-09', to: '2030-06-09' });
    expect(r.data.clubs.map((x: any) => x.players)).toEqual([5, 4]);
    expect(r.data.channels.find((x: any) => x.key === 'walk_in')).toMatchObject({ bookings: 1, players: 3 });
    expect(r.data.partners).toEqual([expect.objectContaining({ name: 'Atlas', players: 4 })]);
    expect(r.data.hours.map((h: any) => h.hour)).toEqual([8, 9, 15]);
    expect(r.data.payments.byMethod).toEqual([{ method: 'cash', paidMinor: 100_000, refundedMinor: 0 }]);
    expect(r.data.weekdays[0]).toMatchObject({ weekday: 1, players: 9 }); // 10/06/2030 = lundi

    // Filtres : un golf, un canal, un partenaire.
    const walkIn = await computeAnalytics(db, { ...base, clubIds: [a.clubId], channels: ['walk_in'], blocks: ['kpis'] });
    expect(walkIn.data.kpis.current.players).toBe(3);
    const byPartner = await computeAnalytics(db, { ...base, partnerId: partner.id, blocks: ['kpis'] });
    expect(byPartner.data.kpis.current.players).toBe(4);

    const csv = analyticsCsv(r);
    expect(csv).toContain('Chiffres clés');
    expect(csv).toContain('Atlas');
    await expect(computeAnalytics(db, { ...base, from: '2030-01-01', to: '2031-06-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('périodes et calendrier des envois', () => {
    expect(comparisonPeriod('2030-06-01', '2030-06-30', 'previous')).toEqual({ from: '2030-05-02', to: '2030-05-31' });
    expect(comparisonPeriod('2030-06-01', '2030-06-30', 'last_year')).toEqual({ from: '2029-06-01', to: '2029-06-30' });
    const wed = new Date('2030-06-12T10:00:00Z');
    expect(resolvePeriod('previous_week', wed)).toEqual({ from: '2030-06-03', to: '2030-06-09' });
    expect(resolvePeriod('previous_month', wed)).toEqual({ from: '2030-05-01', to: '2030-05-31' });
    expect(nextRun('weekly', wed).toISOString()).toBe('2030-06-17T06:00:00.000Z'); // lundi 7 h (UTC+1)
    expect(nextRun('monthly', wed).toISOString()).toBe('2030-07-01T06:00:00.000Z');
  });

  it('envoi programmé : droits, envoi avec pièce jointe, compte désactivé', async () => {
    const f = await createClub(db);
    const other = await createClub(db);
    const app = buildServer({ db, now: () => NOW, emailSender: new LogEmailSender() });
    const email = `dir.${Date.now()}@test.ma`;
    const userId = await createStaffUser(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', displayName: 'Dir', roles: [{ clubId: f.clubId, role: 'club_admin' }] });
    const h = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token}` };
    const config = { clubIds: [f.clubId], period: 'previous_week', blocks: ['kpis', 'channels'] };
    expect((await app.inject({ method: 'POST', url: '/api/report-schedules', headers: h,
      payload: { name: 'Hebdo', frequency: 'weekly', recipients: ['compta@test.ma'], config: { ...config, clubIds: [other.clubId] } } })).statusCode).toBe(403);
    const s = await app.inject({ method: 'POST', url: '/api/report-schedules', headers: h,
      payload: { name: 'Bilan hebdo', frequency: 'weekly', recipients: ['compta@test.ma', 'direction@test.ma'], config } });
    expect(s.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/report-schedules/${s.json().schedule.id}/send`, headers: h })).json()).toEqual({ status: 'logged' });

    // Échéance atteinte : envoi réel (faux SMTP) avec CSV joint.
    const sent: EmailMessage[] = [];
    const smtp: EmailSender = { mode: 'smtp', send: async (m) => { sent.push(m); return { id: 'x' }; } };
    await db.query(`UPDATE report_schedules SET next_run_at = $2 WHERE id = $1`, [s.json().schedule.id, NOW]);
    expect(await processDueSchedules(db, smtp, NOW)).toBeGreaterThanOrEqual(1);
    const m = sent.find((x) => x.subject.startsWith('Bilan hebdo'))!;
    expect(m.to).toBe('compta@test.ma, direction@test.ma');
    expect(m.attachments?.[0]?.filename).toMatch(/\.csv$/);
    expect(m.html).toContain('Chiffres clés');

    // Créateur désactivé : plus d'envoi.
    await db.query(`UPDATE users SET active = false WHERE id = $1`, [userId]);
    await db.query(`UPDATE report_schedules SET next_run_at = $2 WHERE id = $1`, [s.json().schedule.id, NOW]);
    sent.length = 0;
    await processDueSchedules(db, smtp, NOW);
    expect(sent.find((x) => x.subject.startsWith('Bilan hebdo'))).toBeUndefined();
    const { rows } = await db.query(`SELECT last_status FROM report_schedules WHERE id = $1`, [s.json().schedule.id]);
    expect(rows[0].last_status).toBe('failed');
    await app.close();
  });

  it('préférences : barre de menu et blocs enregistrés sur le compte', async () => {
    const f = await createClub(db);
    const app = buildServer({ db, now: () => NOW });
    const email = `pref.${Date.now()}@test.ma`;
    await createStaffUser(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', displayName: 'R', roles: [{ clubId: f.clubId, role: 'receptionist' }] });
    const h = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token}` };
    await app.inject({ method: 'PUT', url: '/api/me/preferences', headers: h, payload: { navPinned: ['sheet', 'cash'] } });
    await app.inject({ method: 'PUT', url: '/api/me/preferences', headers: h, payload: { reportBlocks: ['kpis'] } });
    expect((await app.inject({ method: 'GET', url: '/api/me/preferences', headers: h })).json().preferences).toEqual({ navPinned: ['sheet', 'cash'], reportBlocks: ['kpis'] });
    expect((await app.inject({ method: 'PUT', url: '/api/me/preferences', headers: h, payload: { autre: 1 } })).statusCode).toBe(422);
    await app.close();
  });
});
