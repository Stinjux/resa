// Configuration d'un golf : paramètres, parcours, grilles horaires, tarifs,
// caddies, matériel. Écritures génériques mais sur listes blanches de
// colonnes, toujours restreintes au golf concerné, et historisées.

import type { Db, Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { audit, type Actor } from '../../shared/audit.js';
import { DomainError } from '../../shared/errors.js';

type ColumnMap = Record<string, string>;

interface EntityDef {
  table: string;
  columns: ColumnMap; // champ API → colonne SQL (modifiables)
  /** Condition SQL qui rattache la ligne au golf ($CLUB = paramètre). */
  scope: string;
  /** Colonnes fixées à la création uniquement. */
  createOnly?: ColumnMap;
  /** Champs à ne jamais copier dans l'historique. */
  private?: string[];
}

export const ENTITIES = {
  courses: {
    table: 'courses',
    columns: {
      name: 'name', allowedHoles: 'allowed_holes', defaultIntervalMinutes: 'default_interval_minutes',
      defaultMaxPlayers: 'default_max_players', playMinutes9: 'play_minutes_9', playMinutes18: 'play_minutes_18',
      active: 'active',
    },
    createOnly: { code: 'code' },
    scope: 'club_id = $CLUB',
  },
  'schedule-rules': {
    table: 'schedule_rules',
    columns: {
      courseId: 'course_id', name: 'name', kind: 'kind', validFrom: 'valid_from', validTo: 'valid_to',
      weekdays: 'weekdays', startTime: 'start_time', endTime: 'end_time', intervalMinutes: 'interval_minutes',
      maxPlayers: 'max_players', allowedHoles: 'allowed_holes', priority: 'priority', active: 'active',
    },
    scope: 'club_id = $CLUB',
  },
  tariffs: {
    table: 'tariffs',
    columns: {
      courseId: 'course_id', product: 'product', name: 'name', holes: 'holes', customerCategory: 'customer_category',
      validFrom: 'valid_from', validTo: 'valid_to', weekdays: 'weekdays', startTime: 'start_time', endTime: 'end_time',
      amountMinor: 'amount_minor', basis: 'basis', priority: 'priority', active: 'active',
    },
    scope: 'club_id = $CLUB',
  },
  'resource-types': {
    table: 'resource_types',
    columns: {
      name: 'name', totalQuantity: 'total_quantity', price9Minor: 'price_9_minor', price18Minor: 'price_18_minor',
      bufferMinutes: 'buffer_minutes', maxPerBooking: 'max_per_booking', active: 'active', sortOrder: 'sort_order',
    },
    createOnly: { code: 'code', kind: 'kind', variant: 'variant', scope: 'scope', requiredPerTeeTime: 'required_per_tee_time' },
    scope: 'club_id = $CLUB',
  },
  caddies: {
    table: 'caddies',
    columns: { displayName: 'display_name', phone: 'phone', active: 'active' },
    scope: 'club_id = $CLUB',
    private: ['phone'],
  },
  'resource-units': {
    table: 'resource_units',
    columns: { label: 'label', status: 'status' },
    createOnly: { resourceTypeId: 'resource_type_id' },
    scope: 'resource_type_id IN (SELECT id FROM resource_types WHERE club_id = $CLUB)',
  },
} satisfies Record<string, EntityDef>;

export type EntityName = keyof typeof ENTITIES;

const CLUB_SETTINGS: ColumnMap = {
  name: 'name', timezone: 'timezone', currency: 'currency', defaultLocale: 'default_locale',
  pricesIncludeTax: 'prices_include_tax', taxRateBp: 'tax_rate_bp', bookingHorizonDays: 'booking_horizon_days',
  minLeadMinutes: 'min_lead_minutes', defaultCaddiePayment: 'default_caddie_payment', caddieFeeSplit: 'caddie_fee_split',
  cancellationFreeHours: 'cancellation_free_hours', cancellationFeePercent: 'cancellation_fee_percent',
  customerCanCancel: 'customer_can_cancel', onlinePayment: 'online_payment', posProvider: 'pos_provider',
  messagingProvider: 'messaging_provider',
};

function auditData(def: EntityDef, values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([k]) => !def.private?.includes(k)));
}

