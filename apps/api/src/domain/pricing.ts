// Tarification : fonctions pures, indépendantes de la base et de tout POS.
// Montants en unités mineures (centimes), arrondis à l'unité mineure.

import { DomainError } from '../shared/errors.js';
import { parseTimeToMinutes } from './schedule.js';

export type Payable = 'with_booking' | 'on_site';

export interface Tariff {
  id: string;
  courseId: string | null;
  product: 'green_fee' | 'private_surcharge';
  name: string;
  holes: number | null;
  customerCategory: string | null;
  validFrom: string | null;
  validTo: string | null;
  weekdays: number[] | null;
  startTime: string | null;
  endTime: string | null;
  amountMinor: number;
  basis: 'per_player' | 'per_booking';
  priority: number;
}

export interface TariffContext {
  product: Tariff['product'];
  courseId: string;
  holes: 9 | 18;
  customerCategory: string;
  date: string; // date locale du départ
  isoWeekday: number;
  minuteOfDay: number; // heure locale du départ
}

export function tariffApplies(t: Tariff, c: TariffContext): boolean {
  if (t.product !== c.product) return false;
  if (t.courseId !== null && t.courseId !== c.courseId) return false;
  if (t.holes !== null && t.holes !== c.holes) return false;
  if (t.customerCategory !== null && t.customerCategory !== c.customerCategory) return false;
  if (t.validFrom !== null && c.date < t.validFrom) return false;
  if (t.validTo !== null && c.date > t.validTo) return false;
  if (t.weekdays !== null && t.weekdays.length > 0 && !t.weekdays.includes(c.isoWeekday)) return false;
  if (t.startTime !== null && t.endTime !== null) {
    if (c.minuteOfDay < parseTimeToMinutes(t.startTime) || c.minuteOfDay >= parseTimeToMinutes(t.endTime)) return false;
  }
  return true;
}

function specificity(t: Tariff): number {
  let s = 0;
  if (t.customerCategory !== null) s += 32;
  if (t.courseId !== null) s += 16;
  if (t.validFrom !== null && t.validFrom === t.validTo) s += 8;
  else if (t.validFrom !== null || t.validTo !== null) s += 4;
  if (t.startTime !== null) s += 2;
  if (t.weekdays !== null && t.weekdays.length > 0) s += 1;
  if (t.holes !== null) s += 1;
  return s;
}

/** Tarif applicable : priorité décroissante, puis le plus spécifique. */
export function selectTariff(tariffs: Tariff[], c: TariffContext): Tariff | null {
  const candidates = tariffs.filter((t) => tariffApplies(t, c));
  candidates.sort((a, b) => b.priority - a.priority || specificity(b) - specificity(a));
  return candidates[0] ?? null;
}

export interface ChargeLine {
  kind: 'green_fee' | 'private_surcharge' | 'caddie' | 'resource';
  tariffId: string | null;
  resourceTypeId: string | null;
  label: string;
  quantity: number;
  unitAmountMinor: number;
  totalMinor: number; // TTC
  taxRateBp: number;
  taxMinor: number;
  payable: Payable;
}

export interface Quote {
  currency: string;
  lines: ChargeLine[];
  totalMinor: number;
  taxMinor: number;
  dueWithBookingMinor: number;
  dueOnSiteMinor: number;
}

export interface QuoteInput {
  currency: string;
  taxRateBp: number;
  pricesIncludeTax: boolean;
  players: number;
  holes: 9 | 18;
  isPrivate: boolean;
  greenFee: Tariff | null;
  privateSurcharge: Tariff | null;
  /** Caddie : facturé en entier à CHAQUE réservation (règle validée). */
  /** Caddie : prix du départ (9/18) et part due par CETTE réservation. */
  caddie: {
    resourceTypeId: string;
    label: string;
    price9Minor: number;
    price18Minor: number;
    share?: { amountMinor: number; bookingPlayers: number; teeTimePlayers: number; bookings: number };
  } | null;
  caddiePayment: Payable;
  options: Array<{ resourceTypeId: string; label: string; quantity: number; price9Minor: number; price18Minor: number }>;
}

/** Montant TTC et taxe d'un prix saisi, selon que la grille est TTC ou HT. */
export function withTax(amountMinor: number, rateBp: number, pricesIncludeTax: boolean): { ttc: number; tax: number } {
  if (pricesIncludeTax) {
    return { ttc: amountMinor, tax: Math.round((amountMinor * rateBp) / (10_000 + rateBp)) };
  }
  const tax = Math.round((amountMinor * rateBp) / 10_000);
  return { ttc: amountMinor + tax, tax };
}

