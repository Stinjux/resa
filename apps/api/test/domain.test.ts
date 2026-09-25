import { describe, expect, it } from 'vitest';
import { generateDaySlots, type ScheduleRule } from '../src/domain/schedule.js';
import { assertCanJoin, remainingSeats, type TeeTimeState } from '../src/domain/tee-time-rules.js';
import { peakUsage } from '../src/domain/resource-usage.js';

const defaults = { courseId: 'c1', intervalMinutes: 6, maxPlayers: 4, allowedHoles: [9, 18] };
function rule(p: Partial<ScheduleRule>): ScheduleRule {
  return {
    id: Math.random().toString(),
    courseId: null,
    kind: 'open',
    validFrom: null,
    validTo: null,
    weekdays: null,
    startTime: '07:00',
    endTime: '17:00',
    intervalMinutes: null,
    maxPlayers: null,
    allowedHoles: null,
    priority: 0,
    ...p,
  };
}

describe('grille des départs', () => {
  it('produit un départ toutes les 6 minutes par défaut, fin exclue', () => {
    const slots = generateDaySlots('2030-06-10', 1, [rule({})], defaults);
    expect(slots).toHaveLength(100); // 10 h × 10
    expect(slots[0]!.localTime).toBe('07:00');
    expect(slots[1]!.localTime).toBe('07:06');
    expect(slots.at(-1)!.localTime).toBe('16:54');
  });

  it('applique une fermeture exceptionnelle sur une plage horaire', () => {
    const rules = [rule({}), rule({ kind: 'closed', validFrom: '2030-06-10', validTo: '2030-06-10', startTime: '12:00', endTime: '14:00' })];
    const slots = generateDaySlots('2030-06-10', 1, rules, defaults);
    expect(slots.some((s) => s.localTime >= '12:00' && s.localTime < '14:00')).toBe(false);
    expect(slots.some((s) => s.localTime === '14:00')).toBe(true);
    // Le lendemain n'est pas concerné.
    expect(generateDaySlots('2030-06-11', 2, rules, defaults)).toHaveLength(100);
  });

  it("permet un intervalle et une capacité différents selon la plage et le parcours", () => {
    const rules = [
      rule({}),
      rule({ courseId: 'c1', startTime: '07:00', endTime: '08:00', intervalMinutes: 10, maxPlayers: 3 }),
    ];
    const slots = generateDaySlots('2030-06-10', 1, rules, defaults);
    const morning = slots.filter((s) => s.localTime < '08:00');
    expect(morning.map((s) => s.localTime)).toEqual(['07:00', '07:10', '07:20', '07:30', '07:40', '07:50']);
    expect(morning.every((s) => s.maxPlayers === 3 && s.intervalMinutes === 10)).toBe(true);
    expect(slots.find((s) => s.localTime === '08:00')!.maxPlayers).toBe(4);
  });

  it('respecte les jours de la semaine et plafonne la capacité à 4', () => {
    const rules = [rule({ weekdays: [6, 7], maxPlayers: 4 })];
    expect(generateDaySlots('2030-06-10', 1, rules, defaults)).toHaveLength(0);
    expect(generateDaySlots('2030-06-15', 6, rules, defaults)).toHaveLength(100);
  });

  it('une fermeture totale prioritaire ferme la journée', () => {
    const rules = [rule({}), rule({ kind: 'closed', validFrom: '2030-06-10', validTo: '2030-06-10', startTime: '00:00', endTime: '23:59' })];
    expect(generateDaySlots('2030-06-10', 1, rules, defaults)).toHaveLength(0);
  });
});

describe("règles d'un départ", () => {
  const empty: TeeTimeState = { maxPlayers: 4, holes: null, isPrivate: false, bookedPlayers: 0 };

  it('refuse plus de 4 joueurs', () => {
    expect(() => assertCanJoin(empty, { players: 5, holes: 18, isPrivate: false })).toThrow(/joueurs/);
    expect(() => assertCanJoin({ ...empty, bookedPlayers: 3, holes: 18 }, { players: 2, holes: 18, isPrivate: false })).toThrow(
      expect.objectContaining({ code: 'TEE_TIME_FULL' }),
    );
    expect(() => assertCanJoin({ ...empty, bookedPlayers: 2, holes: 18 }, { players: 2, holes: 18, isPrivate: false })).not.toThrow();
  });

  it('un départ privé ne propose plus de places', () => {
    const priv = { ...empty, bookedPlayers: 2, holes: 18 as const, isPrivate: true };
    expect(remainingSeats(priv)).toBe(0);
    expect(() => assertCanJoin(priv, { players: 1, holes: 18, isPrivate: false })).toThrow(
      expect.objectContaining({ code: 'TEE_TIME_PRIVATE' }),
    );
  });

  it('refuse de privatiser un départ déjà occupé et de mélanger 9 et 18 trous', () => {
    const occupied = { ...empty, bookedPlayers: 1, holes: 18 as const };
    expect(() => assertCanJoin(occupied, { players: 1, holes: 18, isPrivate: true })).toThrow(
      expect.objectContaining({ code: 'PRIVATE_REQUIRES_EMPTY_TEE_TIME' }),
    );
    expect(() => assertCanJoin(occupied, { players: 1, holes: 9, isPrivate: false })).toThrow(
      expect.objectContaining({ code: 'HOLES_MISMATCH' }),
    );
  });
});

describe('pic d’occupation des ressources', () => {
  it('ne cumule pas des locations qui ne se chevauchent pas', () => {
    const usages = [
      { start: 0, end: 100, quantity: 1 },
      { start: 150, end: 250, quantity: 1 },
    ];
    expect(peakUsage(usages, 50, 200)).toBe(1);
    expect(peakUsage([...usages, { start: 90, end: 160, quantity: 1 }], 0, 300)).toBe(2);
    // Intervalles semi-ouverts : fin à 100 et début à 100 ne se chevauchent pas.
    expect(peakUsage([{ start: 0, end: 100, quantity: 1 }, { start: 100, end: 200, quantity: 1 }], 0, 200)).toBe(1);
  });
});
