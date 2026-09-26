// Rapports : les CHIFFRES sont calculés ici, en SQL, et font foi. L'IA ne fait
// que rédiger l'analyse à partir de ces chiffres (aucun calcul confié au modèle).

import { DateTime } from 'luxon';
import type { Db, Queryable } from '../../db/pool.js';
import { DomainError } from '../../shared/errors.js';
import type { Actor } from '../../shared/audit.js';
import { getClub, listCourses } from '../catalog/repository.js';
import { computeGrid } from '../teesheet/service.js';
import { aiError, requireModel, textOf, type AiModel } from './model.js';

export const MAX_REPORT_DAYS = 92;

export interface ReportData {
  club: { id: string; name: string; currency: string; timezone: string };
  period: { from: string; to: string; days: number };
  activity: {
    teeTimesUsed: number;
    bookings: number;
    players: number;
    capacityPlayers: number; // places offertes par la grille sur la période
    occupancyRate: number; // joueurs / places offertes
    avgPlayersPerTeeTime: number;
    privateTeeTimes: number;
    cancellations: number;
    byChannel: Record<string, number>; // réservations
    byHoles: Record<string, number>; // joueurs
    byWeekday: Array<{ weekday: number; players: number; capacity: number }>;
    byHour: Array<{ hour: number; players: number }>;
    daily: Array<{ date: string; players: number; capacity: number }>;
  };
  revenue: {
    totalMinor: number; // commandes des réservations confirmées
    byKind: Record<string, number>;
    cancellationFeesMinor: number;
    collectedMinor: number; // paiements confirmés − remboursements confirmés
    byMethod: Record<string, number>;
    outstandingMinor: number; // reste à encaisser
    refundDueMinor: number; // trop-perçus à rembourser
  };
  caddies: { teeTimesWithCaddie: number; named: number };
  equipment: Array<{ code: string; name: string; units: number }>;
  customers: { distinct: number; firstTimeInPeriod: number };
}

export function validatePeriod(from: string, to: string): { days: number } {
  const f = DateTime.fromISO(from);
  const t = DateTime.fromISO(to);
  if (!f.isValid || !t.isValid || t < f) throw new DomainError('VALIDATION', 'Période invalide.');
  const days = Math.round(t.diff(f, 'days').days) + 1;
  if (days > MAX_REPORT_DAYS) throw new DomainError('VALIDATION', `Période limitée à ${MAX_REPORT_DAYS} jours.`);
  return { days };
}

const byKey = (rows: Array<{ k: string | number; v: number }>) => Object.fromEntries(rows.map((r) => [String(r.k), r.v]));