function pick(map: ColumnMap, values: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(values).filter(([k, v]) => k in map && v !== undefined).map(([k, v]) => [map[k]!, v]);
}

const CHECK_MESSAGES: Record<string, string> = {
  schedule_rules_check: "L'heure de fin doit être après l'heure de début.",
  schedule_rules_check1: 'La date de fin doit être après la date de début.',
  tariffs_check: 'Renseignez les deux heures (début et fin) ou aucune.',
  tariffs_check1: "L'heure de fin doit être après l'heure de début.",
  tariffs_check2: 'La date de fin doit être après la date de début.',
};

/** Traduit les erreurs de contrainte PostgreSQL en erreurs de validation lisibles. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { code?: string; constraint?: string; detail?: string };
    if (e.code === '23505') throw new DomainError('VALIDATION', 'Ce code ou ce libellé existe déjà.', { constraint: e.constraint });
    if (e.code === '23514') {
      throw new DomainError('VALIDATION', CHECK_MESSAGES[e.constraint ?? ''] ?? 'Valeur hors des limites autorisées.', { constraint: e.constraint });
    }
    if (e.code === '23502') throw new DomainError('VALIDATION', 'Un champ obligatoire est vide.', { column: (err as { column?: string }).column });
    if (e.code === '23503') throw new DomainError('VALIDATION', 'Élément lié introuvable.', { constraint: e.constraint });
    if (e.code === '22007' || e.code === '22008') throw new DomainError('VALIDATION', 'Date ou heure invalide.');
    throw err;
  }
}

async function assertCourseInClub(q: Queryable, clubId: string, courseId: unknown) {
  if (courseId === undefined || courseId === null) return;
  const { rowCount } = await q.query('SELECT 1 FROM courses WHERE id = $1 AND club_id = $2', [courseId, clubId]);
  if (!rowCount) throw new DomainError('VALIDATION', 'Parcours inconnu pour ce golf.');
}

async function assertResourceTypeInClub(q: Queryable, clubId: string, resourceTypeId: unknown) {
  const { rowCount } = await q.query('SELECT 1 FROM resource_types WHERE id = $1 AND club_id = $2', [resourceTypeId, clubId]);
  if (!rowCount) throw new DomainError('VALIDATION', 'Type de matériel inconnu pour ce golf.');
}

export async function createEntity(
  db: Db, clubId: string, entity: EntityName, values: Record<string, unknown>, actor: Actor,
): Promise<string> {
  const def: EntityDef = ENTITIES[entity];
  return guard(() => withTransaction(db, async (tx) => {
    await assertCourseInClub(tx, clubId, values.courseId);
    if (entity === 'resource-units') await assertResourceTypeInClub(tx, clubId, values.resourceTypeId);
    const cols = [...pick(def.columns, values), ...pick(def.createOnly ?? {}, values)];
    if (def.scope.startsWith('club_id')) cols.push(['club_id', clubId]);
    const { rows } = await tx.query(
      `INSERT INTO ${def.table} (${cols.map(([c]) => c).join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map(([, v]) => v),
    );
    await audit(tx, { clubId, actor, action: `config.${entity}.created`, entityType: def.table, entityId: rows[0].id, data: auditData(def, values) });
    return rows[0].id;
  }));
}

export async function updateEntity(
  db: Db, clubId: string, entity: EntityName, id: string, patch: Record<string, unknown>, actor: Actor,
): Promise<void> {
  const def: EntityDef = ENTITIES[entity];
  const cols = pick(def.columns, patch);
  if (cols.length === 0) return;
  await guard(() => withTransaction(db, async (tx) => {
    await assertCourseInClub(tx, clubId, patch.courseId);
    const params: unknown[] = [id, clubId, ...cols.map(([, v]) => v)];
    const res = await tx.query(
      `UPDATE ${def.table} SET ${cols.map(([c], i) => `${c} = $${i + 3}`).join(', ')}
        WHERE id = $1 AND ${def.scope.replace('$CLUB', '$2')}`,
      params,
    );
    if (!res.rowCount) throw new DomainError('NOT_FOUND', 'Élément introuvable pour ce golf.');
    await audit(tx, { clubId, actor, action: `config.${entity}.updated`, entityType: def.table, entityId: id, data: auditData(def, patch) });
  }));
}

export async function updateClubSettings(db: Db, clubId: string, patch: Record<string, unknown>, actor: Actor): Promise<void> {
  const cols = pick(CLUB_SETTINGS, patch);
  if (cols.length === 0) return;
  await guard(() => withTransaction(db, async (tx) => {
    await tx.query(
      `UPDATE clubs SET ${cols.map(([c], i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [clubId, ...cols.map(([, v]) => v)],
    );
    await audit(tx, { clubId, actor, action: 'config.club.updated', entityType: 'club', entityId: clubId, data: patch });
  }));
}

/** Exception de capacité d'un type de matériel pour un jour (null = supprimer). */
export async function setCapacityOverride(
  db: Db, clubId: string, resourceTypeId: string, date: string, quantity: number | null, reason: string | null, actor: Actor,
): Promise<void> {
  await guard(() => withTransaction(db, async (tx) => {
    await assertResourceTypeInClub(tx, clubId, resourceTypeId);
    if (quantity === null) {
      await tx.query('DELETE FROM resource_capacity_overrides WHERE resource_type_id = $1 AND date = $2', [resourceTypeId, date]);
    } else {
      await tx.query(
        `INSERT INTO resource_capacity_overrides (resource_type_id, date, quantity, reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT (resource_type_id, date) DO UPDATE SET quantity = EXCLUDED.quantity, reason = EXCLUDED.reason`,
        [resourceTypeId, date, quantity, reason],
      );
    }
    await audit(tx, { clubId, actor, action: 'config.capacity_override.set', entityType: 'resource_type', entityId: resourceTypeId,
      data: { date, quantity, reason } });
  }));
}

