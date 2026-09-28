// Rapports modulables : indicateurs à la carte sur un ou plusieurs golfs, avec
// filtres libres et comparaison. Tous les chiffres sont calculés en SQL.
//
// Périmètre : réservations dont le DÉPART est dans la période (date locale).
// Chiffre d'affaires = commandes des réservations confirmées (TTC).
// Encaissé = paiements confirmés − remboursements confirmés sur ces commandes.

import { DateTime } from 'luxon';
import type { Queryable } from '../../db/pool.js';
import { generateDaySlots } from '../../domain/schedule.js';
import { csvMoney, toCsv } from '../../shared/csv.js';
import { DomainError } from '../../shared/errors.js';
import { isoWeekday } from '../../shared/time.js';
import { getClub, listCourses, listScheduleRules, type Club } from '../catalog/repository.js';

export const BLOCKS = [
  'kpis', 'revenue', 'clubs', 'channels', 'categories', 'partners', 'weekdays', 'hours', 'daily', 'payments', 'caddies', 'customers',
] as const;
export type BlockId = (typeof BLOCKS)[number];
export const DEFAULT_BLOCKS: BlockId[] = ['kpis', 'revenue', 'channels', 'weekdays', 'hours', 'payments'];
export const MAX_DAYS = 366;

export interface ReportConfig {
  clubIds: string[];
  from: string;
  to: string;
  courseId?: string | null;
  channels?: string[] | null;
  partnerId?: string | null;
  categories?: string[] | null;
  compare?: 'none' | 'previous' | 'last_year';
  blocks: BlockId[];
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

/** Places offertes par la grille, par golf et par jour (règles chargées une fois par golf). */
async function capacity(q: Queryable, clubs: Club[], from: string, to: string, courseId: string | null) {
  const byClub = new Map<string, number>();
  const byDate = new Map<string, number>();
  const byWeekday = new Map<number, number>();
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
  }
  return { byClub, byDate, byWeekday, total: [...byClub.values()].reduce((a, b) => a + b, 0) };
}

async function kpis(q: Queryable, scope: string, P: unknown[]) {
  const { rows: [r] } = await q.query(
    `SELECT count(b.id) FILTER (WHERE b.status = 'confirmed')::int AS bookings,
            coalesce(sum(b.players) FILTER (WHERE b.status = 'confirmed'), 0)::int AS players,
            count(DISTINCT t.id) FILTER (WHERE b.status = 'confirmed')::int AS "teeTimes",
            count(b.id) FILTER (WHERE b.status = 'cancelled')::int AS cancellations,
            count(b.id) FILTER (WHERE b.status = 'confirmed' AND b.checkin_status = 'no_show')::int AS "noShows",
            coalesce(sum(o.total_minor) FILTER (WHERE b.status = 'confirmed'), 0)::int AS "revenueMinor",
            coalesce(sum((SELECT coalesce(sum(p.amount_minor), 0) FROM payments p WHERE p.order_id = o.id AND p.status = 'confirmed')
                       - (SELECT coalesce(sum(r.amount_minor), 0) FROM refunds r WHERE r.order_id = o.id AND r.status = 'confirmed')), 0)::int AS "collectedMinor"
       FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id LEFT JOIN orders o ON o.booking_id = b.id
      WHERE ${scope}`, P);
  return r as { bookings: number; players: number; teeTimes: number; cancellations: number; noShows: number; revenueMinor: number; collectedMinor: number };
}

