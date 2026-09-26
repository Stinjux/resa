import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { LOCALES, MESSAGES, type Locale, type MessageKey } from './messages';

const KEY = 'resa.locale';

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && saved in LOCALES) return saved as Locale;
  } catch { /* stockage indisponible */ }
  const nav = navigator.language?.slice(0, 2);
  return nav && nav in LOCALES ? (nav as Locale) : 'fr';
}

let current: Locale = 'fr';
/** Locale courante, utilisable hors composants (formatage). */
export const currentLocale = () => current;
export const currentIntl = () => LOCALES[current].intl;

export type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const text = MESSAGES[locale][key] ?? MESSAGES.fr[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : text;
}

const Ctx = createContext<{ locale: Locale; setLocale: (l: Locale) => void; t: T }>({
  locale: 'fr', setLocale: () => undefined, t: (k, v) => translate('fr', k, v),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  current = locale;
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALES[locale].dir;
    try { localStorage.setItem(KEY, locale); } catch { /* ignoré */ }
  }, [locale]);
  return <Ctx.Provider value={{ locale, setLocale, t: (k, v) => translate(locale, k, v) }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);

/** Message d'erreur traduit à partir du code métier de l'API. */
export function errorText(t: T, err: unknown): string {
  if (err instanceof ApiError) {
    const key = `err.${err.code}` as MessageKey;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return (err as Error).message;
}

export function LocaleSwitcher() {
  const { locale, setLocale } = useI18n();
  return (
    <select aria-label="Langue / Language" value={locale} onChange={(e) => setLocale(e.target.value as Locale)} style={{ padding: '4px 6px' }}>
      {Object.entries(LOCALES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
    </select>
  );
}