/** Toute la configuration d'un golf, pour l'écran d'administration. */
export async function getClubConfig(q: Queryable, clubId: string) {
  const [club, courses, rules, tariffs, resourceTypes, overrides, caddies, units] = await Promise.all([
    q.query(`SELECT id, code, name, timezone, currency, default_locale AS "defaultLocale", prices_include_tax AS "pricesIncludeTax",
                    tax_rate_bp AS "taxRateBp", booking_horizon_days AS "bookingHorizonDays", min_lead_minutes AS "minLeadMinutes",
                    default_caddie_payment AS "defaultCaddiePayment", caddie_fee_split AS "caddieFeeSplit",
                    cancellation_free_hours AS "cancellationFreeHours", cancellation_fee_percent AS "cancellationFeePercent",
                    customer_can_cancel AS "customerCanCancel", online_payment AS "onlinePayment", pos_provider AS "posProvider",
                    messaging_provider AS "messagingProvider"
               FROM clubs WHERE id = $1`, [clubId]),
    q.query(`SELECT id, code, name, allowed_holes AS "allowedHoles", default_interval_minutes AS "defaultIntervalMinutes",
                    default_max_players AS "defaultMaxPlayers", play_minutes_9 AS "playMinutes9", play_minutes_18 AS "playMinutes18", active
               FROM courses WHERE club_id = $1 ORDER BY name`, [clubId]),
    q.query(`SELECT id, course_id AS "courseId", name, kind, valid_from AS "validFrom", valid_to AS "validTo", weekdays,
                    to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime",
                    interval_minutes AS "intervalMinutes", max_players AS "maxPlayers", allowed_holes AS "allowedHoles", priority, active
               FROM schedule_rules WHERE club_id = $1 ORDER BY active DESC, priority DESC, name`, [clubId]),
    q.query(`SELECT id, course_id AS "courseId", product, name, holes, customer_category AS "customerCategory",
                    valid_from AS "validFrom", valid_to AS "validTo", weekdays,
                    to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime",
                    amount_minor AS "amountMinor", basis, priority, active
               FROM tariffs WHERE club_id = $1 ORDER BY active DESC, product, holes NULLS FIRST, priority DESC, name`, [clubId]),
    q.query(`SELECT id, code, kind, name, variant, scope, required_per_tee_time AS "requiredPerTeeTime",
                    total_quantity AS "totalQuantity", price_9_minor AS "price9Minor", price_18_minor AS "price18Minor",
                    buffer_minutes AS "bufferMinutes", max_per_booking AS "maxPerBooking", active, sort_order AS "sortOrder"
               FROM resource_types WHERE club_id = $1 ORDER BY sort_order, name`, [clubId]),
    q.query(`SELECT o.resource_type_id AS "resourceTypeId", o.date, o.quantity, o.reason
               FROM resource_capacity_overrides o JOIN resource_types rt ON rt.id = o.resource_type_id
              WHERE rt.club_id = $1 AND o.date >= (now() AT TIME ZONE 'UTC')::date - 1 ORDER BY o.date`, [clubId]),
    q.query(`SELECT id, display_name AS "displayName", phone, active FROM caddies WHERE club_id = $1 ORDER BY display_name`, [clubId]),
    q.query(`SELECT u.id, u.resource_type_id AS "resourceTypeId", u.label, u.status
               FROM resource_units u JOIN resource_types rt ON rt.id = u.resource_type_id
              WHERE rt.club_id = $1 ORDER BY rt.sort_order, u.label`, [clubId]),
  ]);
  if (!club.rows[0]) throw new DomainError('NOT_FOUND', 'Golf introuvable.');
  return {
    club: club.rows[0], courses: courses.rows, scheduleRules: rules.rows, tariffs: tariffs.rows,
    resourceTypes: resourceTypes.rows, capacityOverrides: overrides.rows, caddies: caddies.rows, units: units.rows,
  };
}