export async function computeReportData(q: Queryable, clubId: string, from: string, to: string): Promise<ReportData> {
  const { days } = validatePeriod(from, to);
  const club = await getClub(q, clubId);
  const P = [clubId, from, to];
  const inPeriod = `t.club_id = $1 AND t.local_date BETWEEN $2 AND $3`;

  // Capacité offerte : grille de chaque parcours, chaque jour.
  const courses = await listCourses(q, clubId);
  const daily = new Map<string, { players: number; capacity: number }>();
  for (let d = DateTime.fromISO(from); d <= DateTime.fromISO(to); d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    let capacity = 0;
    for (const course of courses) capacity += (await computeGrid(q, club, course, date)).reduce((n, s) => n + s.maxPlayers, 0);
    daily.set(date, { players: 0, capacity });
  }

  const [act, channels, holes, perDay, perHour, cancels, revenue, kinds, fees, pay, methods, balance, caddies, equipment, customers] = await Promise.all([
    q.query(`SELECT count(DISTINCT t.id)::int AS tee_times, count(b.id)::int AS bookings, coalesce(sum(b.players), 0)::int AS players,
                    count(DISTINCT t.id) FILTER (WHERE t.is_private)::int AS private
               FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed' WHERE ${inPeriod}`, P),
    q.query(`SELECT b.channel AS k, count(*)::int AS v FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
              WHERE ${inPeriod} GROUP BY 1`, P),
    q.query(`SELECT b.holes AS k, sum(b.players)::int AS v FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
              WHERE ${inPeriod} GROUP BY 1`, P),
    q.query(`SELECT t.local_date AS d, sum(b.players)::int AS v FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
              WHERE ${inPeriod} GROUP BY 1`, P),
    q.query(`SELECT extract(hour FROM t.starts_at AT TIME ZONE $4)::int AS k, sum(b.players)::int AS v
               FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
              WHERE ${inPeriod} GROUP BY 1 ORDER BY 1`, [...P, club.timezone]),
    q.query(`SELECT count(*)::int AS n FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'cancelled' WHERE ${inPeriod}`, P),
    q.query(`SELECT coalesce(sum(o.total_minor), 0)::int AS v FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
               JOIN orders o ON o.booking_id = b.id WHERE ${inPeriod}`, P),
    q.query(`SELECT ol.kind AS k, sum(ol.total_minor)::int AS v FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
               JOIN orders o ON o.booking_id = b.id JOIN order_lines ol ON ol.order_id = o.id WHERE ${inPeriod} GROUP BY 1`, P),
    q.query(`SELECT coalesce(sum(o.total_minor), 0)::int AS v FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'cancelled'
               JOIN orders o ON o.booking_id = b.id WHERE ${inPeriod}`, P),
    q.query(`SELECT coalesce((SELECT sum(p.amount_minor) FROM payments p JOIN orders o ON o.id = p.order_id JOIN bookings b ON b.id = o.booking_id
                               JOIN tee_times t ON t.id = b.tee_time_id WHERE ${inPeriod} AND p.status = 'confirmed'), 0)::int
                  - coalesce((SELECT sum(r.amount_minor) FROM refunds r JOIN orders o ON o.id = r.order_id JOIN bookings b ON b.id = o.booking_id
                               JOIN tee_times t ON t.id = b.tee_time_id WHERE ${inPeriod} AND r.status = 'confirmed'), 0)::int AS v`, P),
    q.query(`SELECT p.method AS k, sum(p.amount_minor)::int AS v FROM payments p JOIN orders o ON o.id = p.order_id
               JOIN bookings b ON b.id = o.booking_id JOIN tee_times t ON t.id = b.tee_time_id
              WHERE ${inPeriod} AND p.status = 'confirmed' GROUP BY 1`, P),
    q.query(`WITH per_order AS (
               SELECT o.total_minor
                      - coalesce((SELECT sum(amount_minor) FROM payments WHERE order_id = o.id AND status = 'confirmed'), 0)
                      + coalesce((SELECT sum(amount_minor) FROM refunds WHERE order_id = o.id AND status = 'confirmed'), 0) AS balance
                 FROM orders o JOIN bookings b ON b.id = o.booking_id JOIN tee_times t ON t.id = b.tee_time_id WHERE ${inPeriod})
             SELECT coalesce(sum(balance) FILTER (WHERE balance > 0), 0)::int AS due, coalesce(-sum(balance) FILTER (WHERE balance < 0), 0)::int AS refund
               FROM per_order`, P),
    q.query(`SELECT count(DISTINCT t.id) FILTER (WHERE a.id IS NOT NULL)::int AS with_caddie,
                    count(DISTINCT t.id) FILTER (WHERE t.caddie_id IS NOT NULL)::int AS named
               FROM tee_times t
               JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
               LEFT JOIN resource_allocations a ON a.tee_time_id = t.id AND a.status = 'active'
              WHERE ${inPeriod}`, P),
    q.query(`SELECT rt.code, rt.name, sum(a.quantity)::int AS units
               FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed'
               JOIN resource_allocations a ON a.booking_id = b.id AND a.status = 'active'
               JOIN resource_types rt ON rt.id = a.resource_type_id
              WHERE ${inPeriod} GROUP BY rt.code, rt.name, rt.sort_order ORDER BY rt.sort_order`, P),
    q.query(`SELECT count(DISTINCT b.customer_id)::int AS distinct_customers,
                    count(DISTINCT b.customer_id) FILTER (WHERE NOT EXISTS (
                      SELECT 1 FROM bookings b2 JOIN tee_times t2 ON t2.id = b2.tee_time_id
                       WHERE b2.customer_id = b.customer_id AND b2.club_id = $1 AND t2.local_date < $2))::int AS first_time
               FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id AND b.status = 'confirmed' WHERE ${inPeriod}`, P),
  ]);

  for (const r of perDay.rows) {
    const d = daily.get(r.d);
    if (d) d.players = r.v;
  }
  const dailyArr = [...daily.entries()].map(([date, v]) => ({ date, ...v }));
  const byWeekday = [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const ds = dailyArr.filter((d) => DateTime.fromISO(d.date).weekday === weekday);
    return { weekday, players: ds.reduce((n, d) => n + d.players, 0), capacity: ds.reduce((n, d) => n + d.capacity, 0) };
  });
  const a = act.rows[0];
  const capacity = dailyArr.reduce((n, d) => n + d.capacity, 0);
  const round = (x: number) => Math.round(x * 1000) / 1000;

  return {
    club: { id: club.id, name: club.name, currency: club.currency, timezone: club.timezone },
    period: { from, to, days },
    activity: {
      teeTimesUsed: a.tee_times, bookings: a.bookings, players: a.players, capacityPlayers: capacity,
      occupancyRate: capacity ? round(a.players / capacity) : 0,
      avgPlayersPerTeeTime: a.tee_times ? round(a.players / a.tee_times) : 0,
      privateTeeTimes: a.private, cancellations: cancels.rows[0].n,
      byChannel: byKey(channels.rows), byHoles: byKey(holes.rows), byWeekday,
      byHour: perHour.rows.map((r) => ({ hour: r.k, players: r.v })), daily: dailyArr,
    },
    revenue: {
      totalMinor: revenue.rows[0].v, byKind: byKey(kinds.rows), cancellationFeesMinor: fees.rows[0].v,
      collectedMinor: pay.rows[0].v, byMethod: byKey(methods.rows),
      outstandingMinor: balance.rows[0].due, refundDueMinor: balance.rows[0].refund,
    },
    caddies: { teeTimesWithCaddie: caddies.rows[0].with_caddie, named: caddies.rows[0].named },
    equipment: equipment.rows,
    customers: { distinct: customers.rows[0].distinct_customers, firstTimeInPeriod: customers.rows[0].first_time },
  };
}

