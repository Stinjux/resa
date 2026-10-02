// Rapports modulables : indicateurs à la carte sur un ou plusieurs golfs, avec
// filtres libres et comparaison. Tous les chiffres sont calculés en SQL.
//
// Périmètre : réservations dont le DÉPART est dans la période (date locale).
// Chiffre d'affaires = commandes des réservations confirmées (TTC).
// Encaissé = paiements confirmés − remboursements confirmés sur ces commandes.

import { DateTime } from 'luxon';
import type { Queryable } from '../../db/pool.js';
import { peakUsage, type Usage } from '../../domain/resource-usage.js';
import { generateDaySlots } from '../../domain/schedule.js';
import { csvMoney, toCsv } from '../../shared/csv.js';
import { DomainError } from '../../shared/errors.js';
import { isoWeekday } from '../../shared/time.js';
import { getClub, listCourses, listScheduleRules, type Club } from '../catalog/repository.js';

export const BLOCKS = [
  'kpis', 'occupancy', 'amounts', 'cancellations', 'channels', 'equipment', 'caddieStaff',
  'revenue', 'clubs', 'categories', 'partners', 'weekdays', 'hours', 'daily', 'payments', 'customers',
] as const;
export type BlockId = (typeof BLOCKS)[number];
/** Anciens identifiants encore présents dans des préférences ou envois programmés. */
export const LEGACY_BLOCKS: Record<string, BlockId[]> = { caddies: ['equipment', 'caddieStaff'] };
export const DEFAULT_BLOCKS: BlockId[] = ['kpis', 'occupancy', 'amounts', 'cancellations', 'channels', 'equipment', 'caddieStaff'];
export const MAX_DAYS = 366;

export function normalizeBlocks(blocks: string[]): BlockId[] {
  const out: BlockId[] = [];
  for (const b of blocks) for (const x of LEGACY_BLOCKS[b] ?? [b as BlockId]) if ((BLOCKS as readonly string[]).includes(x) && !out.includes(x)) out.push(x);
  return out;
}

/** Ce que compte chaque bloc (statuts inclus) : affiché sous le bloc et repris dans l'export. */
export const DEFINITIONS: Partial<Record<BlockId, string>> = {
  kpis: "Réservations confirmées dont le départ a lieu dans la période (absences incluses, annulations comptées à part). Un départ partagé par plusieurs réservations n'est compté qu'une fois.",
  occupancy: "Taux d'occupation = joueurs des réservations confirmées ÷ places ouvertes à la vente : créneaux de la grille d'ouverture, moins les départs fermés (bloqués). Les départs tenus pour un allotement restent ouverts. Un départ exclusif compte ses joueurs réels ; les places qu'il neutralise sont indiquées à part.",
  amounts: "Réservé = total TTC des réservations confirmées. Frais d'annulation = montant resté dû sur les réservations annulées. Encaissé et remboursé = paiements et remboursements confirmés (jamais ceux en attente). Solde à recevoir = reste dû, à rembourser = trop-perçu. Montants regroupés par devise, jamais additionnés entre devises.",
  cancellations: "Annulations : réservations annulées dont le départ était prévu dans la période. Absences : réservations confirmées notées « absent » à l'accueil ou par le starter, rapportées aux départs déjà passés.",
  channels: 'Réservations confirmées par canal de prise de réservation.',
  equipment: "Quantités réservées sur des réservations confirmées (la sortie effective du matériel n'est pas enregistrée). Pic = plus grand nombre d'unités réservées en même temps un même jour, sur toute la durée de jeu.",
  caddieStaff: 'Un caddie par départ, partagé entre les réservations du départ. Jours travaillés = jours avec au moins un départ affecté (la présence des caddies n’est pas pointée).',
};

export interface ReportConfig {
  clubIds: string[];
  from: string;
  to: string;
  courseId?: string | null;
  channels?: string[] | null;
  partnerId?: string | null;
  categories?: string[] | null;
  compare?: 'none' | 'previous' | 'last_year';
  blocks: Array<BlockId | 'caddies'>;
}

export function comparisonPeriod(from: string, to: string, compare: ReportConfig['compare']): { from: string; to: string } | null {
  const f = DateTime.fromISO(from);
  const t = DateTime.fromISO(to);
  if (compare === 'previous') {
    const days = Math.round(t.diff(f, 'days').days) + 1;
    return { from: f.minus({ days }).toISODate()!, to: f.minus({ days: 1 }).toISODate()! };
  }
  if (compare === 'last_year') return { from: f.minus({ years: 1 }).toISODate()!, to: t.minus({ years: 1 }).toISODate()! };
  return null;
}

function validate(cfg: ReportConfig) {
  const f = DateTime.fromISO(cfg.from);
  const t = DateTime.fromISO(cfg.to);
  if (!f.isValid || !t.isValid || t < f) throw new DomainError('VALIDATION', 'Période invalide.');
  if (Math.round(t.diff(f, 'days').days) + 1 > MAX_DAYS) throw new DomainError('VALIDATION', `Période limitée à ${MAX_DAYS} jours.`);
  if (!cfg.clubIds.length) throw new DomainError('VALIDATION', 'Choisir au moins un golf.');
}

/**
 * Places ouvertes à la vente, par golf, par jour et par jour de semaine :
 * créneaux de la grille (règles d'ouverture et de fermeture) moins les départs
 * bloqués (tournoi, entretien…). Un départ tenu pour un allotement reste ouvert.
 */
