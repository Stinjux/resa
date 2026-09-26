// E-mails aux clients : confirmation, modification, annulation, rappel.
// Le contenu est figé au moment de la mise en file (état de la réservation à
// cet instant) ; l'envoi a lieu ensuite, avec reprises.

import { DateTime } from 'luxon';
import type { Db, Queryable } from '../../db/pool.js';
import { emailFrom, type EmailSender } from '../../integrations/email/sender.js';

export type EmailKind = 'confirmation' | 'modification' | 'cancellation' | 'reminder';
type Lang = 'fr' | 'en' | 'ar';

const TEXT: Record<Lang, Record<string, string>> = {
  fr: {
    confirmation: 'Confirmation de réservation', modification: 'Modification de votre réservation',
    cancellation: 'Annulation de votre réservation', reminder: 'Rappel : votre départ',
    hello: 'Bonjour {name},',
    introConfirmation: 'Votre réservation au {golf} est confirmée.',
    introModification: 'Votre réservation au {golf} a été modifiée. Voici le détail à jour.',
    introCancellation: 'Votre réservation au {golf} est annulée.',
    introReminder: 'Nous vous attendons au {golf} :',
    teeTime: 'Départ', players: 'Joueurs', holes: 'Formule', holesN: '{n} trous', options: 'Options', reference: 'Référence',
    total: 'Total TTC', onSite: 'dont à régler sur place', fee: "Frais d'annulation",
    arrive: 'Merci de vous présenter à l’accueil 20 minutes avant votre départ.',
    freeCancel: 'Annulation gratuite jusqu’au {date}.',
    contact: 'Pour toute question : {contact}.', thanks: 'À bientôt,', team: "L'équipe du {golf}",
  },
  en: {
    confirmation: 'Booking confirmation', modification: 'Your booking has been updated',
    cancellation: 'Your booking has been cancelled', reminder: 'Reminder: your tee time',
    hello: 'Dear {name},',
    introConfirmation: 'Your booking at {golf} is confirmed.',
    introModification: 'Your booking at {golf} has been updated. Here are the new details.',
    introCancellation: 'Your booking at {golf} has been cancelled.',
    introReminder: 'We look forward to welcoming you at {golf}:',
    teeTime: 'Tee time', players: 'Players', holes: 'Round', holesN: '{n} holes', options: 'Extras', reference: 'Reference',
    total: 'Total incl. tax', onSite: 'of which payable at the club', fee: 'Cancellation fee',
    arrive: 'Please check in at reception 20 minutes before your tee time.',
    freeCancel: 'Free cancellation until {date}.',
    contact: 'Questions: {contact}.', thanks: 'See you soon,', team: 'The {golf} team',
  },
  ar: {
    confirmation: 'تأكيد الحجز', modification: 'تعديل حجزك', cancellation: 'إلغاء حجزك', reminder: 'تذكير: موعد انطلاقك',
    hello: 'مرحباً {name}،',
    introConfirmation: 'تم تأكيد حجزك في {golf}.',
    introModification: 'تم تعديل حجزك في {golf}. إليك التفاصيل المحدثة.',
    introCancellation: 'تم إلغاء حجزك في {golf}.',
    introReminder: 'ننتظرك في {golf}:',
    teeTime: 'موعد الانطلاق', players: 'اللاعبون', holes: 'عدد الحفر', holesN: '{n} حفرة', options: 'الخيارات', reference: 'المرجع',
    total: 'المجموع شامل الضريبة', onSite: 'منها ما يُدفع في النادي', fee: 'رسوم الإلغاء',
    arrive: 'يرجى الحضور إلى الاستقبال قبل 20 دقيقة من موعد الانطلاق.',
    freeCancel: 'الإلغاء مجاني حتى {date}.',
    contact: 'للاستفسار: {contact}.', thanks: 'إلى اللقاء،', team: 'فريق {golf}',
  },
};
const INTL: Record<Lang, string> = { fr: 'fr', en: 'en-GB', ar: 'ar-MA' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

interface BookingForEmail {
  id: string; reference: string; status: string; clubId: string; players: number; holes: number; groupId: string | null;
  startsAt: Date; courseName: string; email: string | null; firstName: string | null; lastName: string; locale: string | null;
  clubName: string; timezone: string; currency: string; defaultLocale: string; emailEnabled: boolean; replyTo: string | null;
  contactPhone: string | null; freeHours: number; totalMinor: number | null; dueOnSiteMinor: number | null; cancellationFeeMinor: number | null;
  options: string[];
  group: Array<{ reference: string; startsAt: Date; players: number; holes: number; totalMinor: number | null; dueOnSiteMinor: number | null }>;
}

async function loadBooking(q: Queryable, bookingId: string): Promise<BookingForEmail | null> {
  const { rows } = await q.query(
    `SELECT b.id, b.reference, b.status, b.club_id AS "clubId", b.players, b.holes, b.group_id AS "groupId", t.starts_at AS "startsAt",
            co.name AS "courseName", cu.email, cu.first_name AS "firstName", cu.last_name AS "lastName", cu.preferred_locale AS locale,
            c.name AS "clubName", c.timezone, c.currency, c.default_locale AS "defaultLocale", c.email_enabled AS "emailEnabled",
            c.email_reply_to AS "replyTo", c.contact_phone AS "contactPhone", c.cancellation_free_hours AS "freeHours",
            b.total_minor AS "totalMinor", b.due_on_site_minor AS "dueOnSiteMinor", b.cancellation_fee_minor AS "cancellationFeeMinor",
            coalesce((SELECT array_agg(rt.name || ' × ' || a.quantity ORDER BY rt.sort_order) FROM resource_allocations a
                       JOIN resource_types rt ON rt.id = a.resource_type_id WHERE a.booking_id = b.id AND a.status = 'active'), '{}') AS options
       FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN courses co ON co.id = t.course_id
       JOIN clubs c ON c.id = b.club_id LEFT JOIN customers cu ON cu.id = b.customer_id
      WHERE b.id = $1`,
    [bookingId],
  );
  const b = rows[0];
  if (!b) return null;
  b.group = [];
  if (b.groupId) {
    b.group = (await q.query(
      `SELECT b.reference, t.starts_at AS "startsAt", b.players, b.holes, b.total_minor AS "totalMinor", b.due_on_site_minor AS "dueOnSiteMinor"
         FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id
        WHERE b.group_id = $1 AND b.status = 'confirmed' ORDER BY t.starts_at, b.reference`, [b.groupId])).rows;
  }
  return b;
}

function langOf(b: BookingForEmail): Lang {
  const l = (b.locale ?? b.defaultLocale ?? 'fr').slice(0, 2);
  return (l === 'en' || l === 'ar' ? l : 'fr') as Lang;
}

export function renderEmail(b: BookingForEmail, kind: EmailKind): { subject: string; text: string; html: string; locale: Lang } {
  const lang = langOf(b);
  const t = TEXT[lang];
  const v = { golf: b.clubName, name: [b.firstName, b.lastName].filter(Boolean).join(' ') };
  const when = DateTime.fromJSDate(b.startsAt, { zone: b.timezone }).setLocale(INTL[lang]);
  const money = (m: number | null) => new Intl.NumberFormat(INTL[lang], { style: 'currency', currency: b.currency, maximumFractionDigits: 0 }).format((m ?? 0) / 100);
  const intro = { confirmation: t.introConfirmation, modification: t.introModification, cancellation: t.introCancellation, reminder: t.introReminder }[kind]!;

  // Groupe (confirmation) : un seul récapitulatif de tous les départs.
  const grouped = kind === 'confirmation' && b.group.length > 1;
  const rows: Array<[string, string]> = grouped
    ? b.group.map((g) => {
        const w = DateTime.fromJSDate(g.startsAt, { zone: b.timezone }).setLocale(INTL[lang]);
        return [`${t.teeTime} ${g.reference}`, `${w.toFormat('ccc d LLL HH:mm')} — ${g.players} × ${fill(t.holesN!, { n: String(g.holes) })}`] as [string, string];
      })
    : [
        [t.teeTime!, `${when.toFormat('cccc d LLLL yyyy')} — ${when.toFormat('HH:mm')} (${b.courseName})`],
        [t.players!, String(b.players)],
        [t.holes!, fill(t.holesN!, { n: String(b.holes) })],
        ...(b.options.length ? [[t.options!, b.options.join(', ')] as [string, string]] : []),
        [t.reference!, b.reference],
      ];
  const sum = (k: 'totalMinor' | 'dueOnSiteMinor') => b.group.reduce((a, g) => a + (g[k] ?? 0), 0);
  if (kind === 'cancellation') {
    if (b.cancellationFeeMinor) rows.push([t.fee!, money(b.cancellationFeeMinor)]);
  } else {
    const total = grouped ? sum('totalMinor') : b.totalMinor;
    const onSite = grouped ? sum('dueOnSiteMinor') : b.dueOnSiteMinor;
    rows.push([t.total!, money(total)]);
    if (onSite) rows.push([t.onSite!, money(onSite)]);
  }
  const notes: string[] = [];
  if (kind !== 'cancellation') notes.push(t.arrive!);
  if (kind === 'confirmation' || kind === 'modification') {
    const free = when.minus({ hours: b.freeHours });
    if (free > DateTime.now()) notes.push(fill(t.freeCancel!, { date: free.toFormat('d LLLL yyyy HH:mm') }));
  }
  const contact = [b.contactPhone, b.replyTo].filter(Boolean).join(' · ');
  if (contact) notes.push(fill(t.contact!, { contact }));

  const subject = `${t[kind]} — ${b.clubName} — ${when.toFormat('d LLL HH:mm')}`;
  const text = [fill(t.hello!, v), '', fill(intro, v), '', ...rows.map(([k, val]) => `${k} : ${val}`), '', ...notes, '', t.thanks!, fill(t.team!, v)].join('\n');
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const html = `<!doctype html><html lang="${lang}" dir="${dir}"><body style="margin:0;background:#f6f7f4;font-family:Arial,sans-serif;color:#1c2419">
<div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#fff;border:1px solid #d9ded3;border-radius:10px;padding:24px">
<h1 style="font-size:20px;color:#1f6f43;margin:0 0 16px">⛳ ${esc(b.clubName)}</h1>
<p>${esc(fill(t.hello!, v))}</p><p><strong>${esc(fill(intro, v))}</strong></p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">${rows.map(([k, val]) =>
    `<tr><td style="padding:6px 0;color:#5d6958;border-bottom:1px solid #eef1ea">${esc(k)}</td><td style="padding:6px 0;text-align:${dir === 'rtl' ? 'left' : 'right'};border-bottom:1px solid #eef1ea"><strong>${esc(val)}</strong></td></tr>`).join('')}</table>
${notes.map((n) => `<p style="font-size:14px;color:#5d6958">${esc(n)}</p>`).join('')}
<p>${esc(t.thanks!)}<br>${esc(fill(t.team!, v))}</p></div></div></body></html>`;
  return { subject, text, html, locale: lang };
}

/** Met un e-mail en file pour une réservation (sans effet si pas d'adresse ou e-mails désactivés). */
export async function enqueueBookingEmail(q: Queryable, bookingId: string, kind: EmailKind, dedupeKey: string = kind): Promise<boolean> {
  const b = await loadBooking(q, bookingId);
  if (!b || !b.email || !b.emailEnabled) return false;
  const m = renderEmail(b, kind);
  const r = await q.query(
    `INSERT INTO email_outbox (club_id, booking_id, kind, dedupe_key, to_address, locale, subject, body_text, body_html)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (booking_id, kind, dedupe_key) DO NOTHING`,
    [b.clubId, b.id, kind, dedupeKey, b.email, m.locale, m.subject, m.text, m.html],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Rappels : réservations dont le départ approche (délai réglé par golf), une seule fois. */
export async function scheduleReminders(db: Db, now: Date): Promise<number> {
  const { rows } = await db.query(
    `SELECT b.id FROM bookings b JOIN tee_times t ON t.id = b.tee_time_id JOIN clubs c ON c.id = b.club_id
      WHERE b.status = 'confirmed' AND c.reminder_hours_before > 0 AND c.email_enabled
        AND t.starts_at > $1 AND t.starts_at <= $1 + make_interval(hours => c.reminder_hours_before)
        AND b.created_at < t.starts_at - make_interval(hours => c.reminder_hours_before) -- pas de rappel si réservé au dernier moment
        AND NOT EXISTS (SELECT 1 FROM email_outbox e WHERE e.booking_id = b.id AND e.kind = 'reminder')
      LIMIT 200`,
    [now],
  );
  let n = 0;
  for (const r of rows) if (await enqueueBookingEmail(db, r.id, 'reminder')) n++;
  return n;
}

export async function processEmailQueue(db: Db, sender: EmailSender, now: Date): Promise<{ sent: number; failed: number }> {
  const { rows } = await db.query(
    `SELECT e.id, e.to_address AS "to", e.subject, e.body_text AS text, e.body_html AS html, e.attempts, c.name AS "clubName", c.email_reply_to AS "replyTo"
       FROM email_outbox e JOIN clubs c ON c.id = e.club_id
      WHERE e.status = 'pending' AND e.next_attempt_at <= greatest($1::timestamptz, now()) ORDER BY e.created_at LIMIT 50`,
    [now],
  );
  let sent = 0;
  let failed = 0;
  for (const m of rows) {
    try {
      const r = await sender.send({ from: emailFrom(m.clubName), replyTo: m.replyTo, to: m.to, subject: m.subject, text: m.text, html: m.html });
      await db.query(`UPDATE email_outbox SET status = $2, provider_id = $3, sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`,
        [m.id, sender.mode === 'log' ? 'logged' : 'sent', r.id]);
      sent++;
    } catch (err) {
      const attempts = m.attempts + 1;
      await db.query(`UPDATE email_outbox SET status = $2, attempts = $3, last_error = $4, next_attempt_at = $5 WHERE id = $1`,
        [m.id, attempts >= 5 ? 'failed' : 'pending', attempts, (err as Error).message.slice(0, 500), new Date(now.getTime() + 60_000 * 2 ** attempts)]);
      failed++;
    }
  }
  return { sent, failed };
}

export async function listEmails(q: Queryable, clubId: string) {
  const { rows } = await q.query(
    `SELECT e.id, e.kind, e.to_address AS "to", e.subject, e.status, e.attempts, e.last_error AS "lastError", e.created_at AS "createdAt",
            e.sent_at AS "sentAt", b.reference
       FROM email_outbox e LEFT JOIN bookings b ON b.id = e.booking_id WHERE e.club_id = $1 ORDER BY e.created_at DESC LIMIT 200`,
    [clubId],
  );
  return rows;
}

export async function getEmail(q: Queryable, id: string) {
  const { rows } = await q.query(`SELECT id, club_id AS "clubId", subject, body_html AS html, to_address AS "to" FROM email_outbox WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function resendEmail(q: Queryable, clubId: string, id: string): Promise<boolean> {
  const r = await q.query(
    `UPDATE email_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE id = $1 AND club_id = $2 AND status IN ('failed', 'sent', 'logged')`, [id, clubId]);
  return (r.rowCount ?? 0) > 0;
}
