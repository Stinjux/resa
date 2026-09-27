// Données de démonstration : 4 golfs fictifs au Maroc avec tarifs, caddies,
// matériel, comptes par rôle et réservations d'exemple. Tout est modifiable :
// aucune de ces valeurs n'est lue par le code métier en dehors de la base.
//
// ⚠️ Mots de passe de démonstration : à ne jamais utiliser en production.

import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { loadConfig } from '../config.js';
import { createPool, withTransaction, type Db } from './pool.js';
import { createStaffUser, registerCustomer } from '../modules/auth/service.js';
import { createAllotment, createPartnerUser, savePartner } from '../modules/partners/service.js';
import { createMembership } from '../modules/members/service.js';
import { createBooking, createGroupBooking, moveBooking } from '../modules/booking/service.js';
import { recordStaffPayment } from '../modules/orders/service.js';
import { assignCaddie, assignUnits } from '../modules/starter/service.js';
import { getAvailability } from '../modules/teesheet/service.js';
import { getClub, getCourse } from '../modules/catalog/repository.js';
import { receiveInbound } from '../modules/messaging/service.js';
import { quoteNewBooking } from '../modules/pricing/service.js';

export const DEMO_PASSWORD = 'Demo2026!';

const GOLFS = [
  // Green fee 18 trous en MAD, TTC. Environ 1 300 MAD, variable selon le golf.
  { code: 'G1', name: 'Golf démo Marrakech', greenFee18: 1300 },
  { code: 'G2', name: 'Golf démo Casablanca', greenFee18: 1250 },
  { code: 'G3', name: 'Golf démo Rabat', greenFee18: 1200 },
  { code: 'G4', name: 'Golf démo Agadir', greenFee18: 1350 },
];

const MAD = (amount: number) => amount * 100; // unités mineures (centimes)