async function capacity(q: Queryable, clubs: Club[], from: string, to: string, courseId: string | null) {
  const byClub = new Map<string, number>();
  const byDate = new Map<string, number>();
  const byWeekday = new Map<number, number>();
  let gridTotal = 0;
  for (const club of clubs) {
    const [rules, courses] = await Promise.all([listScheduleRules(q, club.id), listCourses(q, club.id)]);
    let total = 0;
    for (let d = DateTime.fromISO(from); d <= DateTime.fromISO(to); d = d.plus({ days: 1 })) {
      const date = d.toISODate()!;
      const wd = isoWeekday(date);
      let day = 0;
      for (const c of courses) {
        if (courseId && c.id !== courseId) continue;
        day += generateDaySlots(date, wd, rules, { courseId: c.id, intervalMinutes: c.defaultIntervalMinutes, maxPlayers: c.defaultMaxPlayers,
          allowedHoles: c.allowedHoles }).reduce((n, s) => n + s.maxPlayers, 0);
      }
      total += day;
      byDate.set(date, (byDate.get(date) ?? 0) + day);
      byWeekday.set(wd, (byWeekday.get(wd) ?? 0) + day);
    }
    byClub.set(club.id, total);
    gridTotal += total;
  }
  const { rows: closed } = await q.query(
    `SELECT t.club_id AS "clubId", to_char(t.local_date, 'YYYY-MM-DD') AS date, sum(t.max_players)::int AS seats, count(*)::int AS n
       FROM tee_times t
      WHERE t.club_id = ANY($1::uuid[]) AND t.local_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR t.course_id = $4)
        AND t.blocked_reason IS NOT NULL AND t.held_allotment_id IS NULL
      GROUP BY 1, 2`,
    [clubs.map((c) => c.id), from, to, courseId],
  );
  let closedSeats = 0;
  let closedTeeTimes = 0;
  for (const r of closed) {
    closedSeats += r.seats;
    closedTeeTimes += r.n;
    byClub.set(r.clubId, (byClub.get(r.clubId) ?? 0) - r.seats);
    byDate.set(r.date, (byDate.get(r.date) ?? 0) - r.seats);
    const wd = isoWeekday(r.date);
    byWeekday.set(wd, (byWeekday.get(wd) ?? 0) - r.seats);
  }
  return { byClub, byDate, byWeekday, gridTotal, closedSeats, closedTeeTimes, total: gridTotal - closedSeats };
}

/** Joueurs hors départs fermés (numérateur du taux d'occupation). */
const OPEN_TT = `(t.blocked_reason IS NULL OR t.held_allotment_id IS NOT NULL)`;

async function kpis(q: Queryable, scope: string, P: unknown[], now: Date) {
  const { rows: [r] } = await q.query(
    `SELECT count(b.id) FILTER (WHERE b.status = 'confirmed')::int AS bookings,
            coalesce(sum(b.players) FILTER (WHERE b.status = 'confirmed'), 0)::int AS players,
            coalesce(sum(b.players) FILTER (WHERE b.status = 'confirmed' AND ${OPEN_TT}), 0)::int AS "openPlayers",
            count(DISTINCT t.id) FILTER (WHERE b.status = 'confirmed')::int AS "teeTimes",
            count(DISTINCT t.id) FILTER (WHERE b.status = 'confirmed' AND b.is_private)::int AS "exclusiveTeeTimes",
            count(b.id) FILTER (WHERE b.status = 'cancelled')::int AS cancellations,
            coalesce(sum(b.players) FILTER (WHERE b.status = 'cancelled'), 0)::int AS "cancelledPlayers",
            count(b.id) FILTER (WHERE b.status = 'confirmed' AND b.checkin_status = 'no_show')::int AS "noShows",
            coalesce(sum(b.players) FILTER (WHERE b.status = 'confirmed' AND b.checkin_status = 'no_show'), 0)::int AS "noShowPlayers",
            count(b.id) FILTER (WHERE b.status = 'confirmed' AND b.checkin_status <> 'expected')::int AS "checkinsRecorded",
            count(b.id) FILTER (WHERE b.status = 'confirmed' AND t.starts_at < $8)::int AS "pastBookings"
       FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id
      WHERE ${scope}`, [...P, now]);
  // Départs exclusifs : un départ est compté une fois, ses places neutralisées = places − joueurs.
  const { rows: [x] } = await q.query(
    `SELECT coalesce(sum(players), 0)::int AS players, coalesce(sum(seats - players), 0)::int AS neutralized FROM (
       SELECT t.id, max(t.max_players) AS seats, sum(b.players) AS players
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id
        WHERE ${scope} AND b.status = 'confirmed' AND b.is_private GROUP BY t.id) e`, P);
  return { ...r, exclusivePlayers: x.players, exclusiveNeutralizedSeats: x.neutralized } as {
    bookings: number; players: number; openPlayers: number; teeTimes: number; exclusiveTeeTimes: number; exclusivePlayers: number;
    exclusiveNeutralizedSeats: number; cancellations: number; cancelledPlayers: number; noShows: number; noShowPlayers: number;
    checkinsRecorded: number; pastBookings: number;
  };
}