export function buildQuote(input: QuoteInput): Quote {
  if (!input.greenFee) {
    throw new DomainError('PRICE_NOT_CONFIGURED', 'Aucun tarif de green fee ne correspond à ce départ.');
  }
  const lines: ChargeLine[] = [];
  const push = (l: Omit<ChargeLine, 'totalMinor' | 'taxMinor' | 'taxRateBp'>) => {
    const { ttc, tax } = withTax(l.unitAmountMinor * l.quantity, input.taxRateBp, input.pricesIncludeTax);
    lines.push({ ...l, totalMinor: ttc, taxMinor: tax, taxRateBp: input.taxRateBp });
  };
  const byHoles = (p: { price9Minor: number; price18Minor: number }) => (input.holes === 9 ? p.price9Minor : p.price18Minor);

  const gf = input.greenFee;
  push({
    kind: 'green_fee',
    tariffId: gf.id,
    resourceTypeId: null,
    label: gf.name,
    quantity: gf.basis === 'per_player' ? input.players : 1,
    unitAmountMinor: gf.amountMinor,
    payable: 'with_booking',
  });

  if (input.isPrivate) {
    const ps = input.privateSurcharge;
    if (!ps) throw new DomainError('PRICE_NOT_CONFIGURED', 'Aucun tarif de départ privé configuré.');
    push({
      kind: 'private_surcharge',
      tariffId: ps.id,
      resourceTypeId: null,
      label: ps.name,
      quantity: ps.basis === 'per_player' ? input.players : 1,
      unitAmountMinor: ps.amountMinor,
      payable: 'with_booking',
    });
  }

  if (input.caddie) {
    const share = input.caddie.share;
    const full = byHoles(input.caddie);
    const shared = share && share.bookings > 1;
    const amount = share ? share.amountMinor : full;
    if (amount > 0 || !shared) {
      push({
        kind: 'caddie',
        tariffId: null,
        resourceTypeId: input.caddie.resourceTypeId,
        label: shared
          ? `${input.caddie.label} (${input.holes} trous) — part du départ partagé, ${full / 100} ${input.currency} au total`
          : `${input.caddie.label} (${input.holes} trous)`,
        quantity: 1,
        unitAmountMinor: amount,
        payable: input.caddiePayment,
      });
    }
  }

  for (const o of input.options) {
    if (o.quantity <= 0) continue;
    push({
      kind: 'resource',
      tariffId: null,
      resourceTypeId: o.resourceTypeId,
      label: o.label,
      quantity: o.quantity,
      unitAmountMinor: byHoles(o),
      payable: 'with_booking',
    });
  }

  const sum = (f: (l: ChargeLine) => number) => lines.reduce((n, l) => n + f(l), 0);
  return {
    currency: input.currency,
    lines,
    totalMinor: sum((l) => l.totalMinor),
    taxMinor: sum((l) => l.taxMinor),
    dueWithBookingMinor: sum((l) => (l.payable === 'with_booking' ? l.totalMinor : 0)),
    dueOnSiteMinor: sum((l) => (l.payable === 'on_site' ? l.totalMinor : 0)),
  };
}

export type CaddieFeeSplit = 'pro_rata_players' | 'equal' | 'first_booking';

/**
 * Répartit le prix unique du caddie d'un départ entre ses réservations
 * (dans l'ordre de réservation). La somme des parts vaut exactement le prix :
 * les centimes restants vont aux plus grands restes, puis aux premières.
 */
export function splitCaddieFee(totalMinor: number, bookings: Array<{ id: string; players: number }>, mode: CaddieFeeSplit): Map<string, number> {
  const result = new Map<string, number>();
  if (bookings.length === 0) return result;
  if (mode === 'first_booking') {
    bookings.forEach((b, i) => result.set(b.id, i === 0 ? totalMinor : 0));
    return result;
  }
  // Parts en unités entières de la devise (pas de centimes) pour des montants lisibles.
  const unit = totalMinor % 100 === 0 ? 100 : 1;
  const units = totalMinor / unit;
  const weights = bookings.map((b) => (mode === 'equal' ? 1 : b.players));
  const sum = weights.reduce((a, w) => a + w, 0);
  const exact = weights.map((w) => (units * w) / sum);
  const base = exact.map(Math.floor);
  let left = units - base.reduce((a, n) => a + n, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    base[i]! += 1;
    left -= 1;
  }
  bookings.forEach((b, i) => result.set(b.id, base[i]! * unit));
  return result;
}
