import { describe, expect, it } from 'vitest';
import type { EmailSender } from '../src/integrations/email/sender.js';
import { LogEmailSender } from '../src/integrations/email/sender.js';
import { buildServer } from '../src/http/server.js';
import { createStaffUser } from '../src/modules/auth/service.js';
import { cancelBooking, createBooking, createGroupBooking, moveBooking, updateBooking } from '../src/modules/booking/service.js';
import { processEmailQueue, scheduleReminders } from '../src/modules/notifications/service.js';
import { NOW, at, createClub, deps, staff, useTestDb } from './helpers.js';

const db = useTestDb();
const d = deps(db);
const actor = { type: 'system' as const };
const outbox = async (bookingId: string) =>
  (await db.query('SELECT kind, status, subject, body_text AS text, body_html AS html, locale, attempts FROM email_outbox WHERE booking_id = $1 ORDER BY created_at', [bookingId])).rows;
const withEmail = (email: string, extra: Record<string, unknown> = {}) =>
  ({ ...staff, customer: { firstName: 'Salma', lastName: 'Idrissi', email, ...extra } });

describe('e-mails clients', () => {
  it('confirmation, modification et annulation ; rien sans adresse', async () => {
    const f = await createClub(db);
    const b = await createBooking(d, withEmail('salma@test.ma'), { courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18 });
    let mails = await outbox(b.booking.id);
    expect(mails.map((m) => m.kind)).toEqual(['confirmation']);
    expect(mails[0].text).toContain('Bonjour Salma Idrissi');
    expect(mails[0].text).toContain(b.booking.reference);
    expect(mails[0].text).toMatch(/Total TTC : 2[\s ]?800/); // 2 × 1 300 + caddie 200

    await moveBooking(d, b.booking.id, { courseId: f.courseId, startsAt: at('09:00') }, { actor });
    await updateBooking(d, b.booking.id, { players: 3 }, { actor });
    await updateBooking(d, b.booking.id, { notes: 'interne' }, { actor }); // note interne : pas d'e-mail
    await cancelBooking(d, b.booking.id, { actor });
    await cancelBooking(d, b.booking.id, { actor }); // idempotent
    mails = await outbox(b.booking.id);
    expect(mails.map((m) => m.kind)).toEqual(['confirmation', 'modification', 'modification', 'cancellation']);
    expect(mails[1].text).toContain('09:00');

    const anon = await createBooking(d, { ...staff, customer: { lastName: 'Sans mail', phone: '+212600000001' } },
      { courseId: f.courseId, startsAt: at('10:00'), players: 1, holes: 18 });
    expect(await outbox(anon.booking.id)).toEqual([]);

    await db.query('UPDATE clubs SET email_enabled = false WHERE id = $1', [f.clubId]);
    const off = await createBooking(d, withEmail('x@test.ma'), { courseId: f.courseId, startsAt: at('11:00'), players: 1, holes: 18 });
    expect(await outbox(off.booking.id)).toEqual([]);
  });

  it('langue du client et échappement HTML', async () => {
    const f = await createClub(db);
    const ar = await createBooking(d, withEmail('ar@test.ma', { preferredLocale: 'ar' }), { courseId: f.courseId, startsAt: at('08:00'), players: 1, holes: 9 });
    const [m] = await outbox(ar.booking.id);
    expect(m.locale).toBe('ar');
    expect(m.html).toContain('dir="rtl"');
    expect(m.text).toContain('تم تأكيد حجزك');

    const en = await createBooking(d, withEmail('en@test.ma', { preferredLocale: 'en', lastName: '<script>alert(1)</script>' }),
      { courseId: f.courseId, startsAt: at('09:00'), players: 1, holes: 18 });
    const [e] = await outbox(en.booking.id);
    expect(e.subject).toMatch(/^Booking confirmation/);
    expect(e.html).not.toContain('<script>');
    expect(e.html).toContain('&lt;script&gt;');
  });

  it('groupe : un seul récapitulatif avec tous les départs et le total', async () => {
    const f = await createClub(db);
    const g = await createGroupBooking(d, withEmail('groupe@test.ma'), [
      { courseId: f.courseId, startsAt: at('08:00'), players: 4, holes: 18 },
      { courseId: f.courseId, startsAt: at('08:06'), players: 4, holes: 18 },
    ]);
    const all = (await db.query('SELECT booking_id, body_text AS text FROM email_outbox WHERE booking_id = ANY($1)', [g.bookings.map((b) => b.id)])).rows;
    expect(all).toHaveLength(1);
    for (const b of g.bookings) expect(all[0].text).toContain(b.reference);
    expect(all[0].text).toMatch(/Total TTC : 10[\s ]?800/); // 2 × (4 × 1 300 + 200)
  });

  it('rappel : une seule fois, pas pour une réservation de dernière minute', async () => {
    const f = await createClub(db);
    const early = await createBooking(d, withEmail('tot@test.ma'), { courseId: f.courseId, startsAt: at('08:00'), players: 1, holes: 18 });
    // Réservation créée 2 h avant le départ : pas de rappel.
    const late = await createBooking(d, withEmail('tard@test.ma'), { courseId: f.courseId, startsAt: at('08:06'), players: 1, holes: 18 });
    await db.query(`UPDATE bookings SET created_at = $2 WHERE id = $1`, [late.booking.id, new Date(at('08:06').getTime() - 2 * 3600_000)]);
    await db.query(`UPDATE bookings SET created_at = $2 WHERE id = $1`, [early.booking.id, NOW]);

    const dayBefore = new Date(at('08:00').getTime() - 20 * 3600_000);
    expect(await scheduleReminders(db, new Date(at('08:00').getTime() - 30 * 3600_000))).toBe(0); // trop tôt
    await scheduleReminders(db, dayBefore);
    await scheduleReminders(db, dayBefore);
    expect((await outbox(early.booking.id)).filter((m) => m.kind === 'reminder')).toHaveLength(1);
    expect((await outbox(late.booking.id)).filter((m) => m.kind === 'reminder')).toHaveLength(0);
  });

  it('file d’envoi : mode journal, reprises puis échec définitif', async () => {
    const f = await createClub(db);
    const b = await createBooking(d, withEmail('file@test.ma'), { courseId: f.courseId, startsAt: at('08:00'), players: 1, holes: 18 });
    const failing: EmailSender = { mode: 'smtp', send: async () => { throw new Error('SMTP indisponible'); } };
    let t = NOW;
    for (let i = 0; i < 5; i++) {
      await processEmailQueue(db, failing, t);
      t = new Date(t.getTime() + 24 * 3600_000);
    }
    let [m] = await outbox(b.booking.id);
    expect(m).toMatchObject({ status: 'failed', attempts: 5 });

    // Renvoi depuis l'interface (configuration) : repart en file, puis journalisé.
    const app = buildServer({ db, now: () => NOW, emailSender: new LogEmailSender() });
    const email = `mails.${Date.now()}@test.ma`;
    await createStaffUser(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', displayName: 'Dir', roles: [{ clubId: f.clubId, role: 'club_admin' }] });
    const token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token;
    const headers = { authorization: `Bearer ${token}` };
    const list = (await app.inject({ method: 'GET', url: `/api/clubs/${f.clubId}/emails`, headers })).json();
    expect(list.mode).toBe('log');
    const id = list.emails.find((e: { reference: string }) => e.reference === b.booking.reference).id;
    expect((await app.inject({ method: 'POST', url: `/api/clubs/${f.clubId}/emails/${id}/resend`, headers })).statusCode).toBe(200);
    [m] = await outbox(b.booking.id);
    expect(m.status).toBe('logged');

    const other = await createClub(db);
    expect((await app.inject({ method: 'GET', url: `/api/clubs/${other.clubId}/emails`, headers })).statusCode).toBe(403);
    await app.close();
  });
});
