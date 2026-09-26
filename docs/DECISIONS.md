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
- Caddie : **200 DH (18 trous) / 100 DH (9 trous) par départ, quel que soit
  le nombre de réservations** (décision du 26/09/2026). Le montant est réparti
  entre les réservations du départ, **au prorata des joueurs** par défaut
  (2+2 → 100 + 100 ; 3+1 → 150 + 50), recalculé à chaque réunion,
  déplacement, modification ou annulation. Répartition configurable par golf
  (`clubs.caddie_fee_split` : prorata, parts égales, première réservation).
  Chaque réservation choisit de payer sa part **sur place** ou **avec la
  réservation**. Montants en configuration (`resource_types.price_*_minor`).
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
| Répartition du caddie partagé | Au prorata des joueurs, en dirhams entiers (1+1+1 → 67 + 67 + 66) | `clubs.caddie_fee_split` |
| Réunion / déplacement | Prix recalculés à l'heure du nouveau départ, pour toutes les réservations des deux départs | `modules/pricing` |
| Politique d'annulation | Gratuite jusqu'à 24 h avant le départ, 0 % de frais ensuite ; le personnel peut renoncer aux frais | `clubs.cancellation_free_hours`, `cancellation_fee_percent` |
| Annulation par le client | En ligne, uniquement dans le délai gratuit ; sinon il contacte le golf | `clubs.customer_can_cancel` |
| Paiement en ligne | Désactivé (règlement au golf) en attendant le choix d'un prestataire | `clubs.online_payment` |
| Encaissement au golf | Saisi par la réception (espèces, TPE, virement), confirmé par cette saisie ; plafonné au reste dû | `modules/orders` |
| Caisse (POS) | Aucune par défaut ; G1 de démonstration sur l'adaptateur `local` | `clubs.pos_provider`, `docs/POS.md` |
| Golfeur déjà client d'un autre golf du groupe | Invisible pour la réception : une nouvelle fiche est créée | `modules/customers` |

## En attente de décision

1. Répartition du caddie partagé : le prorata des joueurs convient-il ?
2. Tarifs réels par golf ; supplément départ privé (forfait ou places non vendues ?) ;
   voiturette par véhicule ou par joueur.
3. Taux de TVA réellement applicables et affichage TTC.
4. Paiement en ligne : obligatoire, proposé ou non ? Quel prestataire (CMI…) ?
5. Politique d'annulation réelle (délai, % de frais).
8. Fournisseur de caisse (POS) : voir la liste des questions dans `docs/POS.md`.
6. Départs 9 trous : départ du trou 1 uniquement, ou aussi du 10 (croisements) ?
7. Noms réels des 4 golfs, parcours (18 trous ? 9 trous ?), horaires.