async function seedConfig(db: Db): Promise<{ orgId: string; clubs: Array<{ id: string; code: string; courseId: string }> }> {
  return withTransaction(db, async (tx) => {
    const org = await tx.query(
      `INSERT INTO organizations (code, name) VALUES ('DEMO-MA', 'Golfs du Maroc (démo)') RETURNING id`,
    );
    const orgId: string = org.rows[0].id;
    const clubs = [];
    const inTwoWeeks = DateTime.now().setZone('Africa/Casablanca').plus({ days: 14 }).toISODate();

    for (const g of GOLFS) {
      const club = await tx.query(
        `INSERT INTO clubs (organization_id, code, name, timezone, currency, default_locale, country_code,
                            prices_include_tax, tax_rate_bp, default_caddie_payment,
                            legal_name, legal_address, ice, tax_id, trade_register, patente, contact_phone)
         VALUES ($1, $2, $3, 'Africa/Casablanca', 'MAD', 'fr', 'MA', true, 2000, 'on_site',
                 $4, $5, $6, 'IF-DEMO', 'RC-DEMO', 'TP-DEMO', '+212 5 00 00 00 00') RETURNING id`,
        // Mentions légales fictives (démonstration) : à remplacer par les vraies.
        [orgId, g.code, g.name, `${g.name} SARL (démo)`, `Adresse de démonstration, ${g.name.replace('Golf démo ', '')}, Maroc`,
          `00000000000000${GOLFS.indexOf(g) + 1}`],
      );
      const clubId: string = club.rows[0].id;
      const course = await tx.query(
        `INSERT INTO courses (club_id, code, name) VALUES ($1, 'MAIN', 'Parcours 18 trous') RETURNING id`,
        [clubId],
      );
      const courseId: string = course.rows[0].id;
      if (g.code === 'G1') {
        await tx.query(
          `INSERT INTO courses (club_id, code, name, allowed_holes, default_interval_minutes, play_minutes_9)
           VALUES ($1, 'PITCH', 'Parcours 9 trous (académie)', '{9}', 10, 120)`,
          [clubId],
        );
      }

      // Grille : ouverture quotidienne + exemples d'exceptions.
      await tx.query(
        `INSERT INTO schedule_rules (club_id, course_id, name, kind, valid_from, valid_to, weekdays, start_time, end_time,
                                     interval_minutes, max_players, priority)
         VALUES ($1, NULL, 'Ouverture quotidienne', 'open', NULL, NULL, NULL, '07:00', '17:00', NULL, NULL, 0),
                ($1, NULL, 'Horaires d''été (juin–septembre)', 'open', '2026-06-01', '2026-09-30', NULL, '06:30', '18:00', NULL, NULL, 1),
                ($1, NULL, 'Week-end : intervalle 8 min le matin', 'open', NULL, NULL, '{6,7}', '07:00', '10:00', 8, NULL, 2),
                ($1, $2,   'Compétition du club (fermé au public)', 'closed', $3, $3, NULL, '08:00', '13:00', NULL, NULL, 10)`,
        [clubId, courseId, inTwoWeeks],
      );
      if (g.code === 'G3') {
        await tx.query(
          `INSERT INTO schedule_rules (club_id, name, kind, weekdays, start_time, end_time, priority)
           VALUES ($1, 'Entretien du lundi matin', 'closed', '{1}', '06:00', '09:00', 5)`,
          [clubId],
        );
      }

      // Tarifs (TTC). Le plus prioritaire puis le plus spécifique l'emporte.
      const gf18 = g.greenFee18;
      const gf9 = Math.round((gf18 * 0.58) / 10) * 10;
      await tx.query(
        `INSERT INTO tariffs (club_id, product, name, holes, customer_category, weekdays, start_time, end_time,
                              amount_minor, basis, priority)
         VALUES ($1, 'green_fee', 'Green fee 18 trous', 18, NULL, NULL, NULL, NULL, $2, 'per_player', 0),
                ($1, 'green_fee', 'Green fee 18 trous week-end', 18, NULL, '{6,7}', NULL, NULL, $3, 'per_player', 0),
                ($1, 'green_fee', 'Green fee 18 trous twilight (après 15h)', 18, NULL, NULL, '15:00', '23:59', $4, 'per_player', 1),
                ($1, 'green_fee', 'Green fee 9 trous', 9, NULL, NULL, NULL, NULL, $5, 'per_player', 0),
                ($1, 'green_fee', 'Green fee 9 trous week-end', 9, NULL, '{6,7}', NULL, NULL, $6, 'per_player', 0),
                ($1, 'green_fee', 'Green fee 9 trous twilight (après 15h)', 9, NULL, NULL, '15:00', '23:59', $7, 'per_player', 1),
                ($1, 'green_fee', 'Green fee 18 trous résident', 18, 'resident', NULL, NULL, NULL, $8, 'per_player', 2),
                ($1, 'green_fee', 'Green fee 9 trous résident', 9, 'resident', NULL, NULL, NULL, $9, 'per_player', 2),
                ($1, 'green_fee', 'Green fee 18 trous tour-opérateur', 18, 'to', NULL, NULL, NULL, $11, 'per_player', 2),
                ($1, 'green_fee', 'Green fee membre (inclus dans l''abonnement)', NULL, 'member', NULL, NULL, NULL, 0, 'per_player', 3),
                ($1, 'green_fee', 'Green fee 9 trous tour-opérateur', 9, 'to', NULL, NULL, NULL, $12, 'per_player', 2),
                ($1, 'private_surcharge', 'Supplément départ privé', NULL, NULL, NULL, NULL, NULL, $10, 'per_booking', 0)`,
        [clubId, MAD(gf18), MAD(gf18 + 150), MAD(Math.round(gf18 * 0.7 / 10) * 10), MAD(gf9), MAD(gf9 + 100),
          MAD(Math.round(gf9 * 0.7 / 10) * 10), MAD(900), MAD(550), MAD(1000),
          MAD(Math.round(gf18 * 0.8 / 10) * 10), MAD(Math.round(gf9 * 0.8 / 10) * 10)],
      );

      // Caddies et matériel.
      const rts = await tx.query(
        `INSERT INTO resource_types
           (club_id, code, kind, name, variant, scope, required_per_tee_time, total_quantity,
            price_9_minor, price_18_minor, buffer_minutes, max_per_booking, sort_order)
         VALUES
           ($1, 'CADDIE',       'caddie',     'Caddie',                          NULL,          'tee_time', true,  12, $2, $3, 15, NULL, 0),
           ($1, 'CART',         'cart',       'Voiturette',                      NULL,          'booking',  false, 20, $4, $5, 15, 2, 10),
           ($1, 'TROLLEY',      'trolley',    'Chariot',                         NULL,          'booking',  false, 30, $6, $7, 0, 4, 20),
           ($1, 'BAG_MEN_RH',   'rental_bag', 'Sac de location homme droitier',  'men_right',   'booking',  false, 6, $8, $9, 0, 4, 30),
           ($1, 'BAG_MEN_LH',   'rental_bag', 'Sac de location homme gaucher',   'men_left',    'booking',  false, 2, $8, $9, 0, 4, 31),
           ($1, 'BAG_WOMEN_RH', 'rental_bag', 'Sac de location femme droitière', 'women_right', 'booking',  false, 4, $8, $9, 0, 4, 32),
           ($1, 'BAG_WOMEN_LH', 'rental_bag', 'Sac de location femme gauchère',  'women_left',  'booking',  false, 2, $8, $9, 0, 4, 33)
         RETURNING id, code, total_quantity AS qty`,
        [clubId, MAD(100), MAD(200), MAD(250), MAD(400), MAD(30), MAD(50), MAD(200), MAD(300)],
      );
      const prefixes: Record<string, string> = {
        CART: 'V', TROLLEY: 'C', BAG_MEN_RH: 'HD', BAG_MEN_LH: 'HG', BAG_WOMEN_RH: 'FD', BAG_WOMEN_LH: 'FG',
      };
      for (const rt of rts.rows) {
        const prefix = prefixes[rt.code];
        if (!prefix) continue;
        for (let i = 1; i <= rt.qty; i++) {
          await tx.query(`INSERT INTO resource_units (resource_type_id, label) VALUES ($1, $2)`, [
            rt.id, `${prefix}-${String(i).padStart(2, '0')}`,
          ]);
        }
      }
      for (let i = 1; i <= 12; i++) {
        await tx.query(`INSERT INTO caddies (club_id, display_name) VALUES ($1, $2)`, [
          clubId, `Caddie ${g.code}-${String(i).padStart(2, '0')}`,
        ]);
      }
      clubs.push({ id: clubId, code: g.code, courseId });
    }
    return { orgId, clubs };
  });
}