/** Montants par devise : jamais d'addition entre devises. */
async function amounts(q: Queryable, scope: string, P: unknown[]) {
  const { rows } = await q.query(
    `WITH per AS (
       SELECT c.currency, b.status, coalesce(o.total_minor, 0) AS total,
              coalesce((SELECT sum(amount_minor) FROM payments WHERE order_id = o.id AND status = 'confirmed'), 0) AS paid,
              coalesce((SELECT sum(amount_minor) FROM refunds WHERE order_id = o.id AND status = 'confirmed'), 0) AS refunded,
              (o.id IS NOT NULL) AS has_order
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id JOIN clubs c ON c.id = t.club_id
         LEFT JOIN orders o ON o.booking_id = b.id
        WHERE ${scope})
     SELECT currency,
            coalesce(sum(total) FILTER (WHERE status = 'confirmed'), 0)::int AS "bookedMinor",
            coalesce(sum(total) FILTER (WHERE status = 'cancelled'), 0)::int AS "cancellationFeesMinor",
            sum(paid)::int AS "paidMinor", sum(refunded)::int AS "refundedMinor", (sum(paid) - sum(refunded))::int AS "netMinor",
            coalesce(sum(total - paid + refunded) FILTER (WHERE has_order AND total - paid + refunded > 0), 0)::int AS "receivableMinor",
            coalesce(-sum(total - paid + refunded) FILTER (WHERE has_order AND total - paid + refunded < 0), 0)::int AS "refundDueMinor"
       FROM per GROUP BY currency ORDER BY currency`, P);
  return rows as Array<{ currency: string; bookedMinor: number; cancellationFeesMinor: number; paidMinor: number; refundedMinor: number;
    netMinor: number; receivableMinor: number; refundDueMinor: number }>;
}

