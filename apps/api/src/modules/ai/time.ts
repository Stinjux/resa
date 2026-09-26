import { localToInstant as toInstant } from '../../shared/time.js';

/** « 13h », « 13:00 », « 9h5 », « 09:05 » → « HH:MM » ; null si invalide. */
export function parseTimeMaybe(value: string | undefined | null): string | null {
  if (!value) return null;
  const m = /^\s*(\d{1,2})\s*(?:[:hH.]\s*(\d{1,2})?)?\s*$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function localToInstant(date: string, hhmm: string, timezone: string): Date | null {
  const [h, m] = hhmm.split(':').map(Number);
  return toInstant(date, h! * 60 + m!, timezone);
}
