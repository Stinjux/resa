import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { createStaffUser } from '../src/modules/auth/service.js';
import {
  closeCash, getInvoice, issueCreditNote, issueInvoice, issuePartnerInvoice, previewPartnerInvoice, recordInvoicePayment,
} from '../src/modules/billing/service.js';
import { createBooking } from '../src/modules/booking/service.js';
import { getBookingOrder, recordStaffPayment } from '../src/modules/orders/service.js';
import { savePartner } from '../src/modules/partners/service.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const d = deps(db);
const actor = { type: 'system' as const };
const year = DateTime.now().setZone('Africa/Casablanca').year;

async function setup(scope: 'all' | 'green_fees' | 'none' = 'green_fees') {
  const f = await createClub(db);
  const { rows } = await db.query(
    `UPDATE clubs SET legal_name = 'Golf SARL', legal_address = 'Adresse', ice = '000000000000009' WHERE id = $1 RETURNING code`, [f.clubId]);
  await db.query(`INSERT INTO tariffs (club_id, product, name, holes, customer_category, amount_minor, basis, priority)
                  VALUES ($1, 'green_fee', 'Green fee TO', 18, 'to', 100000, 'per_player', 5)`, [f.clubId]);
  const p = await savePartner(db, f.organizationId, null, { code: 'TO', name: 'Atlas', legalName: 'Atlas SARL', priceCategory: 'to',
    billingScope: scope, paymentTermsDays: 30 }, actor);
  return { ...f, code: rows[0].code as string, partnerId: p.id as string };
}
const book = (f: Fixture & { partnerId: string }, time: string, players: number, voucher = 'V1') =>
  createBooking(d, { ...staff, partnerId: f.partnerId, partnerReference: voucher, customer: { lastName: `Client ${time}` } },
    { courseId: f.courseId, startsAt: at(time), players, holes: 18, options: [{ code: 'CART', quantity: 1 }] });

