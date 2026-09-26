import { describe, expect, it } from 'vitest';
import { buildQuote, selectTariff, splitCaddieFee, withTax, type Tariff } from '../src/domain/pricing.js';

function tariff(p: Partial<Tariff>): Tariff {
  return {
    id: Math.random().toString(), courseId: null, product: 'green_fee', name: 'GF', holes: null, customerCategory: null,
    validFrom: null, validTo: null, weekdays: null, startTime: null, endTime: null, amountMinor: 0, basis: 'per_player',
    priority: 0, ...p,
  };
}
const ctx = { product: 'green_fee' as const, courseId: 'c1', holes: 18 as const, customerCategory: 'standard',
  date: '2030-06-10', isoWeekday: 1, minuteOfDay: 8 * 60 };

describe('sélection du tarif', () => {
  const base = tariff({ name: 'base', holes: 18, amountMinor: 130000 });
  const weekend = tariff({ name: 'weekend', holes: 18, weekdays: [6, 7], amountMinor: 145000 });
  const twilight = tariff({ name: 'twilight', holes: 18, startTime: '15:00', endTime: '23:59', amountMinor: 90000, priority: 1 });
  const resident = tariff({ name: 'resident', holes: 18, customerCategory: 'resident', amountMinor: 90000, priority: 2 });
  const all = [base, weekend, twilight, resident];

  it('choisit le tarif le plus spécifique applicable', () => {
    expect(selectTariff(all, ctx)!.name).toBe('base');
    expect(selectTariff(all, { ...ctx, isoWeekday: 7 })!.name).toBe('weekend');
    expect(selectTariff(all, { ...ctx, minuteOfDay: 15 * 60 })!.name).toBe('twilight');
    expect(selectTariff(all, { ...ctx, customerCategory: 'resident', minuteOfDay: 15 * 60 })!.name).toBe('resident');
    expect(selectTariff(all, { ...ctx, holes: 9 })).toBeNull();
  });
});

describe('devis', () => {
  const input = {
    currency: 'MAD', taxRateBp: 2000, pricesIncludeTax: true, players: 2, holes: 18 as const, isPrivate: false,
    greenFee: tariff({ name: 'Green fee', amountMinor: 130000 }), privateSurcharge: tariff({ product: 'private_surcharge', name: 'Privé', amountMinor: 100000, basis: 'per_booking' }),
    caddie: { resourceTypeId: 'cad', label: 'Caddie', price9Minor: 10000, price18Minor: 20000 },
    caddiePayment: 'on_site' as const,
    options: [{ resourceTypeId: 'cart', label: 'Voiturette', quantity: 1, price9Minor: 25000, price18Minor: 40000 }],
  };

  it('facture le caddie en entier à chaque réservation (200 DH en 18 trous, 100 DH en 9)', () => {
    const q = buildQuote(input);
    expect(q.lines.find((l) => l.kind === 'caddie')!.totalMinor).toBe(20000);
    expect(buildQuote({ ...input, holes: 9 }).lines.find((l) => l.kind === 'caddie')!.totalMinor).toBe(10000);
    // Le nombre de joueurs ne change pas le prix du caddie.
    expect(buildQuote({ ...input, players: 4 }).lines.find((l) => l.kind === 'caddie')!.totalMinor).toBe(20000);
  });

  it('sépare ce qui est dû à la réservation de ce qui est payé sur place', () => {
    const onSite = buildQuote(input);
    expect(onSite.totalMinor).toBe(2 * 130000 + 20000 + 40000);
    expect(onSite.dueOnSiteMinor).toBe(20000);
    expect(onSite.dueWithBookingMinor).toBe(2 * 130000 + 40000);
    const prepaid = buildQuote({ ...input, caddiePayment: 'with_booking' });
    expect(prepaid.dueOnSiteMinor).toBe(0);
    expect(prepaid.dueWithBookingMinor).toBe(prepaid.totalMinor);
  });

  it('ajoute le supplément privé et exige un tarif configuré', () => {
    expect(buildQuote({ ...input, isPrivate: true }).lines.map((l) => l.kind)).toContain('private_surcharge');
    expect(() => buildQuote({ ...input, greenFee: null })).toThrow(expect.objectContaining({ code: 'PRICE_NOT_CONFIGURED' }));
    expect(() => buildQuote({ ...input, isPrivate: true, privateSurcharge: null })).toThrow(
      expect.objectContaining({ code: 'PRICE_NOT_CONFIGURED' }),
    );
  });

  it('calcule la TVA incluse ou en sus', () => {
    expect(withTax(120000, 2000, true)).toEqual({ ttc: 120000, tax: 20000 });
    expect(withTax(100000, 2000, false)).toEqual({ ttc: 120000, tax: 20000 });
  });
});

describe('répartition du caddie entre réservations d’un même départ', () => {
  const b = (id: string, players: number) => ({ id, players });
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, n) => a + n, 0);

  it('au prorata des joueurs, le total vaut toujours le prix du caddie', () => {
    expect([...splitCaddieFee(20000, [b('a', 2), b('b', 2)], 'pro_rata_players').values()]).toEqual([10000, 10000]);
    expect([...splitCaddieFee(20000, [b('a', 3), b('b', 1)], 'pro_rata_players').values()]).toEqual([15000, 5000]);
    const three = splitCaddieFee(20000, [b('a', 1), b('b', 1), b('c', 1)], 'pro_rata_players');
    expect(sum(three)).toBe(20000);
    expect([...three.values()]).toEqual([6700, 6700, 6600]); // dirhams entiers, sans centimes
    expect(sum(splitCaddieFee(10000, [b('a', 1), b('b', 2)], 'pro_rata_players'))).toBe(10000);
  });

  it('à parts égales ou entièrement à la première réservation', () => {
    expect([...splitCaddieFee(20000, [b('a', 3), b('b', 1)], 'equal').values()]).toEqual([10000, 10000]);
    expect([...splitCaddieFee(20000, [b('a', 3), b('b', 1)], 'first_booking').values()]).toEqual([20000, 0]);
    expect([...splitCaddieFee(20000, [b('a', 4)], 'pro_rata_players').values()]).toEqual([20000]);
  });
});
