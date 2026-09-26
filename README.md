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
npm run db:reset       # (dév. uniquement) efface la base, migre et recharge la démo
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
| `modules/pricing` | Devis et lignes de prix figées par réservation (green fee, privé, caddie, matériel, TVA) |
| `modules/auth` | Comptes, sessions, rôles et permissions par golf |
| `modules/starter` | Vue starter, attribution nominative du caddie et du matériel |
| `modules/customers` | Golfeurs visibles par le personnel d'un golf |
| `modules/resources` | Capacité, verrouillage, allocation et libération des caddies et du matériel |
| `http/` | Contrôleurs Fastify : validation des entrées, traduction des erreurs métier en HTTP |
| `db/` | Pool, migrations SQL versionnées, données de démonstration |

Les contrôleurs n'appliquent aucune règle : ils valident la forme puis appellent
les services. Le POS (étape 6) sera un adaptateur branché sur des commandes
internes, jamais appelé depuis les règles de réservation.

Voir [`docs/ROADMAP.md`](docs/ROADMAP.md) pour le plan par étapes et
[`docs/DECISIONS.md`](docs/DECISIONS.md) pour les règles métier tranchées ou en attente.

## Données de démonstration

4 golfs fictifs (G1 Marrakech, G2 Casablanca, G3 Rabat, G4 Agadir), tarifs
autour de 1 300 MAD le 18 trous, 12 caddies, voiturettes, chariots et sacs
numérotés par golf, et des réservations d'exemple sur G1 (réunion de deux
réservations, départ privé, groupe, tarif résident, 9 trous).

Comptes (mot de passe `Demo2026!`, **démo uniquement**) :

| Compte | Rôle |
|---|---|
| `admin@demo.ma` | Administrateur des 4 golfs |
| `direction.g1@demo.ma` … `g4` | Direction d'un golf (tous les droits sur ce golf) |
| `reception.g1@demo.ma` … `g4` | Réception : départs, réservations et golfeurs de son golf |
| `starter.g1@demo.ma` … `g4` | Starter : départs du jour et de la semaine, caddies et matériel |
| `client@demo.ma` | Client |

## Rôles

| Permission | Client | Starter | Réception | Direction / Admin |
|---|:-:|:-:|:-:|:-:|
| Disponibilités, devis, réservation en ligne | ✔ | | | |
| Feuille de départs | | jour + 6 jours | ✔ | ✔ |
| Créer (téléphone, groupe), modifier, réunir, annuler | | | ✔ | ✔ |
| Coordonnées des golfeurs (de son golf uniquement) | | | ✔ | ✔ |
| Attribuer caddie nommé et matériel numéroté | | ✔ | | ✔ |
| Historique du golf, configuration | | | | ✔ |

Authentification : `POST /api/auth/login` renvoie un jeton à passer dans
`Authorization: Bearer <jeton>` (session de 12 h, seule l'empreinte du jeton
est stockée, mots de passe hachés avec scrypt).

## API

> Écoute par défaut sur 127.0.0.1. Avant une mise en ligne : HTTPS, limitation
> du nombre de tentatives de connexion et en-têtes de sécurité (étape 7).

| Méthode | Chemin | Accès | Usage |
|---|---|---|---|
| POST | `/api/auth/login` · `/logout` · `/register` | public | Session, création de compte client |
| GET | `/api/me` · `/api/me/bookings` | connecté | Profil, réservations du client |
| GET | `/api/clubs` · `/api/clubs/:clubId/courses` · `/resource-types` | public | Catalogue |
| GET | `/api/courses/:courseId/availability?date=&players=&holes=` | public | Créneaux réservables |
| GET | `/api/courses/:courseId/options?startsAt=&holes=` | public | Matériel disponible |
| POST | `/api/quote` | public | Devis détaillé |
| GET | `/api/courses/:courseId/tee-sheet?date=` | personnel | Feuille de départs |
| POST | `/api/bookings` | public / réception | Réservation (web pour client/visiteur, `channel` pour le personnel) |
| POST | `/api/booking-groups` | réception | Groupe sur plusieurs départs, tout ou rien |
| GET | `/api/bookings/:id` · `/history` | propriétaire / personnel | Détail, historique |
| PATCH | `/api/bookings/:id` | réception | Joueurs, 9/18, privé, options, catégorie, paiement caddie |
| POST | `/api/bookings/:id/cancel` | réception | Annuler (libère caddie et matériel) |
| POST | `/api/bookings/:id/move` | réception | Déplacer, ou **réunir** (`{ "teeTimeId": … }`) |
| GET | `/api/clubs/:clubId/customers?q=` · `/customers/:id` | réception | Golfeurs du golf |
| GET | `/api/clubs/:clubId/starter?date=&days=` | starter | Départs du jour / de la semaine |
| GET | `/api/clubs/:clubId/caddies` · `/resource-units` | starter | Caddies et matériel numéroté |
| PUT | `/api/tee-times/:id/caddie` | starter | Nommer le caddie d'un départ |
| PUT | `/api/allocations/:id/units` | starter | Attribuer voiturette / sac n° |
| GET | `/api/clubs/:clubId/audit` | direction | Historique du golf |

Codes d'erreur métier stables : `TEE_TIME_FULL`, `TEE_TIME_PRIVATE`,
`PRIVATE_REQUIRES_EMPTY_TEE_TIME`, `HOLES_MISMATCH`, `CADDIE_UNAVAILABLE`,
`RESOURCE_UNAVAILABLE`, `CADDIE_ALREADY_ASSIGNED`, `UNIT_UNAVAILABLE`,
`PRICE_NOT_CONFIGURED`, `FORBIDDEN`, `UNAUTHENTICATED`…