async function seedUsers(db: Db, orgId: string, clubs: Array<{ id: string; code: string }>) {
  await createStaffUser(db, {
    organizationId: orgId, email: 'admin@demo.ma', password: DEMO_PASSWORD, displayName: 'Administrateur groupe',
    roles: [{ clubId: null, role: 'org_admin' }],
  });
  for (const c of clubs) {
    const k = c.code.toLowerCase();
    await createStaffUser(db, { organizationId: orgId, email: `direction.${k}@demo.ma`, password: DEMO_PASSWORD,
      displayName: `Direction ${c.code}`, roles: [{ clubId: c.id, role: 'club_admin' }] });
    await createStaffUser(db, { organizationId: orgId, email: `reception.${k}@demo.ma`, password: DEMO_PASSWORD,
      displayName: `Réception ${c.code}`, roles: [{ clubId: c.id, role: 'receptionist' }] });
    await createStaffUser(db, { organizationId: orgId, email: `starter.${k}@demo.ma`, password: DEMO_PASSWORD,
      displayName: `Starter ${c.code}`, roles: [{ clubId: c.id, role: 'starter' }] });
  }
  await registerCustomer(db, { organizationId: orgId, email: 'client@demo.ma', password: DEMO_PASSWORD,
    firstName: 'Karim', lastName: 'Client démo', phone: '+212600000000' });
}

