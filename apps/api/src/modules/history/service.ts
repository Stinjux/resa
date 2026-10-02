// Historique des modifications : lecture et présentation en langage clair.
// L'écriture se fait dans chaque opération (shared/audit.ts), dans la même
// transaction ; la table est en lecture seule (trigger en base).

import type { Queryable } from '../../db/pool.js';
import { DomainError } from '../../shared/errors.js';

export const CATEGORIES = {
  bookings: { label: 'Réservations', re: '^(booking\\.(created|updated|moved|cancelled|price_recalculated|opened|closed)|booking_request\\.)' },
  payments: { label: 'Paiements et factures', re: '^(payment\\.|refund\\.|invoice\\.|credit_note\\.|cash\\.)' },
  resources: { label: 'Caddies et matériel', re: '^(allocation\\.|tee_time\\.caddie|resource\\.|config\\.capacity_override)' },
  operations: { label: 'Accueil et départs', re: '^(booking\\.checkin|tee_time\\.start|tee_times\\.)' },
  config: { label: 'Configuration', re: '^(config\\.(?!capacity_override)|membership\\.|partner\\.|allotment\\.|report_schedule\\.)' },
  accounts: { label: 'Comptes du personnel', re: '^user\\.' },
} as const;
export type Category = keyof typeof CATEGORIES;

export function categoryOf(action: string): Category | 'other' {
  for (const [k, c] of Object.entries(CATEGORIES)) if (new RegExp(c.re).test(action)) return k as Category;
  return 'other';
}

export interface AuditRow {
  id: number;
  clubId: string | null;
  clubName: string | null;
  timezone: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  data: Record<string, any>;
  reason: string | null;
  createdAt: Date;
  actorType: 'user' | 'customer' | 'system';
  actorId: string | null;
  actorName: string | null;
  reference: string | null;
}

export interface Detail { label: string; from: string; to: string }
export interface HistoryEvent {
  id: number;
  at: string;
  clubId: string | null;
  clubName: string | null;
  actor: { type: AuditRow['actorType']; id: string | null; name: string };
  action: string;
  category: Category | 'other';
  reference: string | null;
  entityType: string;
  entityId: string | null;
  text: string;
  details: Detail[];
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Mise en forme

const METHOD: Record<string, string> = { cash: 'espèces', card_terminal: 'carte (TPE)', bank_transfer: 'virement', online: 'en ligne', pos: 'caisse', other: 'autre moyen' };
const CHANNEL: Record<string, string> = { web: 'en ligne', phone: 'par téléphone', group: 'en groupe', walk_in: 'sur place', staff: 'par le personnel',
  whatsapp: 'par WhatsApp', sms: 'par SMS', partner: 'via le portail partenaire' };

/** « 10 h », « 10 h 12 ». */
export function hour(t: unknown): string {
  const m = /^(\d{2}):(\d{2})/.exec(String(t ?? ''));
  if (!m) return String(t ?? '');
  return `${Number(m[1])} h${m[2] === '00' ? '' : ` ${m[2]}`}`;
}
/** « 10/06/2030 » à partir d'une date ISO. */
export function day(d: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d ?? '');
}
function stamp(s: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s ?? ''));
  return m ? `${day(m[1])} à ${hour(m[2])}` : String(s ?? '');
}
export function money(minor: unknown, currency: string | undefined): string {
  if (typeof minor !== 'number') return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'MAD', maximumFractionDigits: minor % 100 ? 2 : 0 })
    .format(minor / 100).replace(/ | /g, ' ');
}
const list = (xs: unknown): string => (Array.isArray(xs) && xs.length ? xs.join(', ') : 'aucun');
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

const FIELDS: Record<string, { label: string; fmt: (v: unknown, d: Record<string, any>) => string }> = {
  players: { label: 'Joueurs', fmt: (v) => String(v) },
  holes: { label: 'Formule', fmt: (v) => `${v} trous` },
  isPrivate: { label: 'Départ privé', fmt: (v) => (v ? 'oui' : 'non') },
  options: { label: 'Matériel', fmt: (v) => list(v) },
  customerCategory: { label: 'Tarif', fmt: (v) => String(v) },
  caddiePayment: { label: 'Paiement du caddie', fmt: (v) => (v === 'with_booking' ? 'avec la réservation' : 'sur place') },
  totalMinor: { label: 'Prix', fmt: (v, d) => money(v, d.currency) },
  date: { label: 'Date', fmt: (v) => day(v) },
  time: { label: 'Heure', fmt: (v) => hour(v) },
  course: { label: 'Parcours', fmt: (v) => String(v) },
  caddie: { label: 'Caddie', fmt: (v) => (v ? String(v) : 'aucun') },
  units: { label: 'Numéros', fmt: (v) => list(v) },
  status: { label: 'Statut', fmt: (v) => (v === 'cancelled' ? 'annulée' : v === 'confirmed' ? 'confirmée' : String(v)) },
};

