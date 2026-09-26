export function money(minor: number | null | undefined, currency = 'MAD'): string {
  if (minor === null || minor === undefined) return '—';
  return new Intl.NumberFormat('fr-MA', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

/** Date du jour dans le fuseau du golf (YYYY-MM-DD). */
export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

export function addDays(date: string, n: number): string {
  if (!date) return '';
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function longDate(date: string): string {
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

export const CHANNEL_LABEL: Record<string, string> = {
  web: 'Web', phone: 'Téléphone', group: 'Groupe', walk_in: 'Sur place', staff: 'Personnel',
};

export const ROLE_LABEL: Record<string, string> = {
  org_admin: 'Administrateur', club_admin: 'Direction', receptionist: 'Réception', starter: 'Starter',
};