/** Réservations d'exemple sur les 3 prochains jours du golf G1. */
async function seedBookings(db: Db, club: { id: string; courseId: string }) {
  const deps = { db, now: () => new Date() };
  const actor = { type: 'system' as const };
  const staff = { channel: 'phone' as const, actor };
  const day = (n: number) => DateTime.now().setZone('Africa/Casablanca').plus({ days: n }).toISODate()!;
  const slotsOn = async (date: string, holes: 9 | 18 = 18) =>
    (await getAvailability(db, { courseId: club.courseId, date, players: 4, holes, now: new Date(), enforceBookingWindow: false })).slots;
  const pick = (slots: Array<{ startsAt: string; localTime: string }>, time: string) =>
    new Date((slots.find((s) => s.localTime >= time) ?? slots[0]!).startsAt);

  const d1 = await slotsOn(day(1));
  // 1. Réservation téléphonique, 2 joueurs, voiturette, caddie payé sur place.
  const a = await createBooking(deps, { ...staff, customer: { firstName: 'Youssef', lastName: 'Alami', phone: '+212611111111' } }, {
    courseId: club.courseId, startsAt: pick(d1, '08:00'), players: 2, holes: 18,
    playerNames: ['Youssef Alami', 'Sara Alami'], options: [{ code: 'CART', quantity: 1 }],
  });
  // 2. Réservation web, 2 joueurs, caddie payé avec la réservation, puis réunie avec la n°1.
  const b = await createBooking(deps, { channel: 'web', actor, customer: { firstName: 'John', lastName: 'Smith', email: 'john.smith@example.com' } }, {
    courseId: club.courseId, startsAt: pick(d1, '08:30'), players: 2, holes: 18, caddiePayment: 'with_booking',
    options: [{ code: 'BAG_MEN_RH', quantity: 1 }, { code: 'TROLLEY', quantity: 2 }],
  });
  await moveBooking(deps, b.booking.id, { teeTimeId: a.booking.teeTime.id }, { actor });
  // 3. Départ privé, 3 joueurs.
  const privateBooking = await createBooking(deps, { ...staff, customer: { firstName: 'Nadia', lastName: 'Benjelloun', phone: '+212622222222' } }, {
    courseId: club.courseId, startsAt: pick(d1, '09:00'), players: 3, holes: 18, isPrivate: true,
    options: [{ code: 'CART', quantity: 2 }],
  });
  // 4. 9 trous, 1 joueur, tarif résident, l'après-midi (twilight).
  await createBooking(deps, { ...staff, customer: { firstName: 'Omar', lastName: 'Tazi', phone: '+212633333333' } }, {
    courseId: club.courseId, startsAt: pick(d1, '15:30'), players: 1, holes: 9, customerCategory: 'resident',
  });

  // 5. Groupe de 8 joueurs sur deux départs consécutifs.
  const d2 = await slotsOn(day(2));
  const first = d2.findIndex((s) => s.localTime >= '10:00');
  await createGroupBooking(deps, { channel: 'group', actor, customer: { lastName: 'Association Golf Loisirs (démo)', email: 'contact@example.com' } },
    [first, first + 1].map((i) => ({ courseId: club.courseId, startsAt: new Date(d2[i]!.startsAt), players: 4, holes: 18 as const,
      options: [{ code: 'TROLLEY', quantity: 4 }] })));

  // 6. Starter : caddie nommé et voiturette n° attribués sur le départ réuni.
  const caddie = await db.query(`SELECT id FROM caddies WHERE club_id = $1 ORDER BY display_name LIMIT 1`, [club.id]);
  await assignCaddie(db, a.booking.teeTime.id, caddie.rows[0].id, actor);
  const cart = await db.query(
    `SELECT a.id, (SELECT u.id FROM resource_units u WHERE u.resource_type_id = a.resource_type_id ORDER BY u.label LIMIT 1) AS unit
       FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id
      WHERE a.booking_id = $1 AND rt.code = 'CART' AND a.status = 'active'`,
    [a.booking.id],
  );
  await assignUnits(db, cart.rows[0].id, [cart.rows[0].unit], actor);

  // 7. Règlements : John Smith a tout payé par carte ; Nadia Benjelloun a versé un acompte en espèces.
  const due = async (id: string) => (await db.query('SELECT total_minor FROM orders WHERE booking_id = $1', [id])).rows[0].total_minor;
  await recordStaffPayment(db, b.booking.id, { amountMinor: await due(b.booking.id), method: 'card_terminal', note: 'Payé à la réservation' }, actor);
  await recordStaffPayment(db, privateBooking.booking.id, { amountMinor: 200000, method: 'cash', note: 'Acompte' }, actor);
}

