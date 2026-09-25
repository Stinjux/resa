// Génération de la grille des départs d'une journée à partir de règles
// configurables. Fonction pure : aucune dépendance à la base ni au fuseau.

export interface ScheduleRule {
  id: string;
  courseId: string | null;
  kind: 'open' | 'closed';
  validFrom: string | null; // YYYY-MM-DD inclus
  validTo: string | null; // YYYY-MM-DD inclus
  weekdays: number[] | null; // ISO 1 = lundi … 7 = dimanche
  startTime: string; // HH:MM[:SS] heure locale, incluse
  endTime: string; // HH:MM[:SS] heure locale, exclue
  intervalMinutes: number | null;
  maxPlayers: number | null;
  allowedHoles: number[] | null;
  priority: number;
}

export interface CourseScheduleDefaults {
  courseId: string;
  intervalMinutes: number;
  maxPlayers: number;
  allowedHoles: number[];
}

export interface Slot {
  minuteOfDay: number;
  localTime: string; // HH:MM
  intervalMinutes: number;
  maxPlayers: number;
  allowedHoles: number[];
  ruleId: string;
}

/** Limite absolue d'un départ, quelle que soit la configuration. */
export const MAX_PLAYERS_PER_TEE_TIME = 4;

export function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':');
  const minutes = Number(h) * 60 + Number(m);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
    throw new Error(`Heure invalide : ${time}`);
  }
  return minutes;
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function ruleAppliesOn(rule: ScheduleRule, date: string, isoWeekday: number, courseId: string): boolean {
  if (rule.courseId !== null && rule.courseId !== courseId) return false;
  if (rule.validFrom !== null && date < rule.validFrom) return false;
  if (rule.validTo !== null && date > rule.validTo) return false;
  if (rule.weekdays !== null && rule.weekdays.length > 0 && !rule.weekdays.includes(isoWeekday)) return false;
  return true;
}

/** Plus la règle est ciblée, plus elle l'emporte à priorité égale. */
export function ruleSpecificity(rule: ScheduleRule): number {
  let score = 0;
  if (rule.courseId !== null) score += 8;
  if (rule.validFrom !== null && rule.validFrom === rule.validTo) score += 4;
  else if (rule.validFrom !== null || rule.validTo !== null) score += 2;
  if (rule.weekdays !== null && rule.weekdays.length > 0) score += 1;
  return score;
}

type Interval = [number, number];

function isCovered(minute: number, covered: Interval[]): boolean {
  return covered.some(([s, e]) => minute >= s && minute < e);
}

/**
 * Calcule les créneaux d'une journée.
 * Les règles sont appliquées de la plus forte à la plus faible : une règle
 * « closed » ou « open » plus prioritaire masque les règles plus faibles sur
 * sa plage. Chaque règle ouverte produit ses créneaux sur sa propre grille
 * (début + k × intervalle), ce qui garde des horaires stables quand une
 * exception couvre une partie de la journée.
 */
export function generateDaySlots(
  date: string,
  isoWeekday: number,
  rules: ScheduleRule[],
  defaults: CourseScheduleDefaults,
): Slot[] {
  const applicable = rules
    .filter((r) => ruleAppliesOn(r, date, isoWeekday, defaults.courseId))
    .sort((a, b) => b.priority - a.priority || ruleSpecificity(b) - ruleSpecificity(a));

  const covered: Interval[] = [];
  const slots: Slot[] = [];

  for (const rule of applicable) {
    const start = parseTimeToMinutes(rule.startTime);
    const end = parseTimeToMinutes(rule.endTime);
    if (end <= start) continue;

    if (rule.kind === 'open') {
      const interval = rule.intervalMinutes ?? defaults.intervalMinutes;
      const maxPlayers = Math.min(rule.maxPlayers ?? defaults.maxPlayers, MAX_PLAYERS_PER_TEE_TIME);
      const allowedHoles = (rule.allowedHoles ?? defaults.allowedHoles).filter((h) =>
        defaults.allowedHoles.includes(h),
      );
      for (let t = start; t < end; t += interval) {
        if (isCovered(t, covered)) continue;
        slots.push({
          minuteOfDay: t,
          localTime: formatMinutes(t),
          intervalMinutes: interval,
          maxPlayers,
          allowedHoles,
          ruleId: rule.id,
        });
      }
    }
    covered.push([start, end]);
  }

  return slots.sort((a, b) => a.minuteOfDay - b.minuteOfDay);
}
