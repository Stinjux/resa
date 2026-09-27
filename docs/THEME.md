# Thème et design system

Interface professionnelle et sobre : ~80 % de neutres chauds, ~15 % de vert
primaire, ~5 % d'accent laiton (réservé au premium / membres). La couleur
guide l'action ; elle n'est jamais le seul porteur d'information (icône,
libellé ou motif en plus).

## Fichiers

| Fichier | Rôle |
|---|---|
| `apps/web/src/theme.css` | **Seule source** des tokens : couleurs (clair / sombre), polices, tailles, rayons, ombres, papier des documents |
| `apps/web/src/styles.css` | Composants ; n'utilise que les tokens (aucun hex, aucun nom de police) |
| `apps/web/src/components/ui.tsx` | Créneau (7 états), légende, stepper, calendrier, badges de statut, sélecteur de joueurs, modale de confirmation |
| `apps/web/src/theme.ts` | Choix Auto / Clair / Sombre (`data-theme` sur `<html>`, mémorisé sur l'appareil) |
| `/styleguide` | Page interne : palette, typographie, boutons, champs, badges, 7 états de créneau, stepper, calendrier, barre récap — en clair et en sombre côte à côte |
| `scripts/contrast.mjs` | Calcule les ratios ci-dessous à partir de `theme.css` (`node scripts/contrast.mjs` ; code de sortie ≠ 0 si un seuil est manqué) |

## Stack : pourquoi pas de configuration Tailwind

Le projet n'utilise ni Tailwind ni librairie UI : React + CSS. Le « mapping
sémantique » est donc fait par les variables CSS elles-mêmes
(`--color-surface`, `--color-primary`, `--font-display`…), consommées par des
classes (`.btn.primary`, `.tee-slot.full`, `.badge.success`…). Si Tailwind
est adopté plus tard, le preset se déduit directement :

```js
// tailwind.config.js (exemple, non utilisé aujourd'hui)
export default {
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)', surface: { DEFAULT: 'var(--color-surface)', muted: 'var(--color-surface-muted)' },
        border: { DEFAULT: 'var(--color-border)', strong: 'var(--color-border-strong)', control: 'var(--color-border-control)' },
        text: { DEFAULT: 'var(--color-text)', muted: 'var(--color-text-muted)', disabled: 'var(--color-text-disabled)' },
        primary: { DEFAULT: 'var(--color-primary)', hover: 'var(--color-primary-hover)', active: 'var(--color-primary-active)',
          subtle: 'var(--color-primary-subtle)', on: 'var(--color-on-primary)' },
        accent: { DEFAULT: 'var(--color-accent)', text: 'var(--color-accent-text)', subtle: 'var(--color-accent-subtle)' },
        success: { DEFAULT: 'var(--color-success)', subtle: 'var(--color-success-subtle)' },
        warning: { DEFAULT: 'var(--color-warning)', subtle: 'var(--color-warning-subtle)' },
        danger: { DEFAULT: 'var(--color-danger)', subtle: 'var(--color-danger-subtle)' },
        info: { DEFAULT: 'var(--color-info)', subtle: 'var(--color-info-subtle)' },
      },
      fontFamily: { display: 'var(--font-display)', ui: 'var(--font-ui)', mono: 'var(--font-mono)' },
      borderRadius: { DEFAULT: 'var(--radius)', card: 'var(--radius-card)' },
    },
  },
};
```

## Écarts assumés par rapport à la spécification

| Point | Spécification | Appliqué | Raison |
|---|---|---|---|
| Bordure des champs, boutons secondaires, créneaux | `--color-border-strong` #B9B4A6 | nouveau token `--color-border-control` #8C8778 (sombre #6E7870) ; `border-strong` gardé pour le décoratif | #B9B4A6 ne fait que **2,07:1** sur blanc, sous les **3:1** exigés pour les bordures interactives (WCAG 1.4.11) |
| Vert succès | #2E7D4F | **#2A774B** | #2E7D4F sur `--color-success-subtle` = **4,39:1** (< 4,5:1) ; #2A774B = 4,76:1, visuellement identique |
| Texte en laiton | `--color-accent` | nouveau token `--color-accent-text` #7A5C22 (sombre = accent) ; `--color-accent` reste pour bordures et icônes | #A8823A = 3,55:1 sur blanc : suffisant pour une bordure (3:1), pas pour du texte (4,5:1) |
| Mode sombre des couleurs sémantiques, texte désactivé, accent atténué | non précisés | success #6CC592, warning #E3A94F, danger #F2958C, info #8DB6E3, fonds atténués sombres, disabled #6E756F, accent-subtle #33291A | choisis et vérifiés ci-dessous |
| Motif « bloqué » | hachures légères | hachures `--color-border` + libellé du motif + bordure pointillée | visible dans les deux modes sans dépendre de la couleur |

## Rapport de contraste (WCAG 2.x)

Généré par `node scripts/contrast.mjs --md`. Seuils : 4,5:1 texte, 3:1
bordures d'éléments interactifs et icônes ; ℹ️ = information (élément
décoratif ou désactivé, exempté).