export async function computeAnalytics(q: Queryable, cfg: ReportConfig, now: Date = new Date()) {
  validate(cfg);
  const blocks = normalizeBlocks(cfg.blocks);
  const clubs = await Promise.all(cfg.clubIds.map((id) => getClub(q, id)));
  const currencies = [...new Set(clubs.map((c) => c.currency))].sort();
  /** Devise unique, ou null si les golfs choisis ont des devises différentes. */
  const currency = currencies.length === 1 ? currencies[0]! : null;
  const mixedNote = `Golfs en devises différentes (${currencies.join(', ')}) : les montants ne sont pas additionnés. Voir « Montants » (par devise) ou choisir des golfs de même devise.`;
  const courseId = cfg.courseId && clubs.length === 1 ? cfg.courseId : null;

  const scopeFor = (from: string, to: string) => ({
    P: [cfg.clubIds, from, to, courseId, cfg.channels?.length ? cfg.channels : null, cfg.partnerId ?? null,
      cfg.categories?.length ? cfg.categories : null],
  });
  const SCOPE = `t.club_id = ANY($1::uuid[]) AND t.local_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR t.course_id = $4)
    AND ($5::text[] IS NULL OR b.channel = ANY($5)) AND ($6::uuid IS NULL OR b.partner_id = $6) AND ($7::text[] IS NULL OR b.customer_category = ANY($7))`;
  const CONFIRMED = `${SCOPE} AND b.status = 'confirmed'`;
  const { P } = scopeFor(cfg.from, cfg.to);
  const want = new Set(blocks);
  const needCapacity = ['kpis', 'occupancy', 'clubs', 'weekdays', 'daily'].some((b) => want.has(b as BlockId));
  const cap = needCapacity ? await capacity(q, clubs, cfg.from, cfg.to, courseId) : null;

  const result: Record<string, unknown> = {};
  /** Bloc sans donnée exploitable : raison affichée à la place d'un faux zéro. */
  const unavailable: Partial<Record<BlockId, string>> = {};
  /** Remarques sur une partie d'un bloc. */
  const notes: Partial<Record<BlockId, string[]>> = {};
  const note = (b: BlockId, text: string) => { (notes[b] ??= []).push(text); };

  const withRates = async (from: string, to: string, capTotal: number) => {
    const k = await kpis(q, SCOPE, scopeFor(from, to).P, now);
    const money = await amounts(q, SCOPE, scopeFor(from, to).P);
    const m = currency ? money[0] : undefined;
    return {
      ...k, capacity: capTotal,
      occupancyRate: capTotal ? k.openPlayers / capTotal : null,
      avgPlayersPerTeeTime: k.teeTimes ? k.players / k.teeTimes : null,
      noShowRate: k.checkinsRecorded && k.pastBookings ? k.noShows / k.pastBookings : null,
      // Compatibilité : montants d'une devise unique (null si devises mélangées).
      revenueMinor: currency ? (m?.bookedMinor ?? 0) : null,
      collectedMinor: currency ? (m?.netMinor ?? 0) : null,
      receivableMinor: currency ? (m?.receivableMinor ?? 0) : null,
    };
  };

  let current: Awaited<ReturnType<typeof withRates>> | null = null;
  if (want.has('kpis') || want.has('occupancy') || want.has('cancellations')) current = await withRates(cfg.from, cfg.to, cap!.total);

  if (want.has('kpis')) {
    const cmp = comparisonPeriod(cfg.from, cfg.to, cfg.compare);
    let previous = null;
    if (cmp) {
      const prevCap = await capacity(q, clubs, cmp.from, cmp.to, courseId);
      previous = { ...(await withRates(cmp.from, cmp.to, prevCap.total)), from: cmp.from, to: cmp.to };
    }
    result.kpis = { current, previous };
    if (!currency) note('kpis', mixedNote);
    if (!cap!.total) note('kpis', "Aucune place ouverte à la vente sur la période (grille fermée) : taux d'occupation non calculable.");
  }
  if (want.has('occupancy')) {
    const c = current!;
    result.occupancy = {
      gridSeats: cap!.gridTotal, closedSeats: cap!.closedSeats, closedTeeTimes: cap!.closedTeeTimes, openSeats: cap!.total,
      players: c.openPlayers, occupancyRate: c.occupancyRate, teeTimes: c.teeTimes, avgPlayersPerTeeTime: c.avgPlayersPerTeeTime,
      exclusiveTeeTimes: c.exclusiveTeeTimes, exclusivePlayers: c.exclusivePlayers, exclusiveNeutralizedSeats: c.exclusiveNeutralizedSeats,
      // Occupation « commerciale » : joueurs + places neutralisées par l'exclusivité.
      soldRate: cap!.total ? (c.openPlayers + c.exclusiveNeutralizedSeats) / cap!.total : null,
    };
    if (!cap!.total) unavailable.occupancy = "Aucune place ouverte à la vente sur la période : la grille d'ouverture est fermée ou tous les départs sont bloqués.";
  }
  if (want.has('amounts')) result.amounts = await amounts(q, SCOPE, P);
  if (want.has('cancellations')) {
    const c = current!;
    result.cancellations = {
      cancellations: c.cancellations, cancelledPlayers: c.cancelledPlayers,
      cancellationRate: c.bookings + c.cancellations ? c.cancellations / (c.bookings + c.cancellations) : null,
      noShows: c.checkinsRecorded ? c.noShows : null, noShowPlayers: c.checkinsRecorded ? c.noShowPlayers : null,
      noShowRate: c.noShowRate, pastBookings: c.pastBookings, checkinsRecorded: c.checkinsRecorded,
    };
    if (!c.pastBookings) note('cancellations', 'Absences : données non disponibles — aucun départ de la période n’a encore eu lieu.');
    else if (!c.checkinsRecorded) note('cancellations', 'Absences : données non disponibles — aucune arrivée ni absence n’a été pointée sur la période (bouton « Arrivé » / « Absent » de l’accueil ou du starter).');
  }
  if (want.has('revenue')) {
    if (!currency) unavailable.revenue = mixedNote;
    else {
      const { rows } = await q.query(
        `SELECT ol.kind, ol.payer, sum(ol.total_minor)::int AS amount FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id
           JOIN orders o ON o.booking_id = b.id JOIN order_lines ol ON ol.order_id = o.id
          WHERE ${CONFIRMED} GROUP BY 1, 2 ORDER BY 3 DESC`, P);
      const fees = await q.query(
        `SELECT coalesce(sum(o.total_minor), 0)::int AS v FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id JOIN orders o ON o.booking_id = b.id
          WHERE ${SCOPE} AND b.status = 'cancelled'`, P);
      const byKind: Record<string, number> = {};
      const byPayer: Record<string, number> = {};
      for (const r of rows) { byKind[r.kind] = (byKind[r.kind] ?? 0) + r.amount; byPayer[r.payer] = (byPayer[r.payer] ?? 0) + r.amount; }
      result.revenue = { byKind, byPayer, cancellationFeesMinor: fees.rows[0].v, totalMinor: Object.values(byKind).reduce((a, b) => a + b, 0) };
    }
  }
  if (want.has('clubs')) {
    const { rows } = await q.query(
      `SELECT t.club_id AS "clubId", count(b.id)::int AS bookings, sum(b.players)::int AS players,
              coalesce(sum(b.players) FILTER (WHERE ${OPEN_TT}), 0)::int AS "openPlayers", coalesce(sum(o.total_minor), 0)::int AS "revenueMinor"
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id LEFT JOIN orders o ON o.booking_id = b.id WHERE ${CONFIRMED} GROUP BY 1`, P);
    result.clubs = clubs.map((c) => {
      const r = rows.find((x) => x.clubId === c.id) ?? { bookings: 0, players: 0, openPlayers: 0, revenueMinor: 0 };
      const capC = cap!.byClub.get(c.id) ?? 0;
      // Chaque golf dans SA devise : pas de mélange.
      return { clubId: c.id, name: c.name, currency: c.currency, bookings: r.bookings, players: r.players, revenueMinor: r.revenueMinor,
        capacity: capC, occupancyRate: capC ? r.openPlayers / capC : null };
    });
  }
  const groupBy = async (expr: string, extraJoin = '') => (await q.query(
    `SELECT ${expr} AS key, count(b.id)::int AS bookings, sum(b.players)::int AS players,
            ${currency ? 'coalesce(sum(o.total_minor), 0)::int' : 'NULL::int'} AS "revenueMinor"
       FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id LEFT JOIN orders o ON o.booking_id = b.id ${extraJoin}
      WHERE ${CONFIRMED} GROUP BY 1 ORDER BY players DESC`, P)).rows;
  if (want.has('channels')) { result.channels = await groupBy('b.channel'); if (!currency) note('channels', mixedNote); }
  if (want.has('categories')) { result.categories = await groupBy('b.customer_category'); if (!currency) note('categories', mixedNote); }
  if (want.has('partners')) {
    if (!currency) unavailable.partners = mixedNote;
    else {
      const { rows } = await q.query(
        `SELECT p.id AS key, p.name, count(b.id)::int AS bookings, sum(b.players)::int AS players,
                coalesce(sum((SELECT sum(ol.total_minor) FROM order_lines ol WHERE ol.order_id = o.id AND ol.payer = 'partner')), 0)::int AS "partnerMinor",
                coalesce(sum(o.total_minor), 0)::int AS "revenueMinor"
           FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id JOIN partners p ON p.id = b.partner_id LEFT JOIN orders o ON o.booking_id = b.id
          WHERE ${CONFIRMED} GROUP BY p.id, p.name ORDER BY players DESC`, P);
      result.partners = rows;
    }
  }
  if (want.has('weekdays')) {
    const { rows } = await q.query(
      `SELECT extract(isodow FROM t.local_date)::int AS wd, sum(b.players)::int AS players,
              coalesce(sum(b.players) FILTER (WHERE ${OPEN_TT}), 0)::int AS "openPlayers"
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id WHERE ${CONFIRMED} GROUP BY 1`, P);
    result.weekdays = [1, 2, 3, 4, 5, 6, 7].map((wd) => {
      const r = rows.find((x) => x.wd === wd);
      const c = cap!.byWeekday.get(wd) ?? 0;
      return { weekday: wd, players: r?.players ?? 0, capacity: c, occupancyRate: c ? (r?.openPlayers ?? 0) / c : null };
    });
  }
  if (want.has('hours')) {
    const { rows } = await q.query(
      `SELECT extract(hour FROM t.starts_at AT TIME ZONE c.timezone)::int AS hour, sum(b.players)::int AS players
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id JOIN clubs c ON c.id = t.club_id WHERE ${CONFIRMED} GROUP BY 1 ORDER BY 1`, P);
    result.hours = rows;
  }
  if (want.has('daily')) {
    const { rows } = await q.query(
      `SELECT to_char(t.local_date, 'YYYY-MM-DD') AS date, sum(b.players)::int AS players,
              coalesce(sum(b.players) FILTER (WHERE ${OPEN_TT}), 0)::int AS "openPlayers",
              ${currency ? 'coalesce(sum(o.total_minor), 0)::int' : 'NULL::int'} AS "revenueMinor"
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id LEFT JOIN orders o ON o.booking_id = b.id WHERE ${CONFIRMED} GROUP BY 1`, P);
    result.daily = [...cap!.byDate.entries()].map(([date, c]) => {
      const r = rows.find((x) => x.date === date);
      return { date, players: r?.players ?? 0, revenueMinor: currency ? (r?.revenueMinor ?? 0) : null, capacity: c,
        occupancyRate: c ? (r?.openPlayers ?? 0) / c : null };
    });
    if (!currency) note('daily', mixedNote);
  }
  if (want.has('payments')) {
    if (!currency) unavailable.payments = mixedNote;
    else {
      const { rows } = await q.query(
        `SELECT m.method, sum(m.paid)::int AS "paidMinor", sum(m.refunded)::int AS "refundedMinor" FROM (
           SELECT p.method, p.amount_minor AS paid, 0 AS refunded FROM payments p JOIN orders o ON o.id = p.order_id JOIN bookings b ON b.id = o.booking_id
             JOIN tee_times t ON t.id = b.tee_time_id WHERE ${SCOPE} AND p.status = 'confirmed'
           UNION ALL
           SELECT r.method, 0, r.amount_minor FROM refunds r JOIN orders o ON o.id = r.order_id JOIN bookings b ON b.id = o.booking_id
             JOIN tee_times t ON t.id = b.tee_time_id WHERE ${SCOPE} AND r.status = 'confirmed') m
         GROUP BY 1 ORDER BY 2 DESC`, P);
      const [m] = await amounts(q, SCOPE, P);
      result.payments = { byMethod: rows, outstandingMinor: m?.receivableMinor ?? 0, refundDueMinor: m?.refundDueMinor ?? 0 };
    }
  }
  if (want.has('equipment')) {
    const { rows: allocs } = await q.query(
      `SELECT rt.id AS rt, rt.name, rt.kind, rt.total_quantity AS total, a.id, a.quantity, lower(a.period) AS s, upper(a.period) AS e,
              to_char(t.local_date, 'YYYY-MM-DD') AS date, b.id AS "bookingId",
              (SELECT count(*)::int FROM allocation_units au WHERE au.allocation_id = a.id) AS assigned
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id
         JOIN resource_allocations a ON a.booking_id = b.id AND a.status = 'active'
         JOIN resource_types rt ON rt.id = a.resource_type_id
        WHERE ${CONFIRMED} AND rt.scope = 'booking'`, P);
    const { rows: types } = await q.query(
      `SELECT id, name, kind, total_quantity AS total, club_id AS "clubId" FROM resource_types
        WHERE club_id = ANY($1::uuid[]) AND scope = 'booking' AND active ORDER BY club_id, sort_order`, [cfg.clubIds]);
    // Regroupement par libellé (plusieurs golfs) : quantités additionnées, pic calculé par type et par jour.
    const byName = new Map<string, { name: string; kind: string; capacity: number; quantity: number; bookings: Set<string>; assigned: number; peak: number; daysAtCapacity: number }>();
    for (const t of types) {
      const g = byName.get(t.name) ?? { name: t.name, kind: t.kind, capacity: 0, quantity: 0, bookings: new Set<string>(), assigned: 0, peak: 0, daysAtCapacity: 0 };
      g.capacity += t.total;
      byName.set(t.name, g);
      const mine = allocs.filter((a) => a.rt === t.id);
      for (const a of mine) { g.quantity += a.quantity; g.bookings.add(a.bookingId); g.assigned += Math.min(a.assigned, a.quantity); }
      const days = new Map<string, Usage[]>();
      for (const a of mine) days.set(a.date, [...(days.get(a.date) ?? []), { start: a.s.getTime(), end: a.e.getTime(), quantity: a.quantity }]);
      for (const usages of days.values()) {
        const p = peakUsage(usages, -Infinity, Infinity);
        g.peak = Math.max(g.peak, p);
        if (t.total > 0 && p >= t.total) g.daysAtCapacity += 1;
      }
    }
    result.equipment = [...byName.values()].map((g) => ({
      name: g.name, kind: g.kind, capacity: g.capacity, quantity: g.quantity, bookings: g.bookings.size,
      assignedUnits: g.assigned, assignedRate: g.quantity ? g.assigned / g.quantity : null, peak: g.peak, daysAtCapacity: g.daysAtCapacity,
    }));
    if (!types.length) unavailable.equipment = 'Aucun matériel de location n’est configuré pour ces golfs (Configuration › Matériel).';
  }
  if (want.has('caddieStaff')) {
    const { rows: [c] } = await q.query(
      `SELECT count(DISTINCT t.id)::int AS "teeTimes",
              count(DISTINCT t.id) FILTER (WHERE EXISTS (SELECT 1 FROM resource_allocations a JOIN resource_types rt ON rt.id = a.resource_type_id
                 WHERE a.tee_time_id = t.id AND a.status = 'active' AND rt.kind = 'caddie'))::int AS "withCaddie",
              count(DISTINCT t.id) FILTER (WHERE t.caddie_id IS NOT NULL)::int AS named
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id WHERE ${CONFIRMED}`, P);
    const { rows: perCaddie } = await q.query(
      `SELECT ca.id, ca.display_name AS name, cl.name AS club, count(DISTINCT t.id)::int AS "teeTimes",
              count(DISTINCT t.local_date)::int AS days
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id JOIN caddies ca ON ca.id = t.caddie_id JOIN clubs cl ON cl.id = t.club_id
        WHERE ${CONFIRMED} GROUP BY ca.id, ca.display_name, cl.name ORDER BY "teeTimes" DESC, name`, P);
    result.caddieStaff = { ...c, perCaddie: c.named ? perCaddie : null };
    if (!c.teeTimes) note('caddieStaff', 'Aucun départ réservé sur la période.');
    else if (!c.named) note('caddieStaff', "Répartition par caddie : données non disponibles — aucun caddie n'a été nommé sur ces départs. Le caddie est réservé en nombre à la réservation ; son nom est saisi par le starter.");
    else if (c.named < c.withCaddie) note('caddieStaff', `${c.withCaddie - c.named} départ(s) avec caddie réservé sans caddie nommé : non comptés dans la répartition par caddie.`);
  }
  if (want.has('customers')) {
    const { rows: [c] } = await q.query(
      `SELECT count(DISTINCT b.customer_id)::int AS distinct,
              count(DISTINCT b.customer_id) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM bookings b2 JOIN tee_times t2 ON t2.id = b2.tee_time_id
                 WHERE b2.customer_id = b.customer_id AND b2.club_id = ANY($1::uuid[]) AND t2.local_date < $2 AND b2.status = 'confirmed'))::int AS "firstTime",
              count(DISTINCT b.customer_id) FILTER (WHERE EXISTS (
                SELECT 1 FROM memberships m WHERE m.customer_id = b.customer_id AND m.club_id = t.club_id AND m.status = 'active'
                   AND t.local_date BETWEEN m.valid_from AND m.valid_to))::int AS members,
              count(b.id) FILTER (WHERE b.customer_id IS NULL)::int AS anonymous
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id WHERE ${CONFIRMED}`, P);
    result.customers = c;
    if (c.anonymous) note('customers', `${c.anonymous} réservation(s) sans fiche golfeur ne sont pas comptées dans les clients distincts.`);
  }
  return {
    currency,
    currencies,
    clubs: clubs.map((c) => ({ id: c.id, name: c.name, currency: c.currency })),
    period: { from: cfg.from, to: cfg.to },
    filters: { courseId, channels: cfg.channels ?? null, partnerId: cfg.partnerId ?? null, categories: cfg.categories ?? null, compare: cfg.compare ?? 'none' },
    blocks: blocks.filter((b) => b in result || b in unavailable),
    data: result as Record<BlockId, any>,
    unavailable,
    notes,
    definitions: DEFINITIONS,
  };
}