/** Une demande WhatsApp en attente de validation (comme si l'IA l'avait préparée). */
async function seedWhatsAppRequest(db: Db, club: { id: string; courseId: string }) {
  const tomorrow = DateTime.now().setZone('Africa/Casablanca').plus({ days: 1 }).toISODate()!;
  const { slots } = await getAvailability(db, { courseId: club.courseId, date: tomorrow, players: 3, holes: 18, now: new Date(), enforceBookingWindow: false });
  const slot = slots.find((s) => s.localTime >= '11:00') ?? slots[0]!;
  const { threadId } = await receiveInbound(db, club.id, 'local', {
    channel: 'whatsapp', from: '0661234567', to: null, fromName: 'Mehdi Alaoui', text: 'Salam, 3 joueurs demain vers 11h en 18 trous svp. Mehdi Alaoui',
    providerMessageId: 'seed-whatsapp-1', receivedAt: new Date(),
  });
  await db.query(`UPDATE messages SET status = 'processed' WHERE thread_id = $1`, [threadId]);
  await db.query(`INSERT INTO messages (thread_id, direction, author, body, status) VALUES ($1, 'out', 'ai', $2, 'sent')`,
    [threadId, `Merci Mehdi ! Un départ est libre à ${slot.localTime} pour 3 joueurs en 18 trous. Votre demande est transmise au golf pour validation.`]);
  const clubRow = await getClub(db, club.id);
  const course = await getCourse(db, club.courseId);
  const q = await quoteNewBooking(db, { club: clubRow, course, startsAt: new Date(slot.startsAt), players: 3, holes: 18, isPrivate: false,
    customerCategory: 'standard', caddiePayment: clubRow.defaultCaddiePayment, options: [] });
  await db.query(`INSERT INTO booking_requests (club_id, thread_id, payload, summary) VALUES ($1, $2, $3, $4)`, [club.id, threadId,
    { customer: { firstName: 'Mehdi', lastName: 'Alaoui' }, language: 'fr', notes: null,
      items: [{ courseId: course.id, startsAt: slot.startsAt, players: 3, holes: 18 }] },
    { club: clubRow.name, currency: clubRow.currency, customer: 'Mehdi Alaoui', channel: 'whatsapp', notes: null, totalMinor: q.totalMinor,
      teeTimes: [{ course: course.name, date: tomorrow, time: slot.localTime, players: 3, holes: 18, totalMinor: q.totalMinor }] }]);
  await db.query(`UPDATE message_threads SET locale = 'fr' WHERE id = $1`, [threadId]);
}

/** Tour-opérateur de démonstration : tarifs « to », allotement sur G1, accès au portail. */
async function seedPartner(db: Db, orgId: string, club: { id: string; courseId: string }) {
  const actor = { type: 'system' as const };
  const partner = await savePartner(db, orgId, null, {
    code: 'ATLAS', name: 'Atlas Golf Tours (démo)', kind: 'tour_operator', priceCategory: 'to', onAccount: true, paymentTermsDays: 30,
    contactName: 'Service groupes', email: 'groupes@atlas-golf.example', legalName: 'Atlas Golf Tours SARL (démo)',
    address: 'Adresse de démonstration, Marrakech', ice: '000000000000099',
  }, actor);
  await createPartnerUser(db, partner.id, { email: 'partenaire@demo.ma', displayName: 'Agent Atlas', password: DEMO_PASSWORD }, actor);
  const day = (n: number) => DateTime.now().setZone('Africa/Casablanca').plus({ days: n }).toISODate()!;
  await createAllotment(db, club.id, { partnerId: partner.id, courseId: club.courseId, dateFrom: day(2), dateTo: day(30),
    startTime: '08:00', endTime: '08:30', releaseDays: 2, note: 'Contrat saison (démo)' }, actor, new Date());
  const slot = (await getAvailability(db, { courseId: club.courseId, date: day(3), players: 4, holes: 18, now: new Date(),
    enforceBookingWindow: false, partnerId: partner.id })).slots.find((s) => s.heldForPartner);
  if (slot) {
    await createBooking({ db, now: () => new Date() }, { channel: 'partner', actor, partnerId: partner.id, partnerReference: 'ATL-24017',
      customer: { firstName: 'Hans', lastName: 'Becker' } }, { courseId: club.courseId, startsAt: new Date(slot.startsAt), players: 4, holes: 18,
      playerNames: ['Hans Becker', 'Anna Becker', 'Peter Schulz', 'Eva Schulz'] });
  }
}

