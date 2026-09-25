# Règles métier

## Tranchées (fournies par le client)

- Un départ accueille **au maximum 4 golfeurs** (plafond absolu ; un golf peut
  configurer moins par plage).
- Intervalle par défaut **6 minutes**, configurable par golf/parcours, période,
  jour de semaine, date précise et plage horaire (`schedule_rules`).
- Réservation en **9 ou 18 trous**.
- Plusieurs réservations peuvent partager un départ ; chacune garde son
  identité (référence, client, options, facturation).
- **Départ privé** (supplément) : les places restantes ne sont plus proposées.
- **Caddie obligatoire pour chaque départ** (1 à 4 joueurs), capacité vérifiée
  avant confirmation, identité attribuable plus tard.
- Caddie : **200 DH (18 trous) / 100 DH (9 trous) par départ**, un seul coût
  même si plusieurs réservations partagent le départ. Stocké en configuration
  (`resource_types.price_9_minor / price_18_minor`), pas dans le code.
- Voiturettes (payantes), chariots, sacs de location (H/F × droitier/gaucher),
  gérés séparément par golf.

## Choix provisoires (modifiables sans refonte)

| Sujet | Choix actuel | Où le changer |
|---|---|---|
| Mélange 9 et 18 trous sur un même départ | Interdit (le prix du caddie dépend de la formule du départ) | `domain/tee-time-rules.ts` |
| Privatiser un départ déjà partagé | Interdit ; seul l'unique occupant peut le privatiser | `domain/tee-time-rules.ts` |
| Durée d'occupation caddie / matériel | Durée de jeu du parcours (270 min en 18 trous, 135 min en 9) + délai par type | `courses.play_minutes_*`, `resource_types.buffer_minutes` |
| Capacité caddies | Nombre configuré par golf, avec exception par date | `resource_types` (CADDIE), `resource_capacity_overrides` |
| Délai minimal / horizon de réservation web | 0 min / 60 jours ; le personnel n'y est pas soumis | `clubs.min_lead_minutes`, `clubs.booking_horizon_days` |
| Fin de plage horaire | Exclue (07:00–17:00 → dernier départ 16:54) | `domain/schedule.ts` |
| Tarifs voiturette, chariot, sacs (démo) | 0 — à saisir | écran de configuration (étape 4) |

## En attente de décision

1. **Répartition du coût du caddie** entre réservations d'un même départ
   (au prorata des joueurs ? à parts égales ? à la première réservation ?).
   Bloque uniquement la facturation définitive (étape 6).
2. Tarifs : green fee (par golf, 9/18, saison, heure, catégorie de client ?),
   supplément départ privé (forfait ou places non vendues ?), voiturette
   (par voiturette ou par joueur ? 1 voiturette pour 2 joueurs ?).
3. Taxes applicables (TVA) et prix affichés TTC ou HT.
4. Paiement en ligne obligatoire, acompte, ou paiement sur place ?
5. Politique d'annulation (délai, frais, remboursement).
6. Départs 9 trous : départ du trou 1 uniquement, ou aussi du 10 (croisements) ?
7. Noms réels des 4 golfs, parcours (18 trous ? 9 trous ?), horaires.
