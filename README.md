# Resa — réservation et gestion des départs de golf

Logiciel multi-golfs (4 golfs au Maroc au départ, conçu pour l'international) :
calendrier central des départs, réservations web / téléphone / groupe,
caddies, matériel, et future intégration POS.

## Stack

- **Node.js 22 + TypeScript**, API HTTP **Fastify**, validation **zod**
- **PostgreSQL 16** : verrous de ligne + verrous consultatifs pour empêcher
  toute surréservation, `tstzrange` pour les périodes d'occupation du matériel
- **Luxon** pour les fuseaux horaires IANA par golf
- **Vitest** : tests unitaires (règles pures) et d'intégration (vraie base)

## Démarrer

```bash
npm install
cp apps/api/.env.example apps/api/.env   # adapter DATABASE_URL si besoin
# Base locale : createdb resa_dev && createdb resa_test (utilisateur resa/resa par défaut)
npm run db:migrate
npm run db:seed        # 4 golfs de démonstration (valeurs à remplacer)
npm run dev            # API sur http://127.0.0.1:3000
npm test               # utilise TEST_DATABASE_URL (base effacée à chaque exécution)
```

## Organisation du code (`apps/api/src`)

| Dossier | Rôle |
|---|---|
| `domain/` | Règles métier **pures**, sans base ni HTTP : grille horaire, règles d'un départ (4 joueurs, privé, 9/18), pic d'occupation des ressources |
| `modules/catalog` | Lecture de la configuration par golf (golf, parcours, règles de grille, ressources) |
| `modules/teesheet` | Feuille de départs interne et disponibilités client |
| `modules/booking` | Seule porte d'écriture des réservations : créer, groupe, modifier, déplacer/réunir, annuler (transactions + verrous) |
| `modules/resources` | Capacité, verrouillage, allocation et libération des caddies et du matériel |
| `http/` | Contrôleurs Fastify : validation des entrées, traduction des erreurs métier en HTTP |
| `db/` | Pool, migrations SQL versionnées, données de démonstration |

Les contrôleurs n'appliquent aucune règle : ils valident la forme puis appellent
les services. Le POS (étape 6) sera un adaptateur branché sur des commandes
internes, jamais appelé depuis les règles de réservation.

Voir [`docs/ROADMAP.md`](docs/ROADMAP.md) pour le plan par étapes et
[`docs/DECISIONS.md`](docs/DECISIONS.md) pour les règles métier tranchées ou en attente.

## API (étape 1)

> ⚠️ Pas encore d'authentification (étape 2) : n'exposez pas ce serveur publiquement.
> Il écoute par défaut sur 127.0.0.1.

| Méthode | Chemin | Usage |
|---|---|---|
| GET | `/api/clubs` | Golfs actifs |
| GET | `/api/clubs/:clubId/courses` | Parcours d'un golf |
| GET | `/api/clubs/:clubId/resource-types` | Caddies / matériel configurés |
| GET | `/api/courses/:courseId/availability?date=&players=&holes=` | Créneaux réservables (client) |
| GET | `/api/courses/:courseId/options?startsAt=&holes=` | Matériel disponible pour un créneau |
| GET | `/api/courses/:courseId/tee-sheet?date=` | Feuille de départs complète (personnel) |
| POST | `/api/bookings` | Créer une réservation (en-tête `Idempotency-Key` recommandé) |
| POST | `/api/booking-groups` | Réservation de groupe sur plusieurs départs (tout ou rien) |
| GET | `/api/bookings/:id` | Détail |
| PATCH | `/api/bookings/:id` | Joueurs, 9/18, privé, options, noms, notes |
| POST | `/api/bookings/:id/cancel` | Annuler (libère caddie et matériel) |
| POST | `/api/bookings/:id/move` | Déplacer, ou **réunir** avec une autre réservation (`{ "teeTimeId": … }`) |

Codes d'erreur métier stables : `TEE_TIME_FULL`, `TEE_TIME_PRIVATE`,
`PRIVATE_REQUIRES_EMPTY_TEE_TIME`, `HOLES_MISMATCH`, `CADDIE_UNAVAILABLE`,
`RESOURCE_UNAVAILABLE`, `SLOT_NOT_AVAILABLE`, `OUTSIDE_BOOKING_WINDOW`…
