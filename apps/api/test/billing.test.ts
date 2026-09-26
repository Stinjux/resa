import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { createStaffUser, registerCustomer } from '../src/modules/auth/service.js';
import type { Role } from '../src/modules/auth/permissions.js';
import { closeCash, currentCash, getInvoice, issueCreditNote, issueInvoice } from '../src/modules/billing/service.js';
import { createBooking, updateBooking } from '../src/modules/booking/service.js';
import { recordStaffPayment, recordStaffRefund } from '../src/modules/orders/service.js';
import { NOW, at, createClub, deps, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const d = deps(db);
const actor = { type: 'system' as const };
const year = DateTime.now().setZone('Africa/Casablanca').year;

async function clubWithLegal(): Promise<Fixture & { code: string }> {
  const f = await createClub(db);
  const { rows } = await db.query(
    `UPDATE clubs SET legal_name = 'Golf Test SARL', legal_address = 'Route de test, Marrakech', ice = '001234567000089', tax_id = '1234567'
      WHERE id = $1 RETURNING code`, [f.clubId]);
  return { ...f, code: rows[0].code };
}
const book = (f: Fixture, time: string, players = 2) =>
  createBooking(d, { ...staff, customer: { firstName: 'Karim', lastName: 'Bennani' } }, { courseId: f.courseId, startsAt: at(time), players, holes: 18 });

describe('factures et avoirs', () => {
  it('mentions légales obligatoires ; facture figée ; avoir puis nouvelle facture ; numérotation continue', async () => {
    const bare = await createClub(db);
    const b0 = await book(bare, '08:00');
    await expect(issueInvoice(db, b0.booking.id, {}, actor)).rejects.toMatchObject({ code: 'LEGAL_INFO_MISSING' });

    const f = await clubWithLegal();
    const b = await book(f, '08:00');
    await recordStaffPayment(db, b.booking.id, { amountMinor: 100_000, method: 'cash' }, actor);
    const inv = await issueInvoice(db, b.booking.id, { buyer: { name: 'Société Atlas', ice: '009999999000011', address: 'Casablanca' } }, actor);
    expect(inv.number).toBe(`FA-${f.code}-${year}-00001`);
    expect(inv).toMatchObject({ kind: 'invoice', totalMinor: 280_000, paidMinor: 100_000, buyer: { name: 'Société Atlas', ice: '009999999000011' } });
    expect(inv.totalHtMinor + inv.taxMinor).toBe(inv.totalMinor);
    expect(inv.seller).toMatchObject({ legalName: 'Golf Test SARL', ice: '001234567000089' });
    expect(inv.lines.reduce((n: number, l: { totalMinor: number }) => n + l.totalMinor, 0)).toBe(280_000);

    await expect(issueInvoice(db, b.booking.id, {}, actor)).rejects.toMatchObject({ code: 'INVOICE_EXISTS' });
    // La réservation change : la facture émise ne bouge pas.
    await updateBooking(d, b.booking.id, { players: 3 }, { actor });
    expect((await getInvoice(db, inv.id)).totalMinor).toBe(280_000);

    const cn = await issueCreditNote(db, inv.id, 'Joueur supplémentaire', actor);
    expect(cn).toMatchObject({ kind: 'credit_note', number: `AV-${f.code}-${year}-00001`, totalMinor: -280_000, originalNumber: inv.number });
    await expect(issueCreditNote(db, inv.id, 'bis', actor)).rejects.toMatchObject({ code: 'INVOICE_EXISTS' });
    await expect(issueCreditNote(db, cn.id, 'x', actor)).rejects.toMatchObject({ code: 'VALIDATION' });
    const inv2 = await issueInvoice(db, b.booking.id, {}, actor);
    expect(inv2).toMatchObject({ number: `FA-${f.code}-${year}-00002`, totalMinor: 410_000, buyer: { name: 'Karim Bennani' } });
    expect((await getInvoice(db, inv.id)).creditNoteNumber).toBe(cn.number);
  });

  it('numéros sans doublon ni trou, même en parallèle et après un échec', async () => {
    const f = await clubWithLegal();
    const bookings = [];
    for (const t of ['08:00', '08:06', '08:12', '08:18', '08:24', '08:30']) bookings.push(await book(f, t, 1));
    // Échec (rien à facturer) : aucun numéro consommé.
    await db.query(`DELETE FROM order_lines WHERE order_id = (SELECT id FROM orders WHERE booking_id = $1)`, [bookings[5]!.booking.id]);
    await expect(issueInvoice(db, bookings[5]!.booking.id, {}, actor)).rejects.toMatchObject({ code: 'VALIDATION' });
    const numbers = (await Promise.all(bookings.slice(0, 5).map((b) => issueInvoice(db, b.booking.id, {}, actor)))).map((i) => i.number).sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5].map((n) => `FA-${f.code}-${year}-0000${n}`));
  });
});

