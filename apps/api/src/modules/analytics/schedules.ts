// Envois programmés de rapports (hebdomadaire / mensuel) par e-mail : tableau
// en HTML + détail en CSV. Les droits du créateur sont revérifiés à chaque
// envoi (un compte désactivé ou sans accès au rapport n'envoie plus rien).

import { DateTime } from 'luxon';
import type { Db, Queryable } from '../../db/pool.js';
import { emailFrom, type EmailSender } from '../../integrations/email/sender.js';
import { audit, type Actor } from '../../shared/audit.js';
import { DomainError } from '../../shared/errors.js';
import { can, type Principal } from '../auth/permissions.js';
import { loadPrincipal } from '../auth/service.js';
import { getClub } from '../catalog/repository.js';
import { analyticsCsv, analyticsHtml, computeAnalytics, type ReportConfig } from './service.js';

export type Frequency = 'weekly' | 'monthly';
export type PeriodPreset = 'previous_week' | 'previous_month' | 'last_7_days' | 'last_30_days' | 'month_to_date';
export type ScheduleConfig = Omit<ReportConfig, 'from' | 'to'> & { period: PeriodPreset };

const TZ = 'Africa/Casablanca';

/** Prochain envoi : lundi 7 h (hebdomadaire) ou le 1er du mois 7 h (mensuel), heure du golf. */
export function nextRun(frequency: Frequency, after: Date, timezone = TZ): Date {
  const now = DateTime.fromJSDate(after, { zone: timezone });
  let next = frequency === 'weekly'
    ? now.startOf('week').set({ hour: 7 })
    : now.startOf('month').set({ hour: 7 });
  while (next <= now) next = frequency === 'weekly' ? next.plus({ weeks: 1 }) : next.plus({ months: 1 });
  return next.toJSDate();
}

export function resolvePeriod(preset: PeriodPreset, at: Date, timezone = TZ): { from: string; to: string } {
  const today = DateTime.fromJSDate(at, { zone: timezone }).startOf('day');
  const iso = (d: DateTime) => d.toISODate()!;
  switch (preset) {
    case 'previous_week': { const start = today.startOf('week').minus({ weeks: 1 }); return { from: iso(start), to: iso(start.plus({ days: 6 })) }; }
    case 'previous_month': { const start = today.startOf('month').minus({ months: 1 }); return { from: iso(start), to: iso(start.endOf('month')) }; }
    case 'last_7_days': return { from: iso(today.minus({ days: 7 })), to: iso(today.minus({ days: 1 })) };
    case 'last_30_days': return { from: iso(today.minus({ days: 30 })), to: iso(today.minus({ days: 1 })) };
    case 'month_to_date': return { from: iso(today.startOf('month')), to: iso(today) };
  }
}

async function assertReportsAccess(q: Queryable, p: Principal, clubIds: string[]) {
  for (const id of clubIds) {
    const club = await getClub(q, id);
    if (!can(p, 'reports.view', club)) throw new DomainError('FORBIDDEN', 'Accès aux rapports refusé pour un des golfs.');
  }
}

const COLUMNS = `id, name, frequency, recipients, config, active, next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
  last_status AS "lastStatus", last_error AS "lastError", created_by AS "createdBy", created_at AS "createdAt"`;

export async function listSchedules(q: Queryable, p: Principal) {
  const { rows } = await q.query(`SELECT ${COLUMNS} FROM report_schedules WHERE organization_id = $1 ORDER BY created_at DESC`, [p.organizationId]);
  // Chacun ne voit que les envois portant sur des golfs dont il voit les rapports.
  const visible = [];
  for (const r of rows) {
    try { await assertReportsAccess(q, p, r.config.clubIds); visible.push(r); } catch { /* masqué */ }
  }
  return visible;
}

