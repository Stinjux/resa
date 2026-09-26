// Normalisation simple des numéros au format international (+indicatif…).
const DIAL: Record<string, string> = { MA: '212', FR: '33', ES: '34', PT: '351', BE: '32', CH: '41', GB: '44', US: '1', AE: '971', TN: '216', DZ: '213', SN: '221', CI: '225' };

export function normalizePhone(raw: string, countryCode: string | null): string {
  let s = raw.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) return s;
  const dial = countryCode ? DIAL[countryCode.toUpperCase()] : undefined;
  if (dial && s.startsWith('0')) return `+${dial}${s.slice(1)}`;
  if (dial && s.startsWith(dial)) return `+${s}`;
  return s;
}

/** 9 derniers chiffres : comparaison tolérante entre formats nationaux et internationaux. */
export const phoneKey = (phone: string) => phone.replace(/\D/g, '').slice(-9);
