// Ratios de contraste WCAG 2.x des combinaisons du thème (docs/THEME.md).
// Usage : node scripts/contrast.mjs [--md]
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../apps/web/src/theme.css', import.meta.url), 'utf8');
function block(selector) {
  const i = css.indexOf(selector);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
}
const light = block(':root,\n[data-theme="light"]');
const dark = { ...light, ...block('[data-theme="dark"] {') };

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [usage, avant-plan, arrière-plan, seuil]
const PAIRS = [
  ['Texte courant', 'color-text', 'color-bg', 4.5],
  ['Texte sur carte', 'color-text', 'color-surface', 4.5],
  ['Texte secondaire sur carte', 'color-text-muted', 'color-surface', 4.5],
  ['Texte secondaire sur fond', 'color-text-muted', 'color-bg', 4.5],
  ['Texte secondaire sur surface atténuée', 'color-text-muted', 'color-surface-muted', 4.5],
  ['Bouton primaire (texte)', 'color-on-primary', 'color-primary', 4.5],
  ['Bouton primaire survol', 'color-on-primary', 'color-primary-hover', 4.5],
  ['Lien / bouton ghost', 'color-primary', 'color-surface', 4.5],
  ['Ghost au survol', 'color-primary', 'color-primary-subtle', 4.5],
  ['Texte sur fond primaire atténué', 'color-text', 'color-primary-subtle', 4.5],
  ['Créneau sélectionné', 'color-on-primary', 'color-primary', 4.5],
  ['Créneau presque complet', 'color-warning', 'color-warning-subtle', 4.5],
  ['Badge succès / tarif réduit', 'color-success', 'color-success-subtle', 4.5],
  ['Badge attente', 'color-warning', 'color-warning-subtle', 4.5],
  ['Badge annulée / erreur', 'color-danger', 'color-danger-subtle', 4.5],
  ['Badge info / privé', 'color-info', 'color-info-subtle', 4.5],
  ['Texte d’erreur sous champ', 'color-danger', 'color-surface', 4.5],
  ['Bouton destructif plein (modale)', 'color-surface', 'color-danger', 4.5],
  ['Texte sur créneau tarif réduit (badge)', 'color-success', 'color-surface', 4.5],
  ['Texte d’alerte avertissement', 'color-warning', 'color-surface', 4.5],
  ['Libellé membres (texte accent)', 'color-accent-text', 'color-surface', 4.5],
  ['Libellé membres sur accent atténué', 'color-accent-text', 'color-accent-subtle', 4.5],
  ['Bordure champs / contrôles', 'color-border-control', 'color-surface', 3],
  ['Bordure créneau membres (accent)', 'color-accent', 'color-surface', 3],
  ['Anneau « aujourd’hui » (primaire)', 'color-primary', 'color-surface', 3],
  ['Icône succès', 'color-success', 'color-surface', 3],
  ['Bordure décorative forte (non interactive)', 'color-border-strong', 'color-surface', 0],
  ['Texte désactivé (exempté WCAG)', 'color-text-disabled', 'color-surface-muted', 0],
];

const md = process.argv.includes('--md');
let fail = 0;
const rows = PAIRS.map(([use, fg, bg, min]) => {
  const l = ratio(light[fg], light[bg]);
  const d = ratio(dark[fg], dark[bg]);
  const ok = (r) => (min === 0 ? 'info' : r >= min ? 'OK' : 'ÉCHEC');
  if (min && (l < min || d < min)) fail++;
  return { use, fg, bg, min, l, d, lo: ok(l), dOk: ok(d) };
});
if (md) {
  console.log('| Usage | Avant-plan / fond | Seuil | Clair | Sombre |\n|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.use} | \`--${r.fg}\` / \`--${r.bg}\` | ${r.min ? `${r.min}:1` : '—'} | ${r.l.toFixed(2)}:1 ${r.lo === 'OK' ? '✅' : r.lo === 'info' ? 'ℹ️' : '❌'} | ${r.d.toFixed(2)}:1 ${r.dOk === 'OK' ? '✅' : r.dOk === 'info' ? 'ℹ️' : '❌'} |`);
  }
} else {
  for (const r of rows) console.log(`${r.lo.padEnd(5)} ${r.dOk.padEnd(5)} ${r.l.toFixed(2).padStart(5)} ${r.d.toFixed(2).padStart(5)}  ${r.use}`);
  console.log(fail ? `\n${fail} combinaison(s) sous le seuil` : '\nToutes les combinaisons respectent le seuil.');
}
process.exitCode = fail ? 1 : 0;