| Usage | Avant-plan / fond | Seuil | Clair | Sombre |
|---|---|---|---|---|
| Texte courant | `--color-text` / `--color-bg` | 4.5:1 | 15.72:1 ✅ | 15.52:1 ✅ |
| Texte sur carte | `--color-text` / `--color-surface` | 4.5:1 | 17.00:1 ✅ | 14.21:1 ✅ |
| Texte secondaire sur carte | `--color-text-muted` / `--color-surface` | 4.5:1 | 6.24:1 ✅ | 6.98:1 ✅ |
| Texte secondaire sur fond | `--color-text-muted` / `--color-bg` | 4.5:1 | 5.77:1 ✅ | 7.62:1 ✅ |
| Texte secondaire sur surface atténuée | `--color-text-muted` / `--color-surface-muted` | 4.5:1 | 5.33:1 ✅ | 6.20:1 ✅ |
| Bouton primaire (texte) | `--color-on-primary` / `--color-primary` | 4.5:1 | 8.07:1 ✅ | 7.06:1 ✅ |
| Bouton primaire survol | `--color-on-primary` / `--color-primary-hover` | 4.5:1 | 10.70:1 ✅ | 8.52:1 ✅ |
| Lien / bouton ghost | `--color-primary` / `--color-surface` | 4.5:1 | 8.07:1 ✅ | 6.61:1 ✅ |
| Ghost au survol | `--color-primary` / `--color-primary-subtle` | 4.5:1 | 6.85:1 ✅ | 5.33:1 ✅ |
| Texte sur fond primaire atténué | `--color-text` / `--color-primary-subtle` | 4.5:1 | 14.43:1 ✅ | 11.46:1 ✅ |
| Créneau sélectionné | `--color-on-primary` / `--color-primary` | 4.5:1 | 8.07:1 ✅ | 7.06:1 ✅ |
| Créneau presque complet | `--color-warning` / `--color-warning-subtle` | 4.5:1 | 5.80:1 ✅ | 7.06:1 ✅ |
| Badge succès / tarif réduit | `--color-success` / `--color-success-subtle` | 4.5:1 | 4.76:1 ✅ | 6.79:1 ✅ |
| Badge attente | `--color-warning` / `--color-warning-subtle` | 4.5:1 | 5.80:1 ✅ | 7.06:1 ✅ |
| Badge annulée / erreur | `--color-danger` / `--color-danger-subtle` | 4.5:1 | 5.58:1 ✅ | 6.95:1 ✅ |
| Badge info / privé | `--color-info` / `--color-info-subtle` | 4.5:1 | 5.88:1 ✅ | 7.10:1 ✅ |
| Texte d’erreur sous champ | `--color-danger` / `--color-surface` | 4.5:1 | 6.54:1 ✅ | 7.52:1 ✅ |
| Bouton destructif plein (modale) | `--color-surface` / `--color-danger` | 4.5:1 | 6.54:1 ✅ | 7.52:1 ✅ |
| Texte sur créneau tarif réduit (badge) | `--color-success` / `--color-surface` | 4.5:1 | 5.47:1 ✅ | 7.99:1 ✅ |
| Texte d’alerte avertissement | `--color-warning` / `--color-surface` | 4.5:1 | 6.39:1 ✅ | 8.00:1 ✅ |
| Libellé membres (texte accent) | `--color-accent-text` / `--color-surface` | 4.5:1 | 6.21:1 ✅ | 7.95:1 ✅ |
| Libellé membres sur accent atténué | `--color-accent-text` / `--color-accent-subtle` | 4.5:1 | 5.33:1 ✅ | 6.78:1 ✅ |
| Bordure champs / contrôles | `--color-border-control` / `--color-surface` | 3:1 | 3.59:1 ✅ | 3.65:1 ✅ |
| Bordure créneau membres (accent) | `--color-accent` / `--color-surface` | 3:1 | 3.55:1 ✅ | 7.95:1 ✅ |
| Anneau « aujourd’hui » (primaire) | `--color-primary` / `--color-surface` | 3:1 | 8.07:1 ✅ | 6.61:1 ✅ |
| Icône succès | `--color-success` / `--color-surface` | 3:1 | 5.47:1 ✅ | 7.99:1 ✅ |
| Bordure décorative forte (non interactive) | `--color-border-strong` / `--color-surface` | — | 2.07:1 ℹ️ | 2.00:1 ℹ️ |
| Texte désactivé (exempté WCAG) | `--color-text-disabled` / `--color-surface-muted` | — | 2.32:1 ℹ️ | 3.13:1 ℹ️ |

