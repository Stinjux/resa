// Choix du thème : automatique (système), clair ou sombre. Préférence
// mémorisée sur l'appareil ; appliquée via l'attribut data-theme de <html>.

export type ThemeChoice = 'auto' | 'light' | 'dark';
const KEY = 'resa.theme';

export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice);
  } catch { /* stockage indisponible : choix limité à la session */ }
}

export const applyStoredTheme = () => applyTheme(storedTheme());