export async function createSchedule(db: Db, p: Principal, input: { name: string; frequency: Frequency; recipients: string[]; config: ScheduleConfig }, now: Date, actor: Actor) {
  await assertReportsAccess(db, p, input.config.clubIds);
  const { rows } = await db.query(
    `INSERT INTO report_schedules (organization_id, created_by, name, frequency, recipients, config, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
    [p.organizationId, p.userId, input.name.trim(), input.frequency, input.recipients, input.config, nextRun(input.frequency, now)],
  );
  await audit(db, { clubId: null, actor, action: 'report_schedule.created', entityType: 'report_schedule', entityId: rows[0].id,
    data: { frequency: input.frequency, recipients: input.recipients.length } });
  return rows[0];
}

async function ownSchedule(q: Queryable, p: Principal, id: string) {
  const { rows } = await q.query(`SELECT ${COLUMNS} FROM report_schedules WHERE id = $1 AND organization_id = $2`, [id, p.organizationId]);
  if (!rows[0]) throw new DomainError('NOT_FOUND', 'Envoi programmé introuvable.');
  await assertReportsAccess(q, p, rows[0].config.clubIds);
  return rows[0];
}

export async function setScheduleActive(db: Db, p: Principal, id: string, active: boolean, now: Date) {
  const s = await ownSchedule(db, p, id);
  await db.query('UPDATE report_schedules SET active = $2, next_run_at = $3 WHERE id = $1', [id, active, nextRun(s.frequency, now)]);
}

export async function deleteSchedule(db: Db, p: Principal, id: string, actor: Actor) {
  await ownSchedule(db, p, id);
  await db.query('DELETE FROM report_schedules WHERE id = $1', [id]);
  await audit(db, { clubId: null, actor, action: 'report_schedule.deleted', entityType: 'report_schedule', entityId: id });
}

/** Calcule et envoie un rapport programmé (droits du créateur revérifiés). */
async function run(db: Db, sender: EmailSender, s: any, now: Date): Promise<'sent' | 'logged'> {
  const creator = await loadPrincipal(db, s.createdBy);
  if (!creator) throw new DomainError('FORBIDDEN', 'Compte du créateur désactivé.');
  await assertReportsAccess(db, creator, s.config.clubIds);
  const { period, ...rest } = s.config as ScheduleConfig;
  const result = await computeAnalytics(db, { ...rest, ...resolvePeriod(period, now) });
  const title = s.name as string;
  const first = await getClub(db, s.config.clubIds[0]);
  await sender.send({
    from: emailFrom(first.name), to: (s.recipients as string[]).join(', '),
    subject: `${title} — du ${result.period.from} au ${result.period.to}`,
    text: `${title}\n${result.clubs.map((c) => c.name).join(', ')}\nPériode du ${result.period.from} au ${result.period.to}\nDétail en pièce jointe (Excel).`,
    html: analyticsHtml(result, title),
    attachments: [{ filename: `rapport-${result.period.from}_${result.period.to}.csv`, content: analyticsCsv(result), contentType: 'text/csv; charset=utf-8' }],
  });
  return sender.mode === 'log' ? 'logged' : 'sent';
}

export async function sendScheduleNow(db: Db, sender: EmailSender, p: Principal, id: string, now: Date) {
  const s = await ownSchedule(db, p, id);
  const status = await run(db, sender, s, now);
  await db.query(`UPDATE report_schedules SET last_run_at = $2, last_status = $3, last_error = NULL WHERE id = $1`, [id, now, status]);
  return { status };
}

/** Tâche périodique : envoie les rapports arrivés à échéance. */
export async function processDueSchedules(db: Db, sender: EmailSender, now: Date): Promise<number> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM report_schedules WHERE active AND next_run_at <= $1 ORDER BY next_run_at LIMIT 20`, [now]);
  let n = 0;
  for (const s of rows) {
    let status: string;
    let error: string | null = null;
    try { status = await run(db, sender, s, now); n++; } catch (err) { status = 'failed'; error = (err as Error).message.slice(0, 500); }
    await db.query(`UPDATE report_schedules SET last_run_at = $2, last_status = $3, last_error = $4, next_run_at = $5 WHERE id = $1`,
      [s.id, now, status, error, nextRun(s.frequency, new Date(now.getTime() + 60_000))]);
  }
  return n;
}
