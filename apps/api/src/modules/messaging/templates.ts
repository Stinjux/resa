// Messages automatiques envoyés au client (hors IA), par langue.
type Vars = Record<string, string>;
const T = {
  received: {
    fr: 'Merci ! Votre demande est transmise au golf {golf} pour validation. Vous recevrez une confirmation ici.',
    en: 'Thank you! Your request has been sent to {golf} for approval. You will receive a confirmation here.',
    ar: 'شكراً! تم إرسال طلبك إلى {golf} للموافقة عليه. ستصلك رسالة تأكيد هنا.',
  },
  approved: {
    fr: 'Réservation confirmée ✅ {golf} — {details}. Référence : {refs}. Total : {total}. À bientôt !',
    en: 'Booking confirmed ✅ {golf} — {details}. Reference: {refs}. Total: {total}. See you soon!',
    ar: 'تم تأكيد الحجز ✅ {golf} — {details}. المرجع: {refs}. المجموع: {total}. إلى اللقاء!',
  },
  rejected: {
    fr: "Désolé, votre demande n'a pas pu être acceptée par {golf}.{reason} N'hésitez pas à proposer un autre horaire.",
    en: 'Sorry, {golf} could not accept your request.{reason} Feel free to suggest another time.',
    ar: 'عذراً، لم يتمكن {golf} من قبول طلبك.{reason} يمكنك اقتراح موعد آخر.',
  },
  noAi: {
    fr: 'Merci pour votre message. Le golf {golf} vous répond au plus vite.',
    en: 'Thank you for your message. {golf} will reply as soon as possible.',
    ar: 'شكراً على رسالتك. سيرد عليك {golf} في أقرب وقت.',
  },
} as const;

export type TemplateKey = keyof typeof T;

export function render(key: TemplateKey, locale: string | null, vars: Vars): string {
  const lang = (locale && locale in T[key] ? locale : 'fr') as keyof (typeof T)[TemplateKey];
  return T[key][lang].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

const WORDS: Record<string, [string, string]> = { fr: ['joueurs', 'trous'], en: ['players', 'holes'], ar: ['لاعبين', 'حفرة'] };

/** « 2026-09-27 11:00, 3 joueurs, 18 trous » dans la langue du client. */
export function teeTimeLine(locale: string | null, date: string, time: string, players: number, holes: number): string {
  const [p, h] = WORDS[locale ?? 'fr'] ?? WORDS.fr!;
  return `${date} ${time}, ${players} ${p}, ${holes} ${h}`;
}