export type AnalyticsResult = Awaited<ReturnType<typeof computeAnalytics>>;

// ---------------------------------------------------------------------------
// Libellés, export CSV, rendu HTML (e-mail)

export const BLOCK_LABELS: Record<BlockId, string> = {
  kpis: 'Chiffres clés', occupancy: 'Occupation et départs exclusifs', amounts: 'Montants', cancellations: 'Annulations et absences',
  channels: 'Par canal', equipment: 'Voiturettes, chariots et sacs', caddieStaff: 'Caddies',
  revenue: "Chiffre d'affaires par poste", clubs: 'Par golf', categories: 'Par catégorie de client',
  partners: 'Tour-opérateurs et partenaires', weekdays: 'Par jour de la semaine', hours: 'Par heure de départ', daily: 'Jour par jour',
  payments: 'Encaissements par mode', customers: 'Clientèle',
};
const CHANNEL: Record<string, string> = { web: 'Web', phone: 'Téléphone', group: 'Groupe', walk_in: 'Sur place', staff: 'Personnel', whatsapp: 'WhatsApp', sms: 'SMS', partner: 'Portail partenaire' };
const KIND: Record<string, string> = { green_fee: 'Green fees', caddie: 'Caddies', resource: 'Matériel', private_surcharge: 'Suppléments privés', cancellation_fee: "Frais d'annulation", no_show_fee: "Frais d'absence" };
const METHOD: Record<string, string> = { cash: 'Espèces', card_terminal: 'Carte (TPE)', bank_transfer: 'Virement', online: 'En ligne', pos: 'Caisse', other: 'Autre' };
const WEEKDAY = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
export const NOT_AVAILABLE = 'Données non disponibles';
const pct = (x: number | null | undefined) => (x === null || x === undefined ? NOT_AVAILABLE : `${(Math.round(x * 1000) / 10).toString().replace('.', ',')} %`);
const dec = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(1).replace('.', ','));
const orNa = (x: unknown) => (x === null || x === undefined ? NOT_AVAILABLE : x);