const LANGUAGE: Record<string, string> = { fr: 'français', en: 'English', ar: 'العربية (arabe)', es: 'español' };

const REPORT_SYSTEM = `Tu es l'analyste d'un logiciel de gestion de golf. Tu rédiges un rapport d'activité pour la direction d'un golf à partir de données chiffrées fournies en JSON.

Règles :
- N'utilise QUE les chiffres fournis. Ne calcule rien d'autre que des pourcentages ou écarts simples entre chiffres fournis, et n'invente aucune donnée (pas de comparaison avec une période non fournie).
- Les montants sont en unités mineures (centimes) : divise par 100 et affiche la devise indiquée.
- occupancyRate est un ratio (0,42 = 42 %).
- Si les données sont trop faibles pour conclure, dis-le simplement.
- Format Markdown : un titre, puis les sections « Synthèse », « Remplissage et fréquentation », « Chiffre d'affaires et encaissements », « Caddies et matériel », « Points d'attention », « Recommandations » (3 à 5 actions concrètes et réalistes pour un golf).
- Style clair et professionnel, phrases courtes, pas de jargon technique ni de noms de champs JSON.`;

export async function generateReport(
  db: Db,
  model: AiModel | null,
  input: { clubId: string; from: string; to: string; focus?: string | null; locale?: string; actor: Actor },
) {
  const ai = requireModel(model);
  const data = await computeReportData(db, input.clubId, input.from, input.to);
  const locale = LANGUAGE[input.locale ?? 'fr'] ? input.locale ?? 'fr' : 'fr';
  let content: string;
  try {
    const response = await ai.create({
      max_tokens: 16000,
      system: REPORT_SYSTEM,
      cache_control: { type: 'ephemeral' },
      thinking: { type: 'adaptive' },
      output_config: { effort: (process.env.AI_REPORT_EFFORT as 'high') ?? 'high' },
      messages: [{
        role: 'user',
        content: `Rédige le rapport en ${LANGUAGE[locale]}.${input.focus ? `\nDemande particulière de la direction : ${input.focus}` : ''}\n\nDonnées :\n${JSON.stringify(data)}`,
      }],
    });
    if (response.stop_reason === 'refusal') throw new DomainError('AI_UNAVAILABLE', "L'IA n'a pas pu rédiger ce rapport.");
    content = textOf(response);
    if (!content) throw new DomainError('AI_UNAVAILABLE', "L'IA n'a renvoyé aucun texte.");
  } catch (err) {
    if (err instanceof DomainError) throw err;
    aiError(err);
  }
  const { rows } = await db.query(
    `INSERT INTO ai_reports (club_id, created_by, period_from, period_to, focus, locale, data, content, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at AS "createdAt"`,
    [input.clubId, input.actor.id ?? null, input.from, input.to, input.focus ?? null, locale, data, content, ai.name],
  );
  return { id: rows[0].id, createdAt: rows[0].createdAt, data, content, model: ai.name };
}

export async function listReports(q: Queryable, clubId: string) {
  const { rows } = await q.query(
    `SELECT r.id, r.period_from AS "from", r.period_to AS "to", r.focus, r.locale, r.model, r.created_at AS "createdAt",
            u.display_name AS "createdBy"
       FROM ai_reports r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.club_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [clubId],
  );
  return rows;
}

export async function getReport(q: Queryable, id: string) {
  const { rows } = await q.query(
    `SELECT id, club_id AS "clubId", period_from AS "from", period_to AS "to", focus, locale, data, content, model, created_at AS "createdAt"
       FROM ai_reports WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Rapport introuvable.');
  return rows[0];
}

