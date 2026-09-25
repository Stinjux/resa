import { describe, expect, it } from 'vitest';
import {
  cancelBooking,
  createBooking,
  createGroupBooking,
  moveBooking,
  updateBooking,
} from '../src/modules/booking/service.js';
import { getAvailability, getTeeSheet } from '../src/modules/teesheet/service.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb, web, type Fixture } from './helpers.js';

const db = useTestDb();
const d = deps(db);

function book(
  f: Fixture,
  time: string,
  players: number,
  extra: Record<string, unknown> & { customer?: { lastName: string; email?: string } } = {},
  ctx: typeof staff | typeof web = staff,
) {
  const { customer, ...item } = extra;
  return createBooking(d, { ...ctx, customer }, { courseId: f.courseId, startsAt: at(time), players, holes: 18, ...item });
}

async function activeCaddieAllocations(teeTimeId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id
      WHERE a.tee_time_id = $1 AND a.status = 'active' AND rt.kind = 'caddie'`,
    [teeTimeId],
  );
  return rows[0].n;
}

async function playersOn(teeTimeId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT coalesce(sum(players), 0)::int AS n FROM bookings WHERE tee_time_id = $1 AND status = 'confirmed'`,
    [teeTimeId],
  );
  return rows[0].n;
}

describe('limite de 4 joueurs par départ', () => {
  it('complète un départ jusqu’à 4 puis refuse', async () => {
    const f = await createClub(db);
    const a = await book(f, '08:00', 3);
    await expect(book(f, '08:00', 2)).rejects.toMatchObject({ code: 'TEE_TIME_FULL' });
    await book(f, '08:00', 1);
    await expect(book(f, '08:00', 1)).rejects.toMatchObject({ code: 'TEE_TIME_FULL' });
    expect(await playersOn(a.booking.teeTime.id)).toBe(4);
  });

  it('refuse une réservation de 5 joueurs', async () => {
    const f = await createClub(db);
    await expect(book(f, '08:00', 5)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuse un créneau hors grille ou dans une fermeture', async () => {
    const f = await createClub(db);
    await expect(book(f, '08:03', 2)).rejects.toMatchObject({ code: 'SLOT_NOT_AVAILABLE' });
    await db.query(
      `INSERT INTO schedule_rules (club_id, name, kind, valid_from, valid_to, start_time, end_time)
       VALUES ($1, 'Compétition', 'closed', $2, $2, '08:00', '10:00')`,
      [f.clubId, DAY],
    );
    await expect(book(f, '08:00', 2)).rejects.toMatchObject({ code: 'SLOT_NOT_AVAILABLE' });
    await book(f, '10:00', 2);
  });
});

describe('réservations simultanées', () => {
  it('10 demandes de 2 joueurs en parallèle sur le même départ : exactement 2 acceptées', async () => {
    const f = await createClub(db);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => book(f, '09:00', 2)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(2);
    expect(ko.every((r) => r.reason.code === 'TEE_TIME_FULL')).toBe(true);
    const teeTimeId = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof book>>>).value.booking.teeTime.id;
    expect(await playersOn(teeTimeId)).toBe(4);
    expect(await activeCaddieAllocations(teeTimeId)).toBe(1);
  });

  it('un seul caddie disponible : deux départs qui se chevauchent réservés en parallèle → un seul accepté', async () => {
    const f = await createClub(db, { caddies: 1 });
    const results = await Promise.allSettled([book(f, '09:00', 2), book(f, '09:06', 2), book(f, '09:12', 1)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason.code).toBe('CADDIE_UNAVAILABLE');
    }
  });

  it('matériel : 1 voiturette demandée en parallèle sur deux départs → une seule allouée', async () => {
    const f = await createClub(db, { carts: 1 });
    const results = await Promise.allSettled([
      book(f, '09:00', 2, { options: [{ code: 'CART', quantity: 1 }] }),
      book(f, '09:30', 2, { options: [{ code: 'CART', quantity: 1 }] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id WHERE t.club_id = $1`,
      [f.clubId],
    );
    expect(rows[0].n).toBe(1); // l'échec n'a laissé aucune réservation orpheline
  });

  it('idempotence : la même demande rejouée ne crée qu’une réservation', async () => {
    const f = await createClub(db);
    const ctx = { ...web, idempotencyKey: `key-${f.clubId}` };
    const [r1, r2] = await Promise.all([book(f, '10:00', 2, {}, ctx), book(f, '10:00', 2, {}, ctx)]);
    expect(r1.booking.id).toBe(r2.booking.id);
    expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
    expect(await playersOn(r1.booking.teeTime.id)).toBe(2);
  });
});

describe('caddie obligatoire, un seul par départ', () => {
  it('deux réservations sur le même départ partagent un seul caddie', async () => {
    const f = await createClub(db, { caddies: 1 });
    const a = await book(f, '08:00', 2);
    const b = await book(f, '08:00', 2); // pas de 2e caddie nécessaire
    expect(b.booking.teeTime.id).toBe(a.booking.teeTime.id);
    expect(await activeCaddieAllocations(a.booking.teeTime.id)).toBe(1);
  });

  it('refuse le départ si aucun caddie n’est disponible, même pour 1 joueur', async () => {
    const f = await createClub(db, { caddies: 1 });
    await book(f, '08:00', 1);
    await expect(book(f, '08:06', 1)).rejects.toMatchObject({ code: 'CADDIE_UNAVAILABLE' });
    // Après la fin de la partie (270 min), le caddie est de nouveau libre.
    await book(f, '12:30', 1);
  });

  it('respecte une exception de capacité caddies pour la journée', async () => {
    const f = await createClub(db, { caddies: 5 });
    await db.query(`INSERT INTO resource_capacity_overrides (resource_type_id, date, quantity) VALUES ($1, $2, 0)`, [
      f.rt.CADDIE,
      DAY,
    ]);
    await expect(book(f, '08:00', 2)).rejects.toMatchObject({ code: 'CADDIE_UNAVAILABLE' });
  });

  it('libère le caddie seulement quand le départ devient vide', async () => {
    const f = await createClub(db, { caddies: 1 });
    const a = await book(f, '08:00', 2);
    const b = await book(f, '08:00', 2);
    await cancelBooking(d, a.booking.id, { actor: staff.actor });
    expect(await activeCaddieAllocations(a.booking.teeTime.id)).toBe(1);
    await cancelBooking(d, b.booking.id, { actor: staff.actor });
    expect(await activeCaddieAllocations(a.booking.teeTime.id)).toBe(0);
    await book(f, '08:06', 1); // le caddie est de nouveau disponible
  });

  it('la disponibilité client masque les départs sans caddie disponible', async () => {
    const f = await createClub(db, { caddies: 1 });
    await book(f, '08:00', 2);
    const { slots } = await getAvailability(db, {
      courseId: f.courseId, date: DAY, players: 2, holes: 18, now: NOW, enforceBookingWindow: true,
    });
    const times = slots.map((s) => s.localTime);
    expect(times).toContain('08:00'); // départ déjà pourvu d'un caddie, 2 places restantes
    expect(times).not.toContain('08:06');
    expect(times).toContain('12:30');
  });
});

describe('réunion de réservations', () => {
  it('réunit deux réservations de 2 joueurs sur un même départ en gardant leur identité', async () => {
    const f = await createClub(db, { caddies: 2 });
    const a = await book(f, '08:00', 2, { customer: { lastName: 'Alami' } });
    const b = await book(f, '08:30', 2, { customer: { lastName: 'Bennani' }, options: [{ code: 'TROLLEY', quantity: 2 }] });

    const moved = await moveBooking(d, b.booking.id, { teeTimeId: a.booking.teeTime.id }, { actor: staff.actor });

    expect(moved.teeTime.id).toBe(a.booking.teeTime.id);
    expect(moved.reference).toBe(b.booking.reference);
    expect(moved.customerId).toBe(b.booking.customerId);
    expect(moved.customerId).not.toBe(a.booking.customerId);
    expect(moved.options).toEqual([expect.objectContaining({ code: 'TROLLEY', quantity: 2 })]);
    expect(await playersOn(a.booking.teeTime.id)).toBe(4);
    expect(await activeCaddieAllocations(a.booking.teeTime.id)).toBe(1);
    expect(await activeCaddieAllocations(b.booking.teeTime.id)).toBe(0); // ancien départ libéré

    const sheet = await getTeeSheet(db, f.courseId, DAY);
    const row = sheet.rows.find((r) => r.teeTimeId === a.booking.teeTime.id)!;
    expect(row.bookings.map((x) => x.reference).sort()).toEqual([a.booking.reference, b.booking.reference].sort());
    expect(row.remaining).toBe(0);

    const c = await book(f, '09:00', 1);
    await expect(moveBooking(d, c.booking.id, { teeTimeId: a.booking.teeTime.id }, { actor: staff.actor })).rejects.toMatchObject({
      code: 'TEE_TIME_FULL',
    });
  });

  it('refuse de réunir 9 et 18 trous, ou vers un départ privé', async () => {
    const f = await createClub(db);
    const a = await book(f, '08:00', 2);
    const nine = await createBooking(d, staff, { courseId: f.courseId, startsAt: at('08:30'), players: 2, holes: 9 });
    await expect(moveBooking(d, nine.booking.id, { teeTimeId: a.booking.teeTime.id }, { actor: staff.actor })).rejects.toMatchObject({
      code: 'HOLES_MISMATCH',
    });
    const priv = await book(f, '09:00', 2, { isPrivate: true });
    const other = await book(f, '09:30', 2);
    await expect(moveBooking(d, other.booking.id, { teeTimeId: priv.booking.teeTime.id }, { actor: staff.actor })).rejects.toMatchObject({
      code: 'TEE_TIME_PRIVATE',
    });
  });

  it('un déplacement impossible (matériel) ne modifie rien', async () => {
    const f = await createClub(db, { carts: 1 });
    await book(f, '12:00', 2, { options: [{ code: 'CART', quantity: 1 }] });
    const b = await book(f, '07:00', 2, { options: [{ code: 'CART', quantity: 1 }] });
    await expect(
      moveBooking(d, b.booking.id, { courseId: f.courseId, startsAt: at('13:00') }, { actor: staff.actor }),
    ).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    const { rows } = await db.query('SELECT tee_time_id FROM bookings WHERE id = $1', [b.booking.id]);
    expect(rows[0].tee_time_id).toBe(b.booking.teeTime.id);
    expect(await activeCaddieAllocations(b.booking.teeTime.id)).toBe(1);
  });
});

describe('départ privé', () => {
  it('bloque les places restantes, puis les libère à l’annulation', async () => {
    const f = await createClub(db);
    const p = await book(f, '08:00', 2, { isPrivate: true });
    const avail = () =>
      getAvailability(db, { courseId: f.courseId, date: DAY, players: 1, holes: 18, now: NOW, enforceBookingWindow: true });
    expect((await avail()).slots.map((s) => s.localTime)).not.toContain('08:00');
    await expect(book(f, '08:00', 1)).rejects.toMatchObject({ code: 'TEE_TIME_PRIVATE' });

    await cancelBooking(d, p.booking.id, { actor: staff.actor });
    expect((await avail()).slots.map((s) => s.localTime)).toContain('08:00');
    await book(f, '08:00', 1);
  });

  it('refuse de privatiser un départ déjà partagé', async () => {
    const f = await createClub(db);
    const a = await book(f, '08:00', 2);
    await expect(book(f, '08:00', 2, { isPrivate: true })).rejects.toMatchObject({ code: 'PRIVATE_REQUIRES_EMPTY_TEE_TIME' });
    // Le seul occupant peut privatiser son départ.
    const updated = await updateBooking(d, a.booking.id, { isPrivate: true }, { actor: staff.actor });
    expect(updated.isPrivate).toBe(true);
    await expect(book(f, '08:00', 1)).rejects.toMatchObject({ code: 'TEE_TIME_PRIVATE' });
  });
});

describe('matériel', () => {
  it('vérifie la disponibilité sur la période d’utilisation et libère à l’annulation', async () => {
    const f = await createClub(db, { carts: 1 });
    const a = await book(f, '08:00', 2, { options: [{ code: 'CART', quantity: 1 }] });
    await expect(book(f, '09:00', 2, { options: [{ code: 'CART', quantity: 1 }] })).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
    });
    // 08:00 + 270 min = 12:30 : la voiturette est revenue.
    await book(f, '12:30', 2, { options: [{ code: 'CART', quantity: 1 }] });
    await cancelBooking(d, a.booking.id, { actor: staff.actor });
    // 08:00 → 12:30 : se termine quand la location suivante commence.
    await book(f, '08:00', 2, { options: [{ code: 'CART', quantity: 1 }] });
  });

  it('gère les sacs de location par type et plafonne par réservation', async () => {
    const f = await createClub(db, { bagsMenRight: 2 });
    await book(f, '08:00', 2, { options: [{ code: 'BAG_MEN_RH', quantity: 2 }] });
    await expect(book(f, '08:06', 1, { options: [{ code: 'BAG_MEN_RH', quantity: 1 }] })).rejects.toMatchObject({
      code: 'RESOURCE_UNAVAILABLE',
      details: expect.objectContaining({ available: 0 }),
    });
    await expect(book(f, '09:00', 4, { options: [{ code: 'TROLLEY', quantity: 5 }] })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('modifier les options libère les anciennes et réserve les nouvelles', async () => {
    const f = await createClub(db, { carts: 1 });
    const a = await book(f, '08:00', 2, { options: [{ code: 'CART', quantity: 1 }] });
    await updateBooking(d, a.booking.id, { options: [{ code: 'TROLLEY', quantity: 2 }] }, { actor: staff.actor });
    await book(f, '08:30', 2, { options: [{ code: 'CART', quantity: 1 }] });
  });
});

describe('réservation de groupe', () => {
  it('crée plusieurs départs en une fois, ou rien du tout', async () => {
    const f = await createClub(db, { caddies: 3 });
    const items = ['08:00', '08:06', '08:12'].map((t) => ({ courseId: f.courseId, startsAt: at(t), players: 4, holes: 18 as const }));
    const g = await createGroupBooking(d, { ...staff, channel: 'group' }, items);
    expect(g.bookings).toHaveLength(3);
    expect(new Set(g.bookings.map((b) => b.groupId))).toEqual(new Set([g.groupId]));

    // 4e caddie indisponible → le groupe entier est refusé.
    const more = ['08:18', '08:24'].map((t) => ({ courseId: f.courseId, startsAt: at(t), players: 2, holes: 18 as const }));
    await expect(createGroupBooking(d, { ...staff, channel: 'group' }, more)).rejects.toMatchObject({ code: 'CADDIE_UNAVAILABLE' });
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id WHERE t.club_id = $1`,
      [f.clubId],
    );
    expect(rows[0].n).toBe(3);
  });
});

describe('fenêtre de réservation client', () => {
  it('refuse les départs passés et au-delà de l’horizon pour le web', async () => {
    const f = await createClub(db);
    await expect(
      createBooking(deps(db, new Date('2030-06-10T09:00:00Z')), web, {
        courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18,
      }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
    await expect(
      createBooking(deps(db, new Date('2030-01-01T06:00:00Z')), web, {
        courseId: f.courseId, startsAt: at('08:00'), players: 2, holes: 18,
      }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });
});

describe('historique', () => {
  it('journalise création, déplacement et annulation sans données personnelles', async () => {
    const f = await createClub(db);
    const a = await book(f, '08:00', 2, { customer: { lastName: 'Secret', email: 'secret@example.com' } });
    await moveBooking(d, a.booking.id, { courseId: f.courseId, startsAt: at('09:00') }, { actor: staff.actor });
    await cancelBooking(d, a.booking.id, { actor: staff.actor, reason: 'météo' });
    const { rows } = await db.query(`SELECT action, data FROM audit_log WHERE entity_id = $1 ORDER BY id`, [a.booking.id]);
    expect(rows.map((r) => r.action)).toEqual(['booking.created', 'booking.moved', 'booking.cancelled']);
    expect(JSON.stringify(rows)).not.toMatch(/secret/i);
  });
});
