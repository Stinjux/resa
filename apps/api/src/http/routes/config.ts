import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCan } from '../../modules/auth/permissions.js';
import { getClub, getCourse } from '../../modules/catalog/repository.js';
import {
  createClub,
  createEntity,
  ENTITIES,
  getClubConfig,
  setCapacityOverride,
  updateClubSettings,
  updateEntity,
  type EntityName,
} from '../../modules/config/service.js';
import { computeGrid } from '../../modules/teesheet/service.js';
import { DomainError } from '../../shared/errors.js';
import { actorOf } from '../auth.js';
import type { AppDeps } from '../server.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure HH:MM');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ');
const holesList = z.array(z.union([z.literal(9), z.literal(18)])).min(1);
const weekdays = z.array(z.number().int().min(1).max(7)).nullable();
const money = z.number().int().min(0).max(100_000_000); // unités mineures
const code = z.string().regex(/^[A-Z0-9_-]{1,30}$/, 'Code : lettres majuscules, chiffres, - ou _');

const SCHEMAS = {
  courses: z.object({
    code, name: z.string().min(1).max(100), allowedHoles: holesList,
    defaultIntervalMinutes: z.number().int().min(1).max(60), defaultMaxPlayers: z.number().int().min(1).max(4),
    playMinutes9: z.number().int().min(30).max(600), playMinutes18: z.number().int().min(60).max(900), active: z.boolean(),
  }),
  'schedule-rules': z.object({
    courseId: z.uuid().nullable(), name: z.string().min(1).max(100), kind: z.enum(['open', 'closed']),
    validFrom: date.nullable(), validTo: date.nullable(), weekdays, startTime: time, endTime: time,
    intervalMinutes: z.number().int().min(1).max(60).nullable(), maxPlayers: z.number().int().min(1).max(4).nullable(),
    allowedHoles: holesList.nullable(), priority: z.number().int().min(-100).max(100), active: z.boolean(),
  }),
  tariffs: z.object({
    courseId: z.uuid().nullable(), product: z.enum(['green_fee', 'private_surcharge']), name: z.string().min(1).max(100),
    holes: z.union([z.literal(9), z.literal(18)]).nullable(), customerCategory: z.string().min(1).max(40).nullable(),
    validFrom: date.nullable(), validTo: date.nullable(), weekdays, startTime: time.nullable(), endTime: time.nullable(),
    amountMinor: money, basis: z.enum(['per_player', 'per_booking']), priority: z.number().int().min(-100).max(100), active: z.boolean(),
  }),
  'resource-types': z.object({
    code, kind: z.enum(['caddie', 'cart', 'trolley', 'rental_bag', 'other']), variant: z.string().max(40).nullable(),
    name: z.string().min(1).max(100), totalQuantity: z.number().int().min(0).max(10_000), price9Minor: money, price18Minor: money,
    bufferMinutes: z.number().int().min(0).max(600), maxPerBooking: z.number().int().min(1).max(100).nullable(),
    active: z.boolean(), sortOrder: z.number().int(),
  }),
  caddies: z.object({ displayName: z.string().min(1).max(100), phone: z.string().max(40).nullable(), active: z.boolean() }),
  'resource-units': z.object({
    resourceTypeId: z.uuid(), label: z.string().min(1).max(40), status: z.enum(['available', 'maintenance', 'retired']),
  }),
} satisfies Record<EntityName, z.ZodObject>;

const REQUIRED_ON_CREATE: Record<EntityName, string[]> = {
  courses: ['code', 'name'],
  'schedule-rules': ['name', 'kind', 'startTime', 'endTime'],
  tariffs: ['product', 'name', 'amountMinor', 'basis'],
  'resource-types': ['code', 'kind', 'name', 'totalQuantity'],
  caddies: ['displayName'],
  'resource-units': ['resourceTypeId', 'label'],
};

const entityParam = z.enum(Object.keys(ENTITIES) as [EntityName, ...EntityName[]]);