type Money = (minor: number | null | undefined, currency?: string | null) => string;
export interface ReportTable { title: string; head: string[]; rows: unknown[][]; notes: string[] }

/** Tableaux (titre, en-têtes, lignes, remarques) : base commune du CSV et de l'e-mail. */
export function reportTables(r: AnalyticsResult, fmtMoney: Money): ReportTable[] {
  const d = r.data;
  const out: ReportTable[] = [];
  const m = (x: number | null | undefined, cur: string | null = r.currency) => (x === null || x === undefined || !cur ? NOT_AVAILABLE : fmtMoney(x, cur));
  for (const b of r.blocks) {
    const title = BLOCK_LABELS[b];
    const notes = [...(r.notes[b] ?? []), ...(r.definitions[b] ? [`Calcul : ${r.definitions[b]}`] : [])];
    const push = (head: string[], rows: unknown[][]) => out.push({ title, head, rows, notes });
    if (r.unavailable[b]) { out.push({ title, head: [NOT_AVAILABLE], rows: [[r.unavailable[b]]], notes: [] }); continue; }
    if (b === 'kpis') {
      const c = d.kpis.current;
      const p = d.kpis.previous;
      const line = (label: string, key: string, f: (x: any) => string = (x) => String(orNa(x))) =>
        [label, f(c[key]), ...(p ? [f(p[key]), typeof c[key] === 'number' && p[key] ? pct((c[key] - p[key]) / p[key]) : '—'] : [])];
      push(['Indicateur', 'Période', ...(p ? [`${p.from} → ${p.to}`, 'Évolution'] : [])], [
        line('Réservations', 'bookings'), line('Joueurs', 'players'), line("Taux d'occupation", 'occupancyRate', pct),
        line('Départs exclusifs', 'exclusiveTeeTimes'),
        line('Montant réservé', 'revenueMinor', (x) => m(x)), line('Encaissé (net des remboursements)', 'collectedMinor', (x) => m(x)),
        line('Solde à recevoir', 'receivableMinor', (x) => m(x)),
        line('Annulations', 'cancellations'), line('Absences', 'noShows', (x) => (c.checkinsRecorded ? String(x) : NOT_AVAILABLE)),
      ]);
    }
    if (b === 'occupancy') {
      const o = d.occupancy;
      push(['Indicateur', 'Valeur'], [
        ['Places de la grille', o.gridSeats], ['Places fermées (départs bloqués)', `${o.closedSeats} (${o.closedTeeTimes} départ(s))`],
        ['Places ouvertes à la vente', o.openSeats], ['Joueurs', o.players], ["Taux d'occupation", pct(o.occupancyRate)],
        ['Départs occupés', o.teeTimes], ['Joueurs par départ', dec(o.avgPlayersPerTeeTime)],
        ['Départs exclusifs', o.exclusiveTeeTimes], ['Joueurs sur départs exclusifs', o.exclusivePlayers],
        ["Places neutralisées par l'exclusivité", o.exclusiveNeutralizedSeats], ['Taux de places vendues (joueurs + exclusivité)', pct(o.soldRate)],
      ]);
    }
    if (b === 'amounts') {
      push(['Devise', 'Réservé', "Frais d'annulation", 'Encaissé', 'Remboursé', 'Net encaissé', 'Solde à recevoir', 'À rembourser'],
        d.amounts.length ? d.amounts.map((a: any) => [a.currency, m(a.bookedMinor, a.currency), m(a.cancellationFeesMinor, a.currency), m(a.paidMinor, a.currency),
          m(a.refundedMinor, a.currency), m(a.netMinor, a.currency), m(a.receivableMinor, a.currency), m(a.refundDueMinor, a.currency)])
          : [['Aucune réservation sur la période', '', '', '', '', '', '', '']]);
    }
    if (b === 'cancellations') {
      const c = d.cancellations;
      push(['Indicateur', 'Valeur'], [
        ['Annulations', c.cancellations], ['Joueurs annulés', c.cancelledPlayers], ["Taux d'annulation", pct(c.cancellationRate)],
        ['Absences', orNa(c.noShows)], ['Joueurs absents', orNa(c.noShowPlayers)], ["Taux d'absence (départs passés)", pct(c.noShowRate)],
      ]);
    }
    if (b === 'equipment') push(['Matériel', 'Unités réservées', 'Réservations', 'Pic simultané / parc', 'Jours au complet', 'N° affectés'],
      d.equipment.map((e: any) => [e.name, e.quantity, e.bookings, `${e.peak} / ${e.capacity}`, e.daysAtCapacity,
        e.quantity ? `${e.assignedUnits} (${pct(e.assignedRate)})` : '—']));
    if (b === 'caddieStaff') {
      const c = d.caddieStaff;
      push(['Caddie', 'Départs', 'Jours travaillés'], [
        ['Départs avec caddie réservé', c.withCaddie, ''], ['dont caddie nommé', c.named, ''],
        ...(c.perCaddie ? c.perCaddie.map((x: any) => [r.clubs.length > 1 ? `${x.name} (${x.club})` : x.name, x.teeTimes, x.days])
          : [['Répartition par caddie', NOT_AVAILABLE, NOT_AVAILABLE]]),
      ]);
    }
    if (b === 'revenue') push(['Poste', 'Montant'], [
      ...Object.entries(d.revenue.byKind).map(([k, v]) => [KIND[k] ?? k, m(v as number)]),
      ['Total', m(d.revenue.totalMinor)],
      ['dont payé par les clients', m(d.revenue.byPayer.customer ?? 0)], ['dont payé par les partenaires', m(d.revenue.byPayer.partner ?? 0)],
      ["Frais d'annulation (réservations annulées)", m(d.revenue.cancellationFeesMinor)],
    ]);
    if (b === 'clubs') push(['Golf', 'Réservations', 'Joueurs', 'Occupation', 'Montant réservé'],
      d.clubs.map((c: any) => [c.name, c.bookings, c.players, pct(c.occupancyRate), m(c.revenueMinor, c.currency)]));
    const grouped = (label: (k: string) => string, first: string) => push([first, 'Réservations', 'Joueurs', 'Montant réservé'],
      (d[b] as any[]).map((g) => [label(g.key), g.bookings, g.players, m(g.revenueMinor)]));
    if (b === 'channels') grouped((k) => CHANNEL[k] ?? k, 'Canal');
    if (b === 'categories') grouped((k) => k, 'Catégorie');
    if (b === 'partners') push(['Partenaire', 'Réservations', 'Joueurs', 'Part partenaire', 'Total'],
      d.partners.map((p: any) => [p.name, p.bookings, p.players, m(p.partnerMinor), m(p.revenueMinor)]));
    if (b === 'weekdays') push(['Jour', 'Joueurs', 'Places ouvertes', 'Occupation'],
      d.weekdays.map((w: any) => [WEEKDAY[w.weekday], w.players, w.capacity, pct(w.occupancyRate)]));
    if (b === 'hours') push(['Heure', 'Joueurs'], d.hours.map((h: any) => [`${String(h.hour).padStart(2, '0')} h`, h.players]));
    if (b === 'daily') push(['Date', 'Joueurs', 'Places ouvertes', 'Occupation', 'Montant réservé'],
      d.daily.map((x: any) => [x.date, x.players, x.capacity, pct(x.occupancyRate), m(x.revenueMinor)]));
    if (b === 'payments') push(['Mode', 'Encaissé', 'Remboursé'], [
      ...d.payments.byMethod.map((x: any) => [METHOD[x.method] ?? x.method, m(x.paidMinor), m(x.refundedMinor)]),
      ['Solde à recevoir', m(d.payments.outstandingMinor), ''], ['À rembourser', m(d.payments.refundDueMinor), ''],
    ]);
    if (b === 'customers') push(['', 'Valeur'], [
      ['Clients distincts', d.customers.distinct], ['dont nouveaux', d.customers.firstTime], ['dont membres', d.customers.members],
    ]);
  }
  return out;
}

