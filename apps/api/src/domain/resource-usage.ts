// Calcul d'occupation des ressources dans le temps (caddies, voiturettes…).
// On compare le pic d'utilisation simultanée à la capacité : deux locations
// qui ne se chevauchent pas n'additionnent pas leurs quantités.

export interface Usage {
  start: number; // epoch ms, inclus
  end: number; // epoch ms, exclu
  quantity: number;
}

/** Pic d'utilisation simultanée sur la fenêtre [windowStart, windowEnd). */
export function peakUsage(usages: Usage[], windowStart: number, windowEnd: number): number {
  const events: Array<[number, number]> = [];
  for (const u of usages) {
    const s = Math.max(u.start, windowStart);
    const e = Math.min(u.end, windowEnd);
    if (s >= e) continue;
    events.push([s, u.quantity], [e, -u.quantity]);
  }
  // À instant égal, les fins passent avant les débuts (intervalles semi-ouverts).
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
}

export function available(capacity: number, usages: Usage[], windowStart: number, windowEnd: number): number {
  return Math.max(0, capacity - peakUsage(usages, windowStart, windowEnd));
}

export interface UsageDurations {
  playMinutes9: number;
  playMinutes18: number;
}

/** Période d'occupation d'une ressource pour un départ. */
export function usagePeriod(
  startsAt: Date,
  holes: 9 | 18,
  durations: UsageDurations,
  bufferMinutes: number,
): { start: Date; end: Date } {
  const play = holes === 9 ? durations.playMinutes9 : durations.playMinutes18;
  return { start: startsAt, end: new Date(startsAt.getTime() + (play + bufferMinutes) * 60_000) };
}

/** Prix d'une ressource selon la formule 9/18 trous. */
export function priceForHoles(prices: { price9Minor: number; price18Minor: number }, holes: 9 | 18): number {
  return holes === 9 ? prices.price9Minor : prices.price18Minor;
}