export function configRoutes(app: FastifyInstance, deps: AppDeps) {
  async function adminClub(req: { params: unknown; principal: any }) {
    const { clubId } = z.object({ clubId: z.uuid() }).parse(req.params);
    const club = await getClub(deps.db, clubId);
    assertCan(req.principal, 'config.manage', club);
    return club;
  }

  // Nouveau golf (administrateur du groupe uniquement).
  app.post('/api/clubs', async (req, reply) => {
    const p = req.principal;
    if (!p) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
    if (!p.roles.some((r) => r.role === 'org_admin' && r.clubId === null)) {
      throw new DomainError('FORBIDDEN', "Réservé à l'administrateur du groupe.");
    }
    const body = z.object({
      code, name: z.string().min(1).max(100),
      timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Fuseau horaire IANA invalide'),
      currency: z.string().regex(/^[A-Z]{3}$/), defaultLocale: z.string().min(2).max(10).default('fr'),
      countryCode: z.string().regex(/^[A-Z]{2}$/).nullable().default(null), taxRateBp: z.number().int().min(0).max(10_000).default(0),
    }).parse(req.body);
    const id = await createClub(deps.db, p.organizationId, body, actorOf(req));
    return reply.status(201).send({ id });
  });

  app.get('/api/clubs/:clubId/config', async (req) => {
    const club = await adminClub(req);
    return { ...(await getClubConfig(deps.db, club.id)), posProviders: [...deps.posRegistry.keys()], messagingProviders: [...deps.messaging.keys()] };
  });

  app.patch('/api/clubs/:clubId/config', async (req) => {
    const club = await adminClub(req);
    const patch = z.object({
      name: z.string().min(1).max(100), timezone: z.string().refine((tz) => {
        try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
      }, 'Fuseau horaire IANA invalide'),
      currency: z.string().regex(/^[A-Z]{3}$/), defaultLocale: z.string().min(2).max(10),
      pricesIncludeTax: z.boolean(), taxRateBp: z.number().int().min(0).max(10_000),
      bookingHorizonDays: z.number().int().min(1).max(730), minLeadMinutes: z.number().int().min(0).max(10_080),
      defaultCaddiePayment: z.enum(['on_site', 'with_booking']),
      caddieFeeSplit: z.enum(['pro_rata_players', 'equal', 'first_booking']),
      cancellationFreeHours: z.number().int().min(0).max(720), cancellationFeePercent: z.number().int().min(0).max(100),
      noShowFeePercent: z.number().int().min(0).max(100),
      emailEnabled: z.boolean(), emailReplyTo: z.email().nullable(), contactPhone: z.string().max(40).nullable(),
      reminderHoursBefore: z.number().int().min(0).max(168),
      legalName: z.string().max(200).nullable(), legalAddress: z.string().max(500).nullable(), ice: z.string().max(30).nullable(),
      taxId: z.string().max(30).nullable(), tradeRegister: z.string().max(60).nullable(), patente: z.string().max(30).nullable(),
      invoiceFooter: z.string().max(500).nullable(),
      customerCanCancel: z.boolean(), onlinePayment: z.enum(['none', 'optional', 'required']),
      posProvider: z.string().nullable().refine((p) => p === null || deps.posRegistry.has(p), 'Connecteur POS non installé'),
      messagingProvider: z.string().nullable().refine((p) => p === null || deps.messaging.has(p), 'Connecteur de messagerie non installé'),
    }).partial().strict().parse(req.body);
    await updateClubSettings(deps.db, club.id, patch, actorOf(req));
    return { ...(await getClubConfig(deps.db, club.id)), posProviders: [...deps.posRegistry.keys()], messagingProviders: [...deps.messaging.keys()] };
  });

  app.post('/api/clubs/:clubId/config/:entity', async (req, reply) => {
    const club = await adminClub(req);
    const entity = entityParam.parse((req.params as { entity: string }).entity);
    const values: Record<string, unknown> = SCHEMAS[entity].partial().strict().parse(req.body);
    const missing = REQUIRED_ON_CREATE[entity].filter((k) => values[k] === undefined || values[k] === null);
    if (missing.length) throw new DomainError('VALIDATION', `Champs obligatoires : ${missing.join(', ')}.`);
    if (entity === 'resource-types') {
      // Le caddie est obligatoire et unique par départ ; le reste se loue par réservation.
      const isCaddie = values.kind === 'caddie';
      if (isCaddie) {
        const { rowCount } = await deps.db.query(`SELECT 1 FROM resource_types WHERE club_id = $1 AND kind = 'caddie'`, [club.id]);
        if (rowCount) throw new DomainError('VALIDATION', 'Ce golf a déjà un type « caddie ».');
      }
      values.scope = isCaddie ? 'tee_time' : 'booking';
      values.requiredPerTeeTime = isCaddie;
    }
    const id = await createEntity(deps.db, club.id, entity, values, actorOf(req));
    return reply.status(201).send({ id });
  });

  app.patch('/api/clubs/:clubId/config/:entity/:id', async (req) => {
    const club = await adminClub(req);
    const { entity: e, id } = z.object({ entity: z.string(), id: z.uuid() }).parse(req.params);
    const entity = entityParam.parse(e);
    // Code, type et rattachement ne changent pas après création.
    const patch: Record<string, unknown> = (SCHEMAS[entity] as z.ZodObject).partial().strict().parse(req.body);
    const frozen = ['code', 'kind', 'variant', 'resourceTypeId'].filter((k) => k in patch);
    if (frozen.length) throw new DomainError('VALIDATION', `Non modifiable après création : ${frozen.join(', ')}.`);
    await updateEntity(deps.db, club.id, entity, id, patch, actorOf(req));
    return { ok: true };
  });

  app.put('/api/clubs/:clubId/config/resource-types/:id/overrides/:date', async (req) => {
    const club = await adminClub(req);
    const p = z.object({ id: z.uuid(), date }).parse(req.params);
    const body = z.object({ quantity: z.number().int().min(0).max(10_000).nullable(), reason: z.string().max(200).nullable().optional() }).parse(req.body);
    await setCapacityOverride(deps.db, club.id, p.id, p.date, body.quantity, body.reason ?? null, actorOf(req));
    return { ok: true };
  });

  // Aperçu de la grille d'un jour avec la configuration en vigueur.
  app.get('/api/clubs/:clubId/config/grid-preview', async (req) => {
    const club = await adminClub(req);
    const q = z.object({ courseId: z.uuid(), date }).parse(req.query);
    const course = await getCourse(deps.db, q.courseId);
    if (course.clubId !== club.id) throw new DomainError('NOT_FOUND', 'Parcours introuvable pour ce golf.');
    const grid = await computeGrid(deps.db, club, course, q.date);
    return { slots: grid.map((s) => ({ localTime: s.localTime, maxPlayers: s.maxPlayers, allowedHoles: s.allowedHoles, intervalMinutes: s.intervalMinutes })) };
  });
}