describe('facturation client / partenaire', () => {
  it('green fees au partenaire, extras au client : deux parts, deux factures, deux séries', async () => {
    const f = await setup('green_fees');
    await db.query(`UPDATE resource_types SET price_18_minor = 40000 WHERE club_id = $1 AND code = 'CART'`, [f.clubId]);
    const b = await book(f, '08:00', 2);
    const o = await getBookingOrder(db, b.booking.id);
    // Green fees 2 × 1 000 → partenaire ; caddie 200 + voiturette 400 → client.
    expect(o.split.partner.totalMinor).toBe(200_000);
    expect(o.split.customer.totalMinor).toBe(o.totalMinor - 200_000);
    expect(o.lines.find((l: { kind: string }) => l.kind === 'green_fee').payer).toBe('partner');

    // Le client règle sa part au comptoir, puis reçoit sa facture (sans les green fees).
    await recordStaffPayment(db, b.booking.id, { amountMinor: o.split.customer.totalMinor, method: 'cash' }, actor);
    const fc = await issueInvoice(db, b.booking.id, { buyer: { name: 'M. Client' } }, actor);
    expect(fc).toMatchObject({ payer: 'customer', number: `FA-${f.code}-${year}-00001`, totalMinor: o.split.customer.totalMinor,
      paidMinor: o.split.customer.totalMinor });
    expect(fc.lines.some((l: { label: string }) => /green fee/i.test(l.label))).toBe(false);
    await expect(issueInvoice(db, b.booking.id, {}, actor)).rejects.toMatchObject({ code: 'INVOICE_EXISTS' });

    // La part partenaire se facture à part, dans sa propre série.
    const fp = await issueInvoice(db, b.booking.id, { payer: 'partner' }, actor);
    expect(fp).toMatchObject({ payer: 'partner', number: `FP-${f.code}-${year}-00001`, totalMinor: 200_000, partnerId: f.partnerId });
    expect(fp.dueDate).toBeTruthy();
  });

  it('facture partenaire groupée sur une période, règlement réparti, avoir puis refacturation', async () => {
    const f = await setup('all');
    const b1 = await book(f, '08:00', 3, 'V-A');
    const b2 = await book(f, '09:00', 2, 'V-B');
    await createBooking(d, staff, { courseId: f.courseId, startsAt: at('10:00'), players: 1, holes: 18 }); // client direct : exclu
    const other = await book(f, '08:00', 1, 'V-C'); // même départ que b1

    const preview = await previewPartnerInvoice(db, f.clubId, f.partnerId, { from: DAY, to: DAY });
    expect(preview.bookings.map((x) => x.partnerReference).sort()).toEqual(['V-A', 'V-B', 'V-C']);
    const inv = await issuePartnerInvoice(db, f.clubId, f.partnerId, { from: DAY, to: DAY }, actor);
    expect(inv.totalMinor).toBe(preview.totalMinor);
    expect(inv.bookingIds).toHaveLength(3);
    expect(inv.lines.some((l: { label: string }) => l.label.includes('V-A'))).toBe(true);
    // Rien à refacturer ensuite.
    await expect(issuePartnerInvoice(db, f.clubId, f.partnerId, { from: DAY, to: DAY }, actor)).rejects.toMatchObject({ code: 'VALIDATION' });
    // « Tout » au partenaire : rien pour le client.
    await expect(issueInvoice(db, b1.booking.id, {}, actor)).rejects.toMatchObject({ code: 'VALIDATION' });

    // Virement partiel puis solde : réparti sur les réservations, compté en caisse.
    const part = Math.floor(inv.totalMinor / 2);
    let after = await recordInvoicePayment(db, inv.id, { amountMinor: part, method: 'bank_transfer', note: 'Virement' }, actor);
    expect(after.settledMinor).toBe(part);
    await expect(recordInvoicePayment(db, inv.id, { amountMinor: inv.totalMinor, method: 'bank_transfer' }, actor)).rejects.toMatchObject({ code: 'VALIDATION' });
    after = await recordInvoicePayment(db, inv.id, { amountMinor: inv.totalMinor - part, method: 'bank_transfer' }, actor);
    expect(after.settledMinor).toBe(inv.totalMinor);
    for (const b of [b1, b2, other]) expect((await getBookingOrder(db, b.booking.id)).split.partner.balanceMinor).toBe(0);
    const z = await closeCash(db, f.clubId, { countedCashMinor: 0 }, actor);
    expect(z.totals.byMethod.bank_transfer.netMinor).toBe(inv.totalMinor);

    // Avoir : les réservations redeviennent facturables (ex. facture refaite pour un seul voucher).
    await issueCreditNote(db, inv.id, 'Regroupement erroné', actor);
    const single = await issuePartnerInvoice(db, f.clubId, f.partnerId, { bookingIds: [b2.booking.id] }, actor);
    expect(single.bookingIds).toEqual([b2.booking.id]);
    expect(single.number).toBe(`FP-${f.code}-${year}-00002`);
    expect((await getInvoice(db, inv.id)).creditNoteNumber).toMatch(/^AV-/);
  });

  it('« rien au partenaire » : le client paie tout, au tarif négocié ; changement de réglage appliqué au non-facturé', async () => {
    const f = await setup('none');
    const b = await book(f, '08:00', 2);
    let o = await getBookingOrder(db, b.booking.id);
    expect(o.split.partner.totalMinor).toBe(0);
    expect(o.split.customer.totalMinor).toBe(o.totalMinor);
    await expect(issueInvoice(db, b.booking.id, { payer: 'partner' }, actor)).rejects.toMatchObject({ code: 'VALIDATION' });

    await savePartner(db, f.organizationId, f.partnerId, { billingScope: 'green_fees' }, actor);
    o = await getBookingOrder(db, b.booking.id);
    expect(o.split.partner.totalMinor).toBe(200_000);
  });

  it('droits : facture partenaire réservée à la direction ; le client ne voit pas la facture du partenaire', async () => {
    const f = await setup('green_fees');
    const app = buildServer({ db, now: () => NOW });
    const login = async (role: 'receptionist' | 'club_admin') => {
      const email = `sb.${role}.${Math.random()}@test.ma`;
      await createStaffUser(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', displayName: role, roles: [{ clubId: f.clubId, role }] });
      return { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token}` };
    };
    const rec = await login('receptionist');
    const dir = await login('club_admin');
    const b = await book(f, '08:00', 2);
    const url = `/api/clubs/${f.clubId}/partners/${f.partnerId}/invoices`;
    expect((await app.inject({ method: 'POST', url, headers: rec, payload: { from: DAY, to: DAY } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/bookings/${b.booking.id}/invoices`, headers: rec, payload: { payer: 'partner' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/bookings/${b.booking.id}/invoices`, headers: rec, payload: {} })).statusCode).toBe(201);
    const r = await app.inject({ method: 'POST', url, headers: dir, payload: { from: DAY, to: DAY } });
    expect(r.statusCode).toBe(201);
    const pay = await app.inject({ method: 'POST', url: `/api/invoices/${r.json().invoice.id}/payments`, headers: rec, payload: { amountMinor: 100, method: 'bank_transfer' } });
    expect(pay.statusCode).toBe(403);
    const list = (await app.inject({ method: 'GET', url: `/api/bookings/${b.booking.id}/invoices`, headers: rec })).json().invoices;
    expect(list.map((i: { payer: string }) => i.payer).sort()).toEqual(['customer', 'partner']);
    await app.close();
  });
});