/**
 * Nouveau golf dans une organisation, avec le minimum pour démarrer : un
 * parcours, une plage d'ouverture et le type « caddie » (quantité et prix à
 * saisir). Aucun tarif n'est inventé : tant qu'aucun green fee n'est saisi,
 * les réservations sont refusées (PRICE_NOT_CONFIGURED).
 */
export async function createClub(
  db: Db,
  organizationId: string,
  input: { code: string; name: string; timezone: string; currency: string; defaultLocale: string; countryCode: string | null; taxRateBp: number },
  actor: Actor,
): Promise<string> {
  return guard(() => withTransaction(db, async (tx) => {
    const { rows: [club] } = await tx.query(
      `INSERT INTO clubs (organization_id, code, name, timezone, currency, default_locale, country_code, tax_rate_bp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [organizationId, input.code, input.name, input.timezone, input.currency, input.defaultLocale, input.countryCode, input.taxRateBp],
    );
    await tx.query(`INSERT INTO courses (club_id, code, name) VALUES ($1, 'MAIN', 'Parcours principal')`, [club.id]);
    await tx.query(
      `INSERT INTO schedule_rules (club_id, name, kind, start_time, end_time) VALUES ($1, 'Ouverture quotidienne', 'open', '07:00', '17:00')`,
      [club.id],
    );
    await tx.query(
      `INSERT INTO resource_types (club_id, code, kind, name, scope, required_per_tee_time, total_quantity)
       VALUES ($1, 'CADDIE', 'caddie', 'Caddie', 'tee_time', true, 0)`,
      [club.id],
    );
    await audit(tx, { clubId: club.id, actor, action: 'config.club.created', entityType: 'club', entityId: club.id, data: input });
    return club.id;
  }));
}
