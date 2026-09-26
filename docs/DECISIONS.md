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
- Caddie : **200 DH (18 trous) / 100 DH (9 trous) facturés à chaque
  réservation** (décision du 26/09/2026), payables **sur place** ou **avec la
  réservation** au choix. Un seul caddie physique par départ. Montants en
  configuration (`resource_types.price_9_minor / price_18_minor`), mode de
  paiement par défaut par golf (`clubs.default_caddie_payment`).
- **Réception** : ne voit que son golf et les golfeurs ayant réservé dans son golf.
- **Starter** : départs du jour et des 6 jours suivants ; attribue le caddie
  nommé et le matériel numéroté ; ne voit pas les coordonnées des golfeurs.
- Ordre de grandeur des tarifs : **~1 300 MAD le green fee 18 trous**.
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
| Tarifs de démo | GF 18 t. 1 200–1 350 MAD (week-end +150, twilight après 15 h −30 %), GF 9 t. ≈ 58 % du 18 t., résident 900/550, privé 1 000 MAD par réservation, voiturette 400/250, chariot 50/30, sac 300/200 | table `tariffs`, `resource_types` |
| TVA de démo | 20 %, prix TTC | `clubs.tax_rate_bp`, `clubs.prices_include_tax` |
| Conflit entre tarifs | La règle la plus **prioritaire** gagne (puis la plus spécifique), pas la moins chère | `tariffs.priority` |
| Catégorie tarifaire (résident…) | Choisie par le personnel ; le client en ligne paie le tarif standard | `bookings.customer_category` |
| Réunion de deux réservations | Chaque réservation paie son caddie ; le prix est recalculé à l'heure du nouveau départ | `modules/pricing` |
| Golfeur déjà client d'un autre golf du groupe | Invisible pour la réception : une nouvelle fiche est créée | `modules/customers` |

## En attente de décision

1. Confirmer : deux réservations réunies sur un départ paient **chacune** 200 DH
   de caddie (400 DH encaissés pour un caddie) ?
2. Tarifs réels par golf ; supplément départ privé (forfait ou places non vendues ?) ;
   voiturette par véhicule ou par joueur.
3. Taux de TVA réellement applicables et affichage TTC.
4. Paiement en ligne obligatoire, acompte, ou paiement sur place ?
5. Politique d'annulation (délai, frais, remboursement).
6. Départs 9 trous : départ du trou 1 uniquement, ou aussi du 10 (croisements) ?
7. Noms réels des 4 golfs, parcours (18 trous ? 9 trous ?), horaires.