/** Membres, profils golfeurs (index), parties ouvertes à venir et historique. */
async function seedMembers(db: Db, orgId: string, clubs: Array<{ id: string; code: string; courseId: string }>) {
  const actor = { type: 'system' as const };
  const tz = 'Africa/Casablanca';
  const today = DateTime.now().setZone(tz);
  for (const c of clubs) {
    await db.query(`INSERT INTO membership_plans (club_id, code, name, price_category, booking_horizon_days, annual_fee_minor)
                    VALUES ($1, 'ANNUEL', 'Membre annuel', 'member', 30, $2)`, [c.id, MAD(28000)]);
  }
  const g1 = clubs[0]!;
  const plan = (await db.query(`SELECT id FROM membership_plans WHERE club_id = $1`, [g1.id])).rows[0].id;
  const golfer = async (first: string, last: string, hcp: number, share = true) => (await db.query(
    `INSERT INTO customers (organization_id, first_name, last_name, handicap_index, share_profile) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, first, last, hcp, share])).rows[0].id as string;
  const me = (await db.query(`SELECT customer_id FROM users WHERE email = 'client@demo.ma'`)).rows[0].customer_id as string;
  await db.query(`UPDATE customers SET handicap_index = 18.4, share_profile = true, licence_number = 'FRMG-DEMO-001' WHERE id = $1`, [me]);
  const karim = await golfer('Karim', 'Benali', 12.4);
  const leila = await golfer('Leila', 'Chraibi', 24.1);
  const hamza = await golfer('Hamza', 'Idrissi', 6.8);
  const anon = await golfer('Sara', 'Discrète', 30, false);
  for (const [who, card] of [[me, 'G1-M-0001'], [karim, 'G1-M-0002'], [hamza, 'G1-M-0003']] as const) {
    await createMembership(db, { id: g1.id, organizationId: orgId }, { customerId: who, planId: plan, cardNumber: card,
      validFrom: today.startOf('year').toISODate()!, validTo: today.endOf('year').toISODate()! }, actor);
  }
  const at = (days: number, time: string) => DateTime.fromISO(`${today.plus({ days }).toISODate()}T${time}`, { zone: tz }).toJSDate();
  const book = async (customerId: string, days: number, time: string, players: number, open = false, note: string | null = null, holes: 9 | 18 = 18) => {
    const now = days < 0 ? at(days - 1, '12:00') : new Date(); // parties passées : réservées « la veille »
    try {
      return await createBooking({ db, now: () => now }, { channel: 'phone', actor, customerId },
        { courseId: g1.courseId, startsAt: at(days, time), players, holes, isOpen: open, openNote: note });
    } catch { return null; } // créneau déjà pris dans les données de démo : on ignore
  };
  // Parties ouvertes à venir.
  await book(karim, 2, '09:30', 2, true, 'Partie amicale, tous niveaux');
  await book(anon, 2, '09:30', 1);
  await book(leila, 3, '10:30', 1, true, 'Cherche partenaires pour un 18 trous tranquille');
  await book(hamza, 5, '07:30', 2, true, 'Rythme soutenu, index < 15 idéalement');
  await book(me, 4, '11:00', 2, true);
  // Historique du client de démo, avec ses partenaires de jeu.
  for (const [days, time, others] of [[-3, '08:30', [karim]], [-10, '09:00', [leila, anon]], [-24, '14:00', [hamza]]] as const) {
    const b = await book(me, days, time, 1);
    for (const o of others) await book(o, days, time, 1);
    if (b) await db.query(`UPDATE bookings SET checkin_status = 'arrived' WHERE tee_time_id = $1`, [b.booking.teeTime.id]);
  }
}

export async function seedDemo(db: Db): Promise<boolean> {
  const existing = await db.query(`SELECT 1 FROM organizations WHERE code = 'DEMO-MA'`);
  if (existing.rowCount) return false;
  const { orgId, clubs } = await seedConfig(db);
  await seedUsers(db, orgId, clubs);
  // G1 : adaptateur de caisse local, pour voir la synchronisation fonctionner.
  await db.query(`UPDATE clubs SET pos_provider = 'local', messaging_provider = 'local' WHERE id = $1`, [clubs[0]!.id]);
  await seedBookings(db, clubs[0]!);
  await seedWhatsAppRequest(db, clubs[0]!);
  await seedPartner(db, orgId, clubs[0]!);
  await seedMembers(db, orgId, clubs);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool(loadConfig().databaseUrl);
  seedDemo(db)
    .then((created) => {
      if (!created) return console.log('Données de démo déjà présentes.');
      console.log(`Seed OK. Comptes (mot de passe « ${DEMO_PASSWORD} ») :
  admin@demo.ma            administrateur des 4 golfs
  direction.g1@demo.ma     direction du golf G1 (idem g2…g4)
  reception.g1@demo.ma     réception G1
  starter.g1@demo.ma       starter G1
  client@demo.ma           client
  partenaire@demo.ma       portail du tour-opérateur Atlas (démo)`);
    })
    .finally(() => db.end());
}