export function analyticsCsv(r: AnalyticsResult): string {
  const lines: unknown[][] = [[`Rapport ${r.clubs.map((c) => c.name).join(', ')}`], [`Période du ${r.period.from} au ${r.period.to}`],
    ...(r.currency ? [] : [[`Devises : ${r.currencies.join(', ')} (montants jamais additionnés entre devises)`]]), []];
  for (const t of reportTables(r, (x, cur) => `${csvMoney(x ?? 0)} ${cur ?? ''}`.trim())) {
    lines.push([t.title], t.head, ...t.rows);
    for (const n of t.notes) lines.push([n]);
    lines.push([]);
  }
  return toCsv(lines);
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function analyticsHtml(r: AnalyticsResult, title: string): string {
  const money: Money = (m, cur) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur ?? 'MAD', maximumFractionDigits: 0 }).format((m ?? 0) / 100);
  const tables = reportTables(r, money).map((t) => `
    <h2 style="font-family:Georgia,serif;font-weight:500;font-size:18px;margin:24px 0 8px">${esc(t.title)}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr>${t.head.map((h, i) => `<th style="text-align:${i ? 'right' : 'left'};padding:6px 4px;border-bottom:2px solid #DDD9CE;color:#5C625E">${esc(h)}</th>`).join('')}</tr>
      ${t.rows.map((row) => `<tr>${row.map((c, i) => `<td style="text-align:${i ? 'right' : 'left'};padding:6px 4px;border-bottom:1px solid #EFEDE6">${esc(c)}</td>`).join('')}</tr>`).join('')}
    </table>
    ${t.notes.filter((n) => !n.startsWith('Calcul')).map((n) => `<p style="color:#5C625E;font-size:12px;margin:6px 0 0">${esc(n)}</p>`).join('')}`).join('');
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#F7F6F2;font-family:'Segoe UI',Arial,sans-serif;color:#1A1D1B">
<div style="max-width:720px;margin:0 auto;padding:24px"><div style="background:#fff;border:1px solid #DDD9CE;border-radius:12px;padding:24px">
<h1 style="font-family:Georgia,serif;font-weight:500;font-size:26px;margin:0 0 4px">${esc(title)}</h1>
<p style="color:#5C625E;margin:0">${esc(r.clubs.map((c) => c.name).join(', '))} · du ${esc(r.period.from)} au ${esc(r.period.to)}</p>
${tables}
<p style="color:#5C625E;font-size:12px;margin-top:24px">Chiffres calculés par Resa. Le détail et la méthode de calcul sont joints au format Excel (CSV).</p>
</div></div></body></html>`;
}
