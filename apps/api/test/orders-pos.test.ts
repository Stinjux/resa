import { describe, expect, it } from 'vitest';
import { PosError, type PosCallContext, type PosConnector, type PosSale } from '../src/integrations/pos/contract.js';
import { createPosRegistry } from '../src/integrations/pos/registry.js';
import { cancelBooking, createBooking, moveBooking, updateBooking } from '../src/modules/booking/service.js';
import {
  createPendingPayment,
  getBookingOrder,
  recordStaffPayment,
  recordStaffRefund,
  settleProviderPayment,
} from '../src/modules/orders/service.js';
import { processPosJobs, retryPosJob } from '../src/modules/pos-sync/service.js';
import { at, createClub, deps, NOW, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();
const d = deps(db);
const book = (f: Fixture, time: string, players = 2) =>
  createBooking(d, staff, { courseId: f.courseId, startsAt: at(time), players, holes: 18 });
const order = (bookingId: string) => getBookingOrder(db, bookingId);

describe('commande et paiement', () => {
  it('une réservation crée une commande impayée ; seuls les paiements confirmés comptent', async () => {
    const f = await createClub(db);
    const b = await book(f, '08:00');
    let o = await order(b.booking.id);
    expect(o.totalMinor).toBe(2 * 130000 + 20000);
    expect(o.paymentStatus).toBe('unpaid');
    expect(o.lines.map((l: { sku: string }) => l.sku)).toEqual(['GREEN_FEE_18', 'CADDIE']);

    // Paiement en ligne initié : en attente, NE compte PAS.
    await createPendingPayment(db, b.booking.id, { amountMinor: o.totalMinor, method: 'online', provider: 'psp-test', externalId: 'tx-1', idempotencyKey: 'k1' });
    o = await order(b.booking.id);
    expect(o.paymentStatus).toBe('unpaid');
    expect(o.pendingMinor).toBe(o.totalMinor);

    // Confirmation avec un montant différent : refusée.
    await expect(settleProviderPayment(db, { provider: 'psp-test', externalId: 'tx-1', outcome: 'confirmed', amountMinor: 1, currency: 'MAD' }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    // Confirmation fiable : payée. Rejeu de la notification : sans effet.
    await settleProviderPayment(db, { provider: 'psp-test', externalId: 'tx-1', outcome: 'confirmed', amountMinor: o.totalMinor, currency: 'MAD' });
    await settleProviderPayment(db, { provider: 'psp-test', externalId: 'tx-1', outcome: 'confirmed', amountMinor: o.totalMinor, currency: 'MAD' });
    o = await order(b.booking.id);
    expect(o.paymentStatus).toBe('paid');
    expect(o.paidMinor).toBe(o.totalMinor);
  });

  it('encaissements partiels, refus du trop-perçu, idempotence', async () => {
    const f = await createClub(db);
    const b = await book(f, '08:00');
    const actor = staff.actor;
    await recordStaffPayment(db, b.booking.id, { amountMinor: 100000, method: 'cash', idempotencyKey: 'pay-1' }, actor);
    await recordStaffPayment(db, b.booking.id, { amountMinor: 100000, method: 'cash', idempotencyKey: 'pay-1' }, actor); // rejeu
    let o = await order(b.booking.id);
    expect(o.paidMinor).toBe(100000);
    expect(o.paymentStatus).toBe('partially_paid');
    await expect(recordStaffPayment(db, b.booking.id, { amountMinor: o.balanceMinor + 1, method: 'card_terminal' }, actor))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await recordStaffPayment(db, b.booking.id, { amountMinor: o.balanceMinor, method: 'card_terminal' }, actor);
    o = await order(b.booking.id);
    expect(o.paymentStatus).toBe('paid');
    expect(o.payments).toHaveLength(2);
  });

  it('une modification après paiement fait apparaître un reste dû ou un remboursement', async () => {
    const f = await createClub(db);
    const b = await book(f, '08:00', 2);
    const o1 = await order(b.booking.id);
    await recordStaffPayment(db, b.booking.id, { amountMinor: o1.totalMinor, method: 'cash' }, staff.actor);

    await updateBooking(d, b.booking.id, { players: 3 }, { actor: staff.actor });
    let o = await order(b.booking.id);
    expect(o.paymentStatus).toBe('partially_paid');
    expect(o.balanceMinor).toBe(130000);

    await updateBooking(d, b.booking.id, { players: 1 }, { actor: staff.actor });
    o = await order(b.booking.id);
    expect(o.paymentStatus).toBe('refund_due');
    expect(o.balanceMinor).toBe(-130000);
    await expect(recordStaffRefund(db, b.booking.id, { amountMinor: o.paidMinor + 1, method: 'cash' }, staff.actor))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await recordStaffRefund(db, b.booking.id, { amountMinor: 130000, method: 'cash', reason: 'Joueur en moins' }, staff.actor);
    expect((await order(b.booking.id)).paymentStatus).toBe('paid');
  });

  it('la réunion de deux départs recalcule les deux commandes (caddie partagé)', async () => {
    const f = await createClub(db);
    const a = await book(f, '08:00');
    const b = await book(f, '08:30');
    await moveBooking(d, b.booking.id, { teeTimeId: a.booking.teeTime.id }, { actor: staff.actor });
    for (const id of [a.booking.id, b.booking.id]) {
      const caddie = (await order(id)).lines.find((l: { sku: string }) => l.sku === 'CADDIE');
      expect(caddie.totalMinor).toBe(10000);
    }
  });
});

describe('annulation', () => {
  it('gratuite dans le délai ; frais selon la politique du golf après ; remboursement dû si déjà payé', async () => {
    const f = await createClub(db);
    await db.query('UPDATE clubs SET cancellation_free_hours = 48, cancellation_fee_percent = 50 WHERE id = $1', [f.clubId]);
    // Départ le 10/06, « maintenant » = 01/06 : dans le délai gratuit.
    const free = await book(f, '08:00');
    await cancelBooking(d, free.booking.id, { actor: staff.actor });
    expect((await order(free.booking.id))).toMatchObject({ status: 'cancelled', totalMinor: 0, paymentStatus: 'nothing_due' });

    // Annulation tardive (la veille) d'une réservation payée.
    const late = await book(f, '09:00');
    const total = (await order(late.booking.id)).totalMinor;
    await recordStaffPayment(db, late.booking.id, { amountMinor: total, method: 'card_terminal' }, staff.actor);
    const lateDeps = deps(db, new Date('2030-06-09T12:00:00Z'));
    await cancelBooking(lateDeps, late.booking.id, { actor: staff.actor });
    const o = await order(late.booking.id);
    expect(o.totalMinor).toBe(total / 2);
    expect(o.lines[0].sku).toBe('CANCELLATION_FEE');
    expect(o.paymentStatus).toBe('refund_due');
    expect(o.balanceMinor).toBe(-total / 2);

    // Le personnel peut renoncer aux frais.
    const waived = await book(f, '10:00');
    await cancelBooking(lateDeps, waived.booking.id, { actor: staff.actor, waiveFee: true });
    expect((await order(waived.booking.id)).totalMinor).toBe(0);
  });
});

// ---------------------------------------------------------------------------

/** Faux fournisseur : compte les ventes réellement créées, peut tomber en panne. */
class FakePos implements PosConnector {
  readonly provider = 'fake';
  readonly capabilities = { sales: true, payments: true, refunds: true, priceMode: 'both' } as const;
  sales = new Map<string, PosSale>(); // externalId → dernière version reçue
  creations = 0;
  failures = 0;
  seenKeys = new Set<string>();
  async upsertSale(sale: PosSale, ctx: PosCallContext) {
    if (this.failures > 0) {
      this.failures--;
      throw new PosError('Service indisponible (503)', true);
    }
    this.seenKeys.add(ctx.idempotencyKey);
    const id = ctx.existingExternalId ?? `fake-${++this.creations}`;
    this.sales.set(id, sale);
    return { externalId: id };
  }
  async recordPayment() {
    return { externalId: `fake-pay-${Math.random()}` };
  }
}

async function posClub(provider = 'fake') {
  const f = await createClub(db);
  await db.query('UPDATE clubs SET pos_provider = $2 WHERE id = $1', [f.clubId, provider]);
  return f;
}
const jobs = async (clubId: string) =>
  (await db.query('SELECT operation, status, attempts, entity_version AS v FROM pos_sync_jobs WHERE club_id = $1 ORDER BY created_at, entity_version', [clubId])).rows;

describe('synchronisation POS', () => {
  it('une réservation met une vente en file ; le traitement crée la correspondance d’identifiant', async () => {
    const f = await posClub();
    const pos = new FakePos();
    const registry = createPosRegistry([pos]);
    const b = await book(f, '08:00');
    expect(await jobs(f.clubId)).toEqual([{ operation: 'upsert_sale', status: 'pending', attempts: 0, v: 1 }]);
    await processPosJobs(db, registry, NOW, { clubId: f.clubId });
    const o = await order(b.booking.id);
    expect(o.externalRefs).toEqual([expect.objectContaining({ provider: 'fake', externalId: 'fake-1' })]);
    expect(pos.sales.get('fake-1')!.lines.map((l) => l.sku)).toEqual(['GREEN_FEE_18', 'CADDIE']);
  });

  it('n’envoie que la dernière version et ne crée jamais de vente en double', async () => {
    const f = await posClub();
    const pos = new FakePos();
    const registry = createPosRegistry([pos]);
    const b = await book(f, '08:00', 2);
    await updateBooking(d, b.booking.id, { players: 3 }, { actor: staff.actor });
    await updateBooking(d, b.booking.id, { players: 4 }, { actor: staff.actor });
    await processPosJobs(db, registry, NOW, { clubId: f.clubId });
    expect((await jobs(f.clubId)).map((j) => j.status)).toEqual(['superseded', 'superseded', 'succeeded']);
    expect(pos.creations).toBe(1);
    expect(pos.sales.get('fake-1')!.lines[0]!.quantity).toBe(4);

    // Nouvelle modification : mise à jour de la même vente, pas de création.
    await updateBooking(d, b.booking.id, { players: 1 }, { actor: staff.actor });
    await processPosJobs(db, registry, NOW, { clubId: f.clubId });
    expect(pos.creations).toBe(1);
    expect(pos.sales.get('fake-1')!.lines[0]!.quantity).toBe(1);
  });

  it('panne passagère : nouvel essai différé, journal des erreurs, puis succès sans doublon', async () => {
    const f = await posClub();
    const pos = new FakePos();
    pos.failures = 2;
    const registry = createPosRegistry([pos]);
    await book(f, '08:00');

    expect(await processPosJobs(db, registry, NOW, { clubId: f.clubId })).toMatchObject({ failed: 1 });
    expect(await processPosJobs(db, registry, NOW, { clubId: f.clubId })).toMatchObject({ processed: 0 }); // pas avant le délai
    const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
    expect(await processPosJobs(db, registry, later(1), { clubId: f.clubId })).toMatchObject({ failed: 1 });
    expect(await processPosJobs(db, registry, later(10), { clubId: f.clubId })).toMatchObject({ succeeded: 1 });
    expect(pos.creations).toBe(1);
    const log = await db.query(
      `SELECT l.success, l.error FROM pos_sync_log l JOIN pos_sync_jobs j ON j.id = l.job_id WHERE j.club_id = $1 ORDER BY l.id`,
      [f.clubId],
    );
    expect(log.rows.map((r) => r.success)).toEqual([false, false, true]);
    expect(log.rows[0].error).toContain('503');
  });

  it('abandon après le nombre maximal d’essais, puis relance manuelle', async () => {
    const f = await posClub();
    const pos = new FakePos();
    pos.failures = 100;
    const registry = createPosRegistry([pos]);
    await book(f, '08:00');
    await db.query('UPDATE pos_sync_jobs SET max_attempts = 2 WHERE club_id = $1', [f.clubId]);
    await processPosJobs(db, registry, NOW, { clubId: f.clubId });
    await processPosJobs(db, registry, new Date(NOW.getTime() + 3_600_000), { clubId: f.clubId });
    const [job] = (await db.query('SELECT id, status FROM pos_sync_jobs WHERE club_id = $1', [f.clubId])).rows;
    expect(job.status).toBe('dead');
    pos.failures = 0;
    expect(await retryPosJob(db, f.clubId, job.id, NOW)).toBe(true);
    await processPosJobs(db, registry, NOW, { clubId: f.clubId });
    expect((await jobs(f.clubId))[0].status).toBe('succeeded');
  });

  it('un paiement attend que la vente existe chez le fournisseur', async () => {
    const f = await posClub();
    const pos = new FakePos();
    pos.failures = 1;
    const registry = createPosRegistry([pos]);
    const b = await book(f, '08:00');
    await recordStaffPayment(db, b.booking.id, { amountMinor: 50000, method: 'cash' }, staff.actor);
    const r1 = await processPosJobs(db, registry, NOW, { clubId: f.clubId });
    expect(r1).toMatchObject({ failed: 2 }); // vente en panne, paiement en attente de la vente
    await processPosJobs(db, registry, new Date(NOW.getTime() + 5 * 60_000), { clubId: f.clubId });
    expect((await jobs(f.clubId)).map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('sans POS configuré, rien n’est mis en file', async () => {
    const f = await createClub(db);
    await book(f, '08:00');
    expect(await jobs(f.clubId)).toEqual([]);
  });
});