export async function computeAnalytics(q: Queryable, cfg: ReportConfig) {
  validate(cfg);
  const clubs = await Promise.all(cfg.clubIds.map((id) => getClub(q, id)));
  const currencies = [...new Set(clubs.map((c) => c.currency))];
  if (currencies.length > 1) throw new DomainError('VALIDATION', 'Golfs de devises différentes : les comparer séparément.');
  const courseId = cfg.courseId && clubs.length === 1 ? cfg.courseId : null;

  const scopeFor = (from: string, to: string) => ({
    P: [cfg.clubIds, from, to, courseId, cfg.channels?.length ? cfg.channels : null, cfg.partnerId ?? null,
      cfg.categories?.length ? cfg.categories : null],
  });
  const SCOPE = `t.club_id = ANY($1::uuid[]) AND t.local_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR t.course_id = $4)
    AND ($5::text[] IS NULL OR b.channel = ANY($5)) AND ($6::uuid IS NULL OR b.partner_id = $6) AND ($7::text[] IS NULL OR b.customer_category = ANY($7))`;
  const CONFIRMED = `${SCOPE} AND b.status = 'confirmed'`;
  const { P } = scopeFor(cfg.from, cfg.to);
  const want = new Set(cfg.blocks);
  const needCapacity = want.has('kpis') || want.has('clubs') || want.has('weekdays') || want.has('daily');
  const cap = needCapacity ? await capacity(q, clubs, cfg.from, cfg.to, courseId) : null;

  const result: Record<string, unknown> = {};
  const withRate = (k: Awaited<ReturnType<typeof kpis>>, capTotal: number) => ({
    ...k, capacity: capTotal, occupancyRate: capTotal ? k.players / capTotal : 0, avgPlayersPerTeeTime: k.teeTimes ? k.players / k.teeTimes : 0,
  });

  if (want.has('kpis')) {
    const current = withRate(await kpis(q, SCOPE, P), cap!.total);
    const cmp = comparisonPeriod(cfg.from, cfg.to, cfg.compare);
    let previous = null;
    if (cmp) {
      const prevCap = await capacity(q, clubs, cmp.from, cmp.to, courseId);
      previous = { ...withRate(await kpis(q, SCOPE, scopeFor(cmp.from, cmp.to).P), prevCap.total), from: cmp.from, to: cmp.to };
    }
    result.kpis = { current, previous };
  }
  if (want.has('revenue')) {
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
  if (want.has('clubs')) {
    const { rows } = await q.query(
      `SELECT t.club_id AS "clubId", count(b.id)::int AS bookings, sum(b.players)::int AS players, coalesce(sum(o.total_minor), 0)::int AS "revenueMinor"
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id LEFT JOIN orders o ON o.booking_id = b.id WHERE ${CONFIRMED} GROUP BY 1`, P);
    result.clubs = clubs.map((c) => {
      const r = rows.find((x) => x.clubId === c.id) ?? { bookings: 0, players: 0, revenueMinor: 0 };
      const capC = cap!.byClub.get(c.id) ?? 0;
      return { clubId: c.id, name: c.name, bookings: r.bookings, players: r.players, revenueMinor: r.revenueMinor, capacity: capC,
        occupancyRate: capC ? r.players / capC : 0 };
    });
  }
  const groupBy = async (expr: string, extraJoin = '') => (await q.query(
    `SELECT ${expr} AS key, count(b.id)::int AS bookings, sum(b.players)::int AS players, coalesce(sum(o.total_minor), 0)::int AS "revenueMinor"
       FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id LEFT JOIN orders o ON o.booking_id = b.id ${extraJoin}
      WHERE ${CONFIRMED} GROUP BY 1 ORDER BY players DESC`, P)).rows;
  if (want.has('channels')) result.channels = await groupBy('b.channel');
  if (want.has('categories')) result.categories = await groupBy('b.customer_category');
  if (want.has('partners')) {
    const { rows } = await q.query(
      `SELECT p.id AS key, p.name, count(b.id)::int AS bookings, sum(b.players)::int AS players,
              coalesce(sum((SELECT sum(ol.total_minor) FROM order_lines ol WHERE ol.order_id = o.id AND ol.payer = 'partner')), 0)::int AS "partnerMinor",
              coalesce(sum(o.total_minor), 0)::int AS "revenueMinor"
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id JOIN partners p ON p.id = b.partner_id LEFT JOIN orders o ON o.booking_id = b.id
        WHERE ${CONFIRMED} GROUP BY p.id, p.name ORDER BY players DESC`, P);
    result.partners = rows;
  }
  if (want.has('weekdays')) {
    const { rows } = await q.query(
      `SELECT extract(isodow FROM t.local_date)::int AS wd, sum(b.players)::int AS players
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id WHERE ${CONFIRMED} GROUP BY 1`, P);
    result.weekdays = [1, 2, 3, 4, 5, 6, 7].map((wd) => {
      const players = rows.find((r) => r.wd === wd)?.players ?? 0;
      const c = cap!.byWeekday.get(wd) ?? 0;
      return { weekday: wd, players, capacity: c, occupancyRate: c ? players / c : 0 };
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
      `SELECT to_char(t.local_date, 'YYYY-MM-DD') AS date, sum(b.players)::int AS players, coalesce(sum(o.total_minor), 0)::int AS "revenueMinor"
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id LEFT JOIN orders o ON o.booking_id = b.id WHERE ${CONFIRMED} GROUP BY 1`, P);
    result.daily = [...cap!.byDate.entries()].map(([date, c]) => {
      const r = rows.find((x) => x.date === date);
      return { date, players: r?.players ?? 0, revenueMinor: r?.revenueMinor ?? 0, capacity: c, occupancyRate: c ? (r?.players ?? 0) / c : 0 };
    });
  }
  if (want.has('payments')) {
    const { rows } = await q.query(
      `SELECT m.method, sum(m.paid)::int AS "paidMinor", sum(m.refunded)::int AS "refundedMinor" FROM (
         SELECT p.method, p.amount_minor AS paid, 0 AS refunded FROM payments p JOIN orders o ON o.id = p.order_id JOIN bookings b ON b.id = o.booking_id
           JOIN tee_times t ON t.id = b.tee_time_id WHERE ${SCOPE} AND p.status = 'confirmed'
         UNION ALL
         SELECT r.method, 0, r.amount_minor FROM refunds r JOIN orders o ON o.id = r.order_id JOIN bookings b ON b.id = o.booking_id
           JOIN tee_times t ON t.id = b.tee_time_id WHERE ${SCOPE} AND r.status = 'confirmed') m
       GROUP BY 1 ORDER BY 2 DESC`, P);
    const { rows: [bal] } = await q.query(
      `WITH per_order AS (
         SELECT o.total_minor - coalesce((SELECT sum(amount_minor) FROM payments WHERE order_id = o.id AND status = 'confirmed'), 0)
                + coalesce((SELECT sum(amount_minor) FROM refunds WHERE order_id = o.id AND status = 'confirmed'), 0) AS balance
           FROM orders o JOIN bookings b ON b.id = o.booking_id JOIN tee_times t ON t.id = b.tee_time_id WHERE ${SCOPE})
       SELECT coalesce(sum(balance) FILTER (WHERE balance > 0), 0)::int AS due, coalesce(-sum(balance) FILTER (WHERE balance < 0), 0)::int AS refund FROM per_order`, P);
    result.payments = { byMethod: rows, outstandingMinor: bal.due, refundDueMinor: bal.refund };
  }
  if (want.has('caddies')) {
    const { rows: [c] } = await q.query(
      `SELECT count(DISTINCT t.id) FILTER (WHERE a.id IS NOT NULL)::int AS "withCaddie", count(DISTINCT t.id) FILTER (WHERE t.caddie_id IS NOT NULL)::int AS named,
              count(DISTINCT t.id)::int AS "teeTimes"
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id
         LEFT JOIN resource_allocations a ON a.tee_time_id = t.id AND a.status = 'active' AND a.booking_id IS NULL
        WHERE ${CONFIRMED}`, P);
    const { rows: equipment } = await q.query(
      `SELECT rt.name, sum(a.quantity)::int AS units FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id
         JOIN resource_allocations a ON a.booking_id = b.id AND a.status = 'active' JOIN resource_types rt ON rt.id = a.resource_type_id
        WHERE ${CONFIRMED} AND rt.scope = 'booking' GROUP BY rt.name ORDER BY 2 DESC`, P);
    result.caddies = { ...c, equipment };
  }
  if (want.has('customers')) {
    const { rows: [c] } = await q.query(
      `SELECT count(DISTINCT b.customer_id)::int AS distinct,
              count(DISTINCT b.customer_id) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM bookings b2 JOIN tee_times t2 ON t2.id = b2.tee_time_id
                 WHERE b2.customer_id = b.customer_id AND b2.club_id = ANY($1::uuid[]) AND t2.local_date < $2 AND b2.status = 'confirmed'))::int AS "firstTime",
              count(DISTINCT b.customer_id) FILTER (WHERE EXISTS (
                SELECT 1 FROM memberships m WHERE m.customer_id = b.customer_id AND m.club_id = t.club_id AND m.status = 'active'
                   AND t.local_date BETWEEN m.valid_from AND m.valid_to))::int AS members
         FROM tee_times t JOIN bookings b ON b.tee_time_id = t.id WHERE ${CONFIRMED}`, P);
    result.customers = c;
  }
  return {
    currency: currencies[0]!,
    clubs: clubs.map((c) => ({ id: c.id, name: c.name })),
    period: { from: cfg.from, to: cfg.to },
    filters: { courseId, channels: cfg.channels ?? null, partnerId: cfg.partnerId ?? null, categories: cfg.categories ?? null, compare: cfg.compare ?? 'none' },
    blocks: cfg.blocks.filter((b) => b in result),
    data: result as Record<BlockId, any>,
  };
}

export type AnalyticsResult = Awaited<ReturnType<typeof computeAnalytics>>;

// ---------------------------------------------------------------------------
// Libellés, export CSV, rendu HTML (e-mail)

export const BLOCK_LABELS: Record<BlockId, string> = {
  kpis: 'Chiffres clés', revenue: "Chiffre d'affaires", clubs: 'Par golf', channels: 'Par canal', categories: 'Par catégorie de client',
  partners: 'Tour-opérateurs et partenaires', weekdays: 'Par jour de la semaine', hours: 'Par heure de départ', daily: 'Jour par jour',
  payments: 'Encaissements', caddies: 'Caddies et matériel', customers: 'Clientèle',
};
const CHANNEL: Record<string, string> = { web: 'Web', phone: 'Téléphone', group: 'Groupe', walk_in: 'Sur place', staff: 'Personnel', whatsapp: 'WhatsApp', sms: 'SMS', partner: 'Portail partenaire' };
const KIND: Record<string, string> = { green_fee: 'Green fees', caddie: 'Caddies', resource: 'Matériel', private_surcharge: 'Suppléments privés', cancellation_fee: "Frais d'annulation", no_show_fee: "Frais d'absence" };
const METHOD: Record<string, string> = { cash: 'Espèces', card_terminal: 'Carte (TPE)', bank_transfer: 'Virement', online: 'En ligne', pos: 'Caisse', other: 'Autre' };
const WEEKDAY = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const pct = (x: number) => `${(Math.round(x * 1000) / 10).toString().replace('.', ',')} %`;

/** Tableaux (titre, en-têtes, lignes) : base commune du CSV et de l'e-mail. */
export function reportTables(r: AnalyticsResult, fmtMoney: (m: number) => string): Array<{ title: string; head: string[]; rows: unknown[][] }> {
  const d = r.data;
  const out: Array<{ title: string; head: string[]; rows: unknown[][] }> = [];
  for (const b of r.blocks) {
    const title = BLOCK_LABELS[b];
    if (b === 'kpis') {
      const c = d.kpis.current;
      const p = d.kpis.previous;
      const line = (label: string, key: string, f: (x: number) => string = String) =>
        [label, f(c[key]), ...(p ? [f(p[key]), p[key] ? pct((c[key] - p[key]) / p[key]) : '—'] : [])];
      out.push({ title, head: ['Indicateur', 'Période', ...(p ? [`${p.from} → ${p.to}`, 'Évolution'] : [])], rows: [
        line('Réservations', 'bookings'), line('Joueurs', 'players'), line('Places offertes', 'capacity'),
        line('Taux de remplissage', 'occupancyRate', pct), line('Joueurs par départ', 'avgPlayersPerTeeTime', (x) => x.toFixed(1).replace('.', ',')),
        line("Chiffre d'affaires", 'revenueMinor', fmtMoney), line('Encaissé', 'collectedMinor', fmtMoney),
        line('Annulations', 'cancellations'), line('Absences', 'noShows'),
      ] });
    }
    if (b === 'revenue') out.push({ title, head: ['Poste', 'Montant'], rows: [
      ...Object.entries(d.revenue.byKind).map(([k, v]) => [KIND[k] ?? k, fmtMoney(v as number)]),
      ['Total', fmtMoney(d.revenue.totalMinor)],
      ['dont payé par les clients', fmtMoney(d.revenue.byPayer.customer ?? 0)], ['dont payé par les partenaires', fmtMoney(d.revenue.byPayer.partner ?? 0)],
      ["Frais d'annulation (réservations annulées)", fmtMoney(d.revenue.cancellationFeesMinor)],
    ] });
    if (b === 'clubs') out.push({ title, head: ['Golf', 'Réservations', 'Joueurs', 'Remplissage', "Chiffre d'affaires"],
      rows: d.clubs.map((c: any) => [c.name, c.bookings, c.players, pct(c.occupancyRate), fmtMoney(c.revenueMinor)]) });
    const grouped = (label: (k: string) => string) => ({ head: ['', 'Réservations', 'Joueurs', "Chiffre d'affaires"] as string[],
      rows: (x: any[]) => x.map((g) => [label(g.key), g.bookings, g.players, fmtMoney(g.revenueMinor)]) });
    if (b === 'channels') { const g = grouped((k) => CHANNEL[k] ?? k); out.push({ title, head: ['Canal', ...g.head.slice(1)], rows: g.rows(d.channels) }); }
    if (b === 'categories') { const g = grouped((k) => k); out.push({ title, head: ['Catégorie', ...g.head.slice(1)], rows: g.rows(d.categories) }); }
    if (b === 'partners') out.push({ title, head: ['Partenaire', 'Réservations', 'Joueurs', 'Part partenaire', 'Total'],
      rows: d.partners.map((p: any) => [p.name, p.bookings, p.players, fmtMoney(p.partnerMinor), fmtMoney(p.revenueMinor)]) });
    if (b === 'weekdays') out.push({ title, head: ['Jour', 'Joueurs', 'Places', 'Remplissage'],
      rows: d.weekdays.map((w: any) => [WEEKDAY[w.weekday], w.players, w.capacity, pct(w.occupancyRate)]) });
    if (b === 'hours') out.push({ title, head: ['Heure', 'Joueurs'], rows: d.hours.map((h: any) => [`${String(h.hour).padStart(2, '0')} h`, h.players]) });
    if (b === 'daily') out.push({ title, head: ['Date', 'Joueurs', 'Places', 'Remplissage', "Chiffre d'affaires"],
      rows: d.daily.map((x: any) => [x.date, x.players, x.capacity, pct(x.occupancyRate), fmtMoney(x.revenueMinor)]) });
    if (b === 'payments') out.push({ title, head: ['Mode', 'Encaissé', 'Remboursé'], rows: [
      ...d.payments.byMethod.map((m: any) => [METHOD[m.method] ?? m.method, fmtMoney(m.paidMinor), fmtMoney(m.refundedMinor)]),
      ['Reste à encaisser', fmtMoney(d.payments.outstandingMinor), ''], ['À rembourser', fmtMoney(d.payments.refundDueMinor), ''],
    ] });
    if (b === 'caddies') out.push({ title, head: ['', 'Valeur'], rows: [
      ['Départs', d.caddies.teeTimes], ['Départs avec caddie', d.caddies.withCaddie], ['dont caddie nommé', d.caddies.named],
      ...d.caddies.equipment.map((e: any) => [e.name, `${e.units} location(s)`]),
    ] });
    if (b === 'customers') out.push({ title, head: ['', 'Valeur'], rows: [
      ['Clients distincts', d.customers.distinct], ['dont nouveaux', d.customers.firstTime], ['dont membres', d.customers.members],
    ] });
  }
  return out;
}

export function analyticsCsv(r: AnalyticsResult): string {
  const lines: unknown[][] = [[`Rapport ${r.clubs.map((c) => c.name).join(', ')}`], [`Période du ${r.period.from} au ${r.period.to}`], []];
  for (const t of reportTables(r, csvMoney)) lines.push([t.title], t.head, ...t.rows, []);
  return toCsv(lines);
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function analyticsHtml(r: AnalyticsResult, title: string): string {
  const money = (m: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: r.currency, maximumFractionDigits: 0 }).format(m / 100);
  const tables = reportTables(r, money).map((t) => `
    <h2 style="font-family:Georgia,serif;font-weight:500;font-size:18px;margin:24px 0 8px">${esc(t.title)}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr>${t.head.map((h, i) => `<th style="text-align:${i ? 'right' : 'left'};padding:6px 4px;border-bottom:2px solid #DDD9CE;color:#5C625E">${esc(h)}</th>`).join('')}</tr>
      ${t.rows.map((row) => `<tr>${row.map((c, i) => `<td style="text-align:${i ? 'right' : 'left'};padding:6px 4px;border-bottom:1px solid #EFEDE6">${esc(c)}</td>`).join('')}</tr>`).join('')}
    </table>`).join('');
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#F7F6F2;font-family:'Segoe UI',Arial,sans-serif;color:#1A1D1B">
<div style="max-width:720px;margin:0 auto;padding:24px"><div style="background:#fff;border:1px solid #DDD9CE;border-radius:12px;padding:24px">
<h1 style="font-family:Georgia,serif;font-weight:500;font-size:26px;margin:0 0 4px">${esc(title)}</h1>
<p style="color:#5C625E;margin:0">${esc(r.clubs.map((c) => c.name).join(', '))} · du ${esc(r.period.from)} au ${esc(r.period.to)}</p>
${tables}
<p style="color:#5C625E;font-size:12px;margin-top:24px">Chiffres calculés par Resa. Le détail est joint au format Excel (CSV).</p>
</div></div></body></html>`;
}