function detailsOf(d: Record<string, any>): Detail[] {
  const out: Detail[] = [];
  for (const [k, c] of Object.entries((d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>)) {
    const f = FIELDS[k];
    out.push({ label: f?.label ?? k, from: f ? f.fmt(c.from, d) : String(c.from ?? '—'), to: f ? f.fmt(c.to, d) : String(c.to ?? '—') });
  }
  if (d.notesChanged) out.push({ label: 'Notes', from: '…', to: 'modifiées' });
  if (d.playerNamesChanged) out.push({ label: 'Noms des joueurs', from: '…', to: 'modifiés' });
  return out;
}

function changeText(d: Detail[]): string {
  return d.map((x) => (x.from === '…' ? `${x.label.toLowerCase()} ${x.to}` : `${x.label.toLowerCase()} ${x.from} → ${x.to}`)).join(', ');
}

export function actorName(r: Pick<AuditRow, 'actorType' | 'actorName'>): string {
  if (r.actorType === 'system') return 'Système';
  if (r.actorType === 'customer') return r.actorName ? `${r.actorName} (client)` : 'Le client';
  return r.actorName ?? 'Utilisateur supprimé';
}

/** Phrase en langage clair, ex. « Sarah a déplacé le départ de G1-000123 de 10 h à 10 h 12 ». */
export function describe(r: AuditRow): HistoryEvent {
  const d = r.data ?? {};
  const who = actorName(r);
  const ref = r.reference ?? d.reference ?? '';
  const cur = d.currency as string | undefined;
  const details = detailsOf(d);
  let text: string;
  switch (r.action) {
    case 'booking.created': {
      const when = d.date ? ` pour le ${day(d.date)} à ${hour(d.time)}` : '';
      const shared = d.sharedWith?.length ? `, sur un départ partagé avec ${list(d.sharedWith)}` : '';
      const how = d.channel && r.actorType !== 'user' ? ` ${CHANNEL[d.channel] ?? ''}` : '';
      text = `${who} a créé la réservation ${ref}${how}${when} (${plural(d.players ?? 0, 'joueur', 'joueurs')}, ${d.holes} trous)${shared}`;
      if (d.options?.length && typeof d.options[0] === 'string') text += ` avec ${list(d.options)}`;
      break;
    }
    case 'booking.updated': {
      const only = details.length === 1 ? details[0]! : null;
      if (only?.label === 'Joueurs') text = `${who} a passé la réservation ${ref} de ${only.from} à ${only.to} joueurs`;
      else text = details.length ? `${who} a modifié la réservation ${ref} : ${changeText(details)}` : `${who} a modifié la réservation ${ref}`;
      if (d.unitsToReassign?.length) text += ` (à réattribuer : ${list(d.unitsToReassign)})`;
      break;
    }
    case 'booking.moved': {
      const c = d.changes ?? {};
      if (c.date) text = `${who} a déplacé le départ de ${ref} du ${day(c.date.from)} à ${hour(c.time?.from)} au ${day(c.date.to)} à ${hour(c.time?.to)}`;
      else if (c.time) text = `${who} a déplacé le départ de ${ref} de ${hour(c.time.from)} à ${hour(c.time.to)}`;
      else text = `${who} a déplacé la réservation ${ref}`;
      if (c.course) text += ` (${c.course.from} → ${c.course.to})`;
      if (d.combinedWith?.length) text += `, réunie avec ${list(d.combinedWith)}`;
      if (d.separatedFrom?.length) text += `, séparée de ${list(d.separatedFrom)}`;
      if (c.totalMinor) text += ` ; prix ${money(c.totalMinor.from, cur)} → ${money(c.totalMinor.to, cur)}`;
      if (d.unitsToReassign?.length) text += ` ; à réattribuer : ${list(d.unitsToReassign)}`;
      break;
    }
    case 'booking.cancelled':
      text = `${who} a annulé la réservation ${ref}${d.date ? ` du ${day(d.date)} à ${hour(d.time)}` : ''}`;
      if (d.cancellationFeeMinor) text += ` avec ${money(d.cancellationFeeMinor, cur)} de frais d'annulation`;
      else if (d.feeWaived) text += ' sans frais (frais offerts)';
      break;
    case 'booking.price_recalculated':
      text = `Le prix de ${ref} est passé de ${money(d.changes?.totalMinor?.from, cur)} à ${money(d.changes?.totalMinor?.to, cur)}`
        + (r.actorType === 'system' ? '' : `, suite à une modification de ${who} sur le même départ`);
      break;
    case 'booking.opened': text = `${who} a ouvert la partie ${ref} à d'autres golfeurs`; break;
    case 'booking.closed': text = `${who} a fermé la partie ${ref} aux autres golfeurs`; break;
    case 'booking.checkin.arrived': text = `${who} a noté l'arrivée de ${ref}`; break;
    case 'booking.checkin.no_show': text = `${who} a noté l'absence de ${ref}`; break;
    case 'booking.checkin.expected': text = `${who} a remis ${ref} en « attendu »`; break;
    case 'payment.recorded':
      text = `${who} a encaissé ${money(d.amountMinor, cur)} (${METHOD[d.method] ?? d.method}) pour ${ref}${d.payer === 'partner' ? ' (payé par le partenaire)' : ''}`;
      break;
    case 'refund.recorded':
      text = `${who} a remboursé ${money(d.amountMinor, cur)} (${METHOD[d.method] ?? d.method}) pour ${ref}`;
      break;
    case 'payment.confirmed': text = `Paiement en ligne${d.amountMinor ? ` de ${money(d.amountMinor, cur)}` : ''} confirmé par le prestataire pour ${ref}`; break;
    case 'payment.failed': text = `Paiement en ligne refusé ou abandonné pour ${ref}`; break;
    case 'tee_time.caddie_assigned': {
      const c = d.changes?.caddie;
      const at = d.time ? ` au départ de ${hour(d.time)}` : '';
      text = c?.from ? `${who} a remplacé ${c.from} par ${c.to}${at.replace(' au ', ' sur le ')}` : `${who} a affecté ${c?.to ?? 'un caddie'}${at}`;
      if (d.references?.length) text += ` (${list(d.references)})`;
      break;
    }
    case 'tee_time.caddie_unassigned':
      text = `${who} a retiré ${d.changes?.caddie?.from ?? 'le caddie'} du départ${d.time ? ` de ${hour(d.time)}` : ''}`;
      break;
    case 'allocation.units_assigned': {
      const u = d.changes?.units;
      if (!u) { text = `${who} a affecté du matériel à ${ref}`; break; }
      if (!u.from?.length) text = `${who} a affecté ${d.resource ?? 'le matériel'} ${list(u.to)} à ${ref}`;
      else if (!u.to?.length) text = `${who} a retiré ${d.resource ?? 'le matériel'} ${list(u.from)} de ${ref}`;
      else text = `${who} a remplacé ${list(u.from)} par ${list(u.to)} (${d.resource ?? 'matériel'}) sur ${ref}`;
      break;
    }
    case 'resource.unavailability_declared': {
      const span = d.to ? `du ${stamp(d.from)} au ${stamp(d.to)}` : `à partir du ${stamp(d.from)}, jusqu'à nouvel ordre`;
      text = d.kind === 'maintenance' ? `${who} a mis ${d.label} en maintenance ${span}` : `${who} a déclaré ${d.label} indisponible ${span}`;
      if (d.affected?.length) text += ` — ${plural(d.affected.length, 'réservation concernée', 'réservations concernées')} : ${list(d.affected)}`;
      if (d.overflow) text += ` — capacité dépassée de ${d.overflow}`;
      break;
    }
    case 'resource.unavailability_ended':
      text = d.cancelled ? `${who} a annulé l'indisponibilité prévue de ${d.label}` : `${who} a remis ${d.label} en service`;
      break;
    case 'tee_time.started': text = `${who} a marqué le départ de ${hour(d.time)} comme parti${d.references?.length ? ` (${list(d.references)})` : ''}`; break;
    case 'tee_time.start_undone': text = `${who} a annulé le « parti » du départ de ${hour(d.time)}`; break;
    case 'tee_times.blocked': text = `${who} a bloqué ${plural(d.blocked ?? 0, 'départ', 'départs')} le ${day(d.date)} de ${hour(d.from)} à ${hour(d.to)}${d.course ? ` (${d.course})` : ''}`; break;
    case 'tee_times.unblocked': text = `${who} a débloqué ${plural(d.unblocked ?? 0, 'départ', 'départs')} le ${day(d.date)} de ${hour(d.from)} à ${hour(d.to)}`; break;
    case 'invoice.issued': text = `${who} a émis la facture ${d.number ?? ''}${d.totalMinor !== undefined ? ` de ${money(d.totalMinor, cur)}` : ''}`; break;
    case 'invoice.payment_recorded': text = `${who} a enregistré un règlement de ${money(d.amountMinor, cur)} sur une facture`; break;
    case 'credit_note.issued': text = `${who} a émis l'avoir ${d.number ?? ''} annulant la facture ${d.originalNumber ?? ''}`; break;
    case 'cash.closed': text = `${who} a clôturé la caisse (${d.number ?? ''})`; break;
    case 'config.capacity_override.set': text = `${who} a modifié la quantité disponible d'un matériel pour une date`; break;
    default: text = `${who} · ${ACTION_LABEL[r.action] ?? r.action}`;
  }
  return {
    id: Number(r.id), at: r.createdAt.toISOString(), clubId: r.clubId, clubName: r.clubName,
    actor: { type: r.actorType, id: r.actorId, name: who }, action: r.action, category: categoryOf(r.action),
    reference: ref || null, entityType: r.entityType, entityId: r.entityId, text, details, reason: r.reason ?? d.reason ?? null,
  };
}

const ACTION_LABEL: Record<string, string> = {
  'booking_request.approved': 'demande de réservation validée', 'booking_request.rejected': 'demande de réservation refusée',
  'config.club.created': 'golf créé', 'config.club.updated': 'réglages du golf modifiés', 'membership.created': 'abonnement créé',
  'membership.updated': 'abonnement modifié', 'partner.user_created': 'compte partenaire créé', 'allotment.created': 'allotement créé',
  'allotment.cancelled': 'allotement annulé', 'report_schedule.created': 'envoi de rapport programmé', 'report_schedule.deleted': 'envoi de rapport supprimé',
  'user.created': 'compte créé', 'user.updated': 'compte modifié', 'user.password_changed': 'mot de passe changé',
  'user.password_reset': 'mot de passe réinitialisé', 'customer.profile_updated': 'profil golfeur modifié',
};

// ---------------------------------------------------------------------------
// Lecture

const SELECT = `SELECT a.id, a.club_id AS "clubId", c.name AS "clubName", c.timezone, a.action, a.entity_type AS "entityType",
       a.entity_id AS "entityId", a.data, a.reason, a.created_at AS "createdAt", a.actor_type AS "actorType",
       a.actor_id AS "actorId", u.display_name AS "actorName", eb.reference
  FROM audit_log a
  LEFT JOIN clubs c ON c.id = a.club_id
  LEFT JOIN users u ON u.id = a.actor_id
  LEFT JOIN bookings eb ON a.entity_type = 'booking' AND eb.id = a.entity_id`;

/** Tous les événements d'une réservation, y compris ceux de son départ
 *  (caddie, départ parti…) et des réservations réunies avec elle. */
export async function bookingHistory(q: Queryable, bookingId: string): Promise<HistoryEvent[]> {
  const { rows } = await q.query<AuditRow>(
    `${SELECT} WHERE (a.entity_type = 'booking' AND a.entity_id = $1) OR $1 = ANY(a.refs) ORDER BY a.id`, [bookingId]);
  return rows.map(describe);
}

export interface HistoryFilter {
  clubIds: string[];
  from?: string | null;
  to?: string | null;
  actorId?: string | null;
  category?: Category | null;
  reference?: string | null;
  before?: number | null;
  limit?: number;
}

export async function searchHistory(q: Queryable, f: HistoryFilter): Promise<{ events: HistoryEvent[]; next: number | null }> {
  if (!f.clubIds.length) throw new DomainError('FORBIDDEN', 'Aucun golf accessible.');
  const limit = Math.min(f.limit ?? 50, 200);
  let bookingId: string | null = null;
  if (f.reference?.trim()) {
    const { rows } = await q.query('SELECT id FROM bookings WHERE upper(reference) = upper($1) AND club_id = ANY($2)', [f.reference.trim(), f.clubIds]);
    if (!rows[0]) return { events: [], next: null };
    bookingId = rows[0].id;
  }
  const { rows } = await q.query<AuditRow>(
    `${SELECT}
      WHERE a.club_id = ANY($1)
        AND ($2::date IS NULL OR (a.created_at AT TIME ZONE c.timezone)::date >= $2)
        AND ($3::date IS NULL OR (a.created_at AT TIME ZONE c.timezone)::date <= $3)
        AND ($4::uuid IS NULL OR a.actor_id = $4)
        AND ($5::text IS NULL OR a.action ~ $5)
        AND ($6::uuid IS NULL OR (a.entity_type = 'booking' AND a.entity_id = $6) OR $6 = ANY(a.refs))
        AND ($7::bigint IS NULL OR a.id < $7)
      ORDER BY a.id DESC LIMIT $8`,
    [f.clubIds, f.from || null, f.to || null, f.actorId || null, f.category ? CATEGORIES[f.category].re : null, bookingId,
      f.before ?? null, limit + 1],
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { events: page.map(describe), next: more ? Number(page[page.length - 1]!.id) : null };
}

/** Personnes ayant une action dans l'historique de ces golfs (filtre « Utilisateur »). */
export async function historyActors(q: Queryable, clubIds: string[]) {
  const { rows } = await q.query(
    `SELECT u.id, u.display_name AS name FROM users u
      WHERE EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_id = u.id AND a.club_id = ANY($1))
      ORDER BY u.display_name`, [clubIds]);
  return rows;
}
