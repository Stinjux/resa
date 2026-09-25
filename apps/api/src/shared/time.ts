import { DateTime } from 'luxon';

/** Convertit une heure locale du golf en instant UTC ; null si l'heure
 *  n'existe pas ce jour-là (passage à l'heure d'été). */
export function localToInstant(date: string, minuteOfDay: number, timezone: string): Date | null {
  const [y, m, d] = date.split('-').map(Number);
  const dt = DateTime.fromObject(
    { year: y, month: m, day: d, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 },
    { zone: timezone },
  );
  if (!dt.isValid) return null;
  if (dt.hour * 60 + dt.minute !== minuteOfDay) return null; // heure « sautée »
  return dt.toJSDate();
}

export function instantToLocal(instant: Date, timezone: string): { date: string; time: string; minuteOfDay: number } {
  const dt = DateTime.fromJSDate(instant, { zone: timezone });
  return { date: dt.toISODate()!, time: dt.toFormat('HH:mm'), minuteOfDay: dt.hour * 60 + dt.minute };
}

export function isoWeekday(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday;
}

export function isValidIsoDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && DateTime.fromISO(date).isValid;
}