## Typographie

- Titres (h1–h3, titres de cartes, de modales, de documents) : **Newsreader**
  500, letter-spacing −0,015em, interligne 1,1. h1 44 px (32 px sur mobile),
  h2 22, h3 18.
- Interface (texte, boutons, libellés, champs, créneaux, tableaux) :
  `"Segoe UI", -apple-system, system-ui, sans-serif`, 15 px ; small 13, caption 12.
- Références, codes : **IBM Plex Mono**.
- Horaires, prix, nombres de joueurs : `font-variant-numeric: tabular-nums`.
- Polices chargées depuis Google Fonts (autorisé dans la politique de
  sécurité du serveur : `fonts.googleapis.com`, `fonts.gstatic.com`).

## Règles d'usage

- **Une seule action primaire par écran** (`.btn.primary`) ; le reste en
  secondaire (`.btn`) ou ghost (`.btn.ghost`). Destructif : `.btn.danger`
  (texte rouge) ; fond rouge (`.btn.danger-solid`) uniquement dans la modale
  de confirmation finale.
- Hauteur minimale des contrôles : 44 px (48 px sur mobile).
- Ombres uniquement sur les éléments flottants (modale, barre récap sticky,
  barre d'onglets mobile, documents).
- États toujours doublés d'un signal non coloré : ✓ sélectionné / confirmé,
  ⏱ en attente, ✕ annulé, heure barrée pour « Complet », hachures + motif pour
  « Bloqué », ★ « Membres », « −20 % » pour le tarif réduit.

## Créneaux

| État | Rendu |
|---|---|
| Disponible | surface, bordure contrôle, « 4 places » ; survol : bordure et fond primaires atténués |
| Presque complet (1–2 places) | fond et bordure avertissement, « Plus que 1 place » |
| Sélectionné | fond primaire, ✓ devant l'heure (un seul à la fois) |
| Complet | fond atténué, heure barrée, « Complet », `aria-disabled`, non cliquable |
| Bloqué | hachures, bordure pointillée, motif (« Compétition ») ; allotements affichés « Réservé » |
| Membres | bordure laiton 1,5 px, « ★ Membres » (créneaux ouverts grâce à l'abonnement) |
| Tarif réduit | pastille succès « −20 % » (green fee inférieur au plus cher du jour) |

Le motif d'un départ bloqué saisi par le golf est **visible des clients** :
éviter d'y écrire des informations internes.
