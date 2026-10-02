// Membres et espace golfeur : abonnements, profil (handicap, licence),
// parties ouvertes, historique des parties.
//
// Confidentialité : un golfeur n'apparaît aux autres (nom abrégé et handicap)
// que s'il l'a accepté dans son profil ; sinon il est affiché « Golfeur ».
// Téléphone et e-mail ne sont jamais montrés aux autres golfeurs.

import { DateTime } from 'luxon';
import type { Db, Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { audit, type Actor } from '../../shared/audit.js';
import { DomainError } from '../../shared/errors.js';
import { instantToLocal } from '../../shared/time.js';

// ---------------------------------------------------------------------------
// Profil

export interface ProfilePatch {
  firstName?: string | null; lastName?: string; phone?: string | null; preferredLocale?: string | null;
  handicapIndex?: number | null; licenceNumber?: string | null; shareProfile?: boolean;
}
const PROFILE_COLUMNS: Record<keyof ProfilePatch, string> = {
  firstName: 'first_name', lastName: 'last_name', phone: 'phone', preferredLocale: 'preferred_locale',
  handicapIndex: 'handicap_index', licenceNumber: 'licence_number', shareProfile: 'share_profile',
};

export async function getProfile(q: Queryable, customerId: string) {
  const { rows } = await q.query(
    `SELECT c.id, c.first_name AS "firstName", c.last_name AS "lastName", c.email, c.phone, c.preferred_locale AS "preferredLocale",
            c.handicap_index::float AS "handicapIndex", c.licence_number AS "licenceNumber", c.share_profile AS "shareProfile"
       FROM customers c WHERE c.id = $1`,
    [customerId],
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Profil introuvable.');
  const memberships = await q.query(
    `SELECT m.id, cl.name AS "clubName", p.name AS "planName", m.card_number AS "cardNumber",
            to_char(m.valid_from, 'YYYY-MM-DD') AS "validFrom", to_char(m.valid_to, 'YYYY-MM-DD') AS "validTo", m.status,
            (m.status = 'active' AND (now() AT TIME ZONE cl.timezone)::date BETWEEN m.valid_from AND m.valid_to) AS current
       FROM memberships m JOIN membership_plans p ON p.id = m.plan_id JOIN clubs cl ON cl.id = m.club_id
      WHERE m.customer_id = $1 ORDER BY m.valid_to DESC`,
    [customerId],
  );
  return { ...rows[0], memberships: memberships.rows };
}

export async function updateProfile(q: Queryable, customerId: string, patch: ProfilePatch, actor: Actor) {
  const entries = Object.entries(patch).filter(([k, v]) => k in PROFILE_COLUMNS && v !== undefined) as Array<[keyof ProfilePatch, unknown]>;
  if (entries.length) {
    await q.query(
      `UPDATE customers SET ${entries.map(([k], i) => `${PROFILE_COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [customerId, ...entries.map(([, v]) => v)],
    );
    await audit(q, { clubId: null, actor, action: 'customer.profile_updated', entityType: 'customer', entityId: customerId,
      data: { fields: entries.map(([k]) => k) } });
  }
  return getProfile(q, customerId);
}

/** Nom montré aux autres golfeurs : « Karim B. » si le golfeur l'accepte. */
const PUBLIC_PLAYER = (alias: string) => `
  CASE WHEN ${alias}.share_profile THEN trim(coalesce(${alias}.first_name, '') || ' ' || left(${alias}.last_name, 1) || '.') END`;

// ---------------------------------------------------------------------------
// Parties ouvertes

/** Départs à venir où au moins un joueur a ouvert sa partie et où il reste de la place. */
export async function openGames(q: Queryable, viewer: { organizationId: string; customerId: string }, opts: { clubId?: string | null; now: Date; days?: number }) {
  const days = Math.min(Math.max(opts.days ?? 14, 1), 60);
  const { rows } = await q.query(
    `SELECT t.id AS "teeTimeId", t.starts_at AS "startsAt", t.course_id AS "courseId", co.name AS "courseName", cl.id AS "clubId",
            cl.name AS "clubName", cl.timezone, t.holes, t.max_players AS "maxPlayers",
            coalesce(sum(b.players), 0)::int AS "bookedPlayers",
            bool_or(b.customer_id = $2) AS "joined",
            json_agg(json_build_object(
              'players', b.players, 'isOpen', b.is_open, 'note', b.open_note, 'mine', b.customer_id = $2,
              'name', ${PUBLIC_PLAYER('cu')},
              'handicapIndex', CASE WHEN cu.share_profile THEN cu.handicap_index::float END
            ) ORDER BY b.created_at) AS bookings
       FROM tee_times t JOIN courses co ON co.id = t.course_id JOIN clubs cl ON cl.id = t.club_id
       JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed' LEFT JOIN customers cu ON cu.id = b.customer_id
      WHERE cl.organization_id = $1 AND ($3::uuid IS NULL OR cl.id = $3)
        AND t.starts_at > $4::timestamptz + make_interval(mins => cl.min_lead_minutes) AND t.starts_at < $4::timestamptz + make_interval(days => $5)
        AND t.blocked_reason IS NULL AND NOT t.is_private
      GROUP BY t.id, co.name, cl.id
     HAVING bool_or(b.is_open) AND coalesce(sum(b.players), 0) < t.max_players
      ORDER BY t.starts_at`,
    [viewer.organizationId, viewer.customerId, opts.clubId ?? null, opts.now, days],
  );
  return rows.map((r) => {
    const local = instantToLocal(r.startsAt, r.timezone);
    const known = (r.bookings as Array<{ handicapIndex: number | null; players: number }>).filter((b) => b.handicapIndex !== null);
    return {
      teeTimeId: r.teeTimeId, startsAt: r.startsAt.toISOString(), date: local.date, localTime: local.time,
      clubId: r.clubId, clubName: r.clubName, courseId: r.courseId, courseName: r.courseName, holes: r.holes,
      remaining: r.maxPlayers - r.bookedPlayers, maxPlayers: r.maxPlayers, joined: r.joined,
      averageHandicap: known.length ? Math.round((known.reduce((n, b) => n + b.handicapIndex!, 0) / known.length) * 10) / 10 : null,
      bookings: r.bookings,
    };
  });
}

/** Ouvrir / fermer sa propre partie. */
export async function setBookingOpen(db: Db, customerId: string, bookingId: string, input: { isOpen: boolean; openNote?: string | null }, actor: Actor) {
  await withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE bookings SET is_open = $3, open_note = CASE WHEN $3 THEN $4 END, updated_at = now()
        WHERE id = $1 AND customer_id = $2 AND status = 'confirmed' AND NOT is_private RETURNING club_id, reference`,
      [bookingId, customerId, input.isOpen, input.openNote?.trim().slice(0, 200) || null],
    );
    if (!rows[0]) throw new DomainError('NOT_FOUND', 'Réservation introuvable (ou départ privé).');
    await audit(tx, { clubId: rows[0].club_id, actor, action: input.isOpen ? 'booking.opened' : 'booking.closed', entityType: 'booking', entityId: bookingId,
      data: { reference: rows[0].reference } });
  });
}

// ---------------------------------------------------------------------------
// Historique des parties

export async function myRounds(q: Queryable, customerId: string, now: Date) {
  const { rows } = await q.query(
    `SELECT b.id, b.reference, b.status, b.players, b.holes, b.is_open AS "isOpen", b.open_note AS "openNote", b.is_private AS "isPrivate",
            b.checkin_status AS "checkinStatus", t.starts_at AS "startsAt", t.id AS "teeTimeId", co.name AS "courseName", cl.name AS "clubName",
            cl.timezone, b.total_minor AS "totalMinor", b.currency,
            coalesce((SELECT json_agg(json_build_object('players', o.players, 'name', ${PUBLIC_PLAYER('oc')},
                        'handicapIndex', CASE WHEN oc.share_profile THEN oc.handicap_index::float END) ORDER BY o.created_at)
                        FROM bookings o LEFT JOIN customers oc ON oc.id = o.customer_id
                       WHERE o.tee_time_id = t.id AND o.id <> b.id AND o.status = 'confirmed'), '[]') AS companions
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN courses co ON co.id = t.course_id JOIN clubs cl ON cl.id = b.club_id
      WHERE b.customer_id = $1 ORDER BY t.starts_at DESC LIMIT 300`,
    [customerId],
  );
  const rounds = rows.map((r) => {
    const local = instantToLocal(r.startsAt, r.timezone);
    return { ...r, startsAt: r.startsAt.toISOString(), date: local.date, localTime: local.time };
  });
  const upcoming = rounds.filter((r) => r.status === 'confirmed' && new Date(r.startsAt) > now).reverse();
  const past = rounds.filter((r) => new Date(r.startsAt) <= now || r.status === 'cancelled');
  const played = past.filter((r) => r.status === 'confirmed' && r.checkinStatus !== 'no_show');
  const yearAgo = DateTime.fromJSDate(now).minus({ years: 1 }).toJSDate();
  const lastYear = played.filter((r) => new Date(r.startsAt) >= yearAgo);
  return {
    upcoming, past,
    stats: {
      roundsLast12Months: lastYear.length,
      rounds18: lastYear.filter((r) => r.holes === 18).length,
      rounds9: lastYear.filter((r) => r.holes === 9).length,
      courses: [...new Set(lastYear.map((r) => r.courseName))].length,
    },
  };
}

// ---------------------------------------------------------------------------
// Administration des membres (direction, réception)

export async function listMembers(q: Queryable, clubId: string, search?: string) {
  const { rows } = await q.query(
    `SELECT m.id, m.customer_id AS "customerId", c.first_name AS "firstName", c.last_name AS "lastName", c.email, c.phone,
            c.handicap_index::float AS "handicapIndex", c.licence_number AS "licenceNumber",
            m.plan_id AS "planId", p.name AS "planName", m.card_number AS "cardNumber",
            to_char(m.valid_from, 'YYYY-MM-DD') AS "validFrom", to_char(m.valid_to, 'YYYY-MM-DD') AS "validTo", m.status, m.notes,
            (m.status = 'active' AND (now() AT TIME ZONE cl.timezone)::date BETWEEN m.valid_from AND m.valid_to) AS current,
            (SELECT count(*)::int FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id
              WHERE b.customer_id = m.customer_id AND b.club_id = m.club_id AND b.status = 'confirmed'
                AND t.local_date BETWEEN m.valid_from AND least(m.valid_to, (now() AT TIME ZONE cl.timezone)::date)) AS "roundsThisPeriod"
       FROM memberships m JOIN customers c ON c.id = m.customer_id JOIN membership_plans p ON p.id = m.plan_id JOIN clubs cl ON cl.id = m.club_id
      WHERE m.club_id = $1 AND ($2::text IS NULL OR concat_ws(' ', c.first_name, c.last_name, c.email, c.phone, m.card_number) ILIKE '%' || $2 || '%')
      ORDER BY c.last_name, c.first_name, m.valid_to DESC`,
    [clubId, search?.trim() || null],
  );
  return rows;
}

export interface MembershipInput {
  customerId?: string; customer?: { firstName?: string | null; lastName: string; email?: string | null; phone?: string | null };
  planId: string; cardNumber?: string | null; validFrom: string; validTo: string; notes?: string | null; handicapIndex?: number | null;
}

export async function createMembership(db: Db, club: { id: string; organizationId: string }, input: MembershipInput, actor: Actor) {
  try {
    return await withTransaction(db, async (tx) => {
      const plan = await tx.query('SELECT 1 FROM membership_plans WHERE id = $1 AND club_id = $2', [input.planId, club.id]);
      if (!plan.rowCount) throw new DomainError('VALIDATION', 'Formule inconnue pour ce golf.');
      if (input.validTo < input.validFrom) throw new DomainError('VALIDATION', 'Période de validité invalide.');
      let customerId = input.customerId ?? null;
      if (customerId) {
        const c = await tx.query('SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2', [customerId, club.organizationId]);
        if (!c.rowCount) throw new DomainError('NOT_FOUND', 'Golfeur introuvable.');
      } else if (input.customer) {
        const c = input.customer;
        customerId = (await tx.query(
          `INSERT INTO customers (organization_id, first_name, last_name, email, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [club.organizationId, c.firstName ?? null, c.lastName, c.email ?? null, c.phone ?? null])).rows[0].id;
      } else {
        throw new DomainError('VALIDATION', 'Golfeur requis.');
      }
      if (input.handicapIndex !== undefined) await tx.query('UPDATE customers SET handicap_index = $2 WHERE id = $1', [customerId, input.handicapIndex]);
      const { rows } = await tx.query(
        `INSERT INTO memberships (club_id, customer_id, plan_id, card_number, valid_from, valid_to, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [club.id, customerId, input.planId, input.cardNumber?.trim() || null, input.validFrom, input.validTo, input.notes ?? null],
      );
      await audit(tx, { clubId: club.id, actor, action: 'membership.created', entityType: 'membership', entityId: rows[0].id,
        data: { customerId, planId: input.planId, validFrom: input.validFrom, validTo: input.validTo } });
      return { id: rows[0].id as string, customerId };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new DomainError('VALIDATION', 'Numéro de carte déjà utilisé.');
    throw err;
  }
}

export async function updateMembership(
  db: Db, clubId: string, id: string,
  patch: { planId?: string; cardNumber?: string | null; validFrom?: string; validTo?: string; status?: 'active' | 'suspended'; notes?: string | null; handicapIndex?: number | null },
  actor: Actor,
) {
  const map: Record<string, string> = { planId: 'plan_id', cardNumber: 'card_number', validFrom: 'valid_from', validTo: 'valid_to', status: 'status', notes: 'notes' };
  const entries = Object.entries(patch).filter(([k, v]) => k in map && v !== undefined);
  try {
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query('SELECT customer_id FROM memberships WHERE id = $1 AND club_id = $2 FOR UPDATE', [id, clubId]);
      if (!rows[0]) throw new DomainError('NOT_FOUND', 'Abonnement introuvable.');
      if (patch.planId) {
        const plan = await tx.query('SELECT 1 FROM membership_plans WHERE id = $1 AND club_id = $2', [patch.planId, clubId]);
        if (!plan.rowCount) throw new DomainError('VALIDATION', 'Formule inconnue pour ce golf.');
      }
      if (entries.length) {
        await tx.query(`UPDATE memberships SET ${entries.map(([k], i) => `${map[k]} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [id, ...entries.map(([, v]) => v)]);
      }
      if (patch.handicapIndex !== undefined) await tx.query('UPDATE customers SET handicap_index = $2 WHERE id = $1', [rows[0].customer_id, patch.handicapIndex]);
      await audit(tx, { clubId, actor, action: 'membership.updated', entityType: 'membership', entityId: id, data: { fields: Object.keys(patch) } });
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new DomainError('VALIDATION', 'Numéro de carte déjà utilisé.');
    if ((err as { code?: string }).code === '23514') throw new DomainError('VALIDATION', 'Période de validité invalide.');
    throw err;
  }
}