describe('clôture de caisse', () => {
  it('totaux par mode, écart sur les espèces, période suivante', async () => {
    const f = await clubWithLegal();
    const b1 = await book(f, '08:00');
    const b2 = await book(f, '09:00');
    await recordStaffPayment(db, b1.booking.id, { amountMinor: 100_000, method: 'cash' }, actor);
    await recordStaffPayment(db, b2.booking.id, { amountMinor: 50_000, method: 'card_terminal' }, actor);
    await recordStaffRefund(db, b1.booking.id, { amountMinor: 20_000, method: 'cash' }, actor);

    const cur = await currentCash(db, f.clubId);
    expect(cur).toMatchObject({ netMinor: 130_000, expectedCashMinor: 80_000, lastClosing: null });
    expect(cur.movements).toHaveLength(3);

    const z1 = await closeCash(db, f.clubId, { countedCashMinor: 125_000, floatMinor: 50_000, note: 'Pièce manquante' }, actor);
    expect(z1).toMatchObject({ number: `Z-${f.code}-${year}-00001`, expectedCashMinor: 130_000, differenceMinor: -5_000 });
    expect(z1.totals.byMethod.cash).toMatchObject({ paidMinor: 100_000, refundedMinor: 20_000, netMinor: 80_000, count: 2 });
    expect(z1.totals.byMethod.card_terminal.netMinor).toBe(50_000);
    expect(z1.movements).toHaveLength(3);

    expect((await currentCash(db, f.clubId)).movements).toHaveLength(0);
    await recordStaffPayment(db, b2.booking.id, { amountMinor: 10_000, method: 'cash' }, actor);
    const z2 = await closeCash(db, f.clubId, { countedCashMinor: 10_000 }, actor);
    expect(z2).toMatchObject({ number: `Z-${f.code}-${year}-00002`, expectedCashMinor: 10_000, differenceMinor: 0 });
    expect(z2.movements).toHaveLength(1);
    expect(z2.periodStart).toEqual(z1.closedAt);
  });
});

describe('droits', () => {
  it('réception : facture et clôture ; direction : avoir et export ; client : ses documents seulement', async () => {
    const f = await clubWithLegal();
    const app = buildServer({ db, now: () => NOW });
    const login = async (email: string) =>
      ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token}` });
    const staffLogin = async (role: Role) => {
      const email = `bill.${role}.${Date.now()}.${Math.random()}@test.ma`;
      await createStaffUser(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', displayName: role, roles: [{ clubId: f.clubId, role }] });
      return login(email);
    };
    const reception = await staffLogin('receptionist');
    const admin = await staffLogin('club_admin');
    const starter = await staffLogin('starter');
    const custEmail = `client.${Date.now()}@test.ma`;
    await registerCustomer(db, { organizationId: f.organizationId, email: custEmail, password: 'motdepasse-test', lastName: 'Client' });
    const customer = await login(custEmail);
    const { rows: [c] } = await db.query('SELECT customer_id FROM users WHERE email = $1', [custEmail]);
    const mine = await createBooking(d, { ...staff, customerId: c.customer_id }, { courseId: f.courseId, startsAt: at('10:00'), players: 1, holes: 18 });
    const other = await book(f, '11:00');

    const inv = await app.inject({ method: 'POST', url: `/api/bookings/${mine.booking.id}/invoices`, headers: reception, payload: {} });
    expect(inv.statusCode).toBe(201);
    const invoiceId = inv.json().invoice.id;
    expect((await app.inject({ method: 'POST', url: `/api/bookings/${other.booking.id}/invoices`, headers: starter, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/invoices/${invoiceId}`, headers: customer })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/bookings/${mine.booking.id}/receipt`, headers: customer })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/bookings/${other.booking.id}/receipt`, headers: customer })).statusCode).toBe(403);

    expect((await app.inject({ method: 'POST', url: `/api/invoices/${invoiceId}/credit-note`, headers: reception, payload: { reason: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/invoices/${invoiceId}/credit-note`, headers: admin, payload: { reason: 'Erreur' } })).statusCode).toBe(201);

    const q = `from=${year}-01-01&to=${year}-12-31`;
    expect((await app.inject({ method: 'GET', url: `/api/clubs/${f.clubId}/invoices.csv?${q}`, headers: reception })).statusCode).toBe(403);
    const csv = await app.inject({ method: 'GET', url: `/api/clubs/${f.clubId}/invoices.csv?${q}`, headers: admin });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(`FA-${f.code}-${year}-00001`);
    expect(csv.body).toContain('Avoir');

    await app.inject({ method: 'POST', url: `/api/bookings/${other.booking.id}/payments`, headers: reception, payload: { amountMinor: 50_000, method: 'cash' } });
    expect((await app.inject({ method: 'GET', url: `/api/clubs/${f.clubId}/cash`, headers: starter })).statusCode).toBe(403);
    const z = await app.inject({ method: 'POST', url: `/api/clubs/${f.clubId}/cash/closings`, headers: reception, payload: { countedCashMinor: 50_000 } });
    expect(z.statusCode).toBe(201);
    expect(z.json().closing.differenceMinor).toBe(0);
    await app.close();
  });
});
