# Resa — réservation et gestion des départs de golf

Logiciel multi-golfs (4 golfs au Maroc au départ, conçu pour l'international) :
calendrier central des départs, réservations web / téléphone / groupe,
caddies, matériel, et future intégration POS.

## Lancer en local

### Option A — avec Docker (recommandé, rien d'autre à installer)

1. Installez **Docker Desktop** (Windows / Mac) : https://www.docker.com/products/docker-desktop/ et lancez-le.
2. Téléchargez le projet :
   - avec Git : `git clone https://github.com/Stinjux/resa.git`
   - ou sur GitHub : bouton vert **Code → Download ZIP**, puis décompressez.
3. Ouvrez un terminal dans le dossier `resa` et lancez :
   ```bash
   docker compose up --build
   ```
4. Quand le message `⛳ Resa Golf prêt` s'affiche, ouvrez **http://localhost:3000**.

La base est créée et les données de démonstration sont chargées automatiquement.
Arrêt : `Ctrl+C` (les données sont conservées). Tout effacer : `docker compose down -v`.

### Option B — sans Docker

Prérequis : **Node.js 22** (https://nodejs.org) et **PostgreSQL 16** (https://www.postgresql.org/download/).

```bash
# 1. Créer l'utilisateur et la base (dans psql, en tant que « postgres »)
CREATE ROLE resa LOGIN PASSWORD 'resa' CREATEDB;
CREATE DATABASE resa_dev OWNER resa;

# 2. Dans le dossier du projet
npm install
cp apps/api/.env.example apps/api/.env     # Windows : copy apps\api\.env.example apps\api\.env
npm start                                  # compile, crée les tables, charge la démo
```

Puis ouvrez **http://localhost:3000**.

### Activer l'IA (facultatif)

Créez un fichier `.env` à la racine avec `ANTHROPIC_API_KEY=sk-ant-...` puis relancez
`docker compose up`. Voir [`docs/IA.md`](docs/IA.md).

### Mettre en ligne

Voir [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md) : un serveur, un nom de domaine,
`docker compose -f docker-compose.prod.yml up -d`, HTTPS et sauvegardes automatiques.

### Comptes de démonstration

Sur la page **Connexion**, un clic sur un compte suffit (mot de passe `Demo2026!`) :
réception, starter, direction, administrateur, client.

## Stack

- **Node.js 22 + TypeScript**, API HTTP **Fastify**, validation **zod**, interface **React + Vite**
- **PostgreSQL 16** : verrous de ligne + verrous consultatifs pour empêcher
  toute surréservation, `tstzrange` pour les périodes d'occupation du matériel
- **Luxon** pour les fuseaux horaires IANA par golf
- **Vitest** : tests unitaires (règles pures) et d'intégration (vraie base)

## Développement

```bash
npm run db:reset       # (dév. uniquement) efface la base, migre et recharge la démo
npm run dev            # API avec rechargement auto sur :3000
npm run dev:web        # interface avec rechargement auto sur :5173
npm test               # tests (base resa_test, effacée à chaque exécution)
npm run typecheck
```

## Interface web (`apps/web`, React + Vite)

Servie par le serveur de l'API une fois compilée (`npm start`) :

- **Réserver** (public / client) : golf → date → 9/18 trous → joueurs → départ → options → coordonnées → récapitulatif → confirmation
- **Feuille de départs** (réception, direction) : journée par parcours, places, privé, caddie ;
  création téléphonique, groupe réparti sur des départs consécutifs, modification, réunion/déplacement, annulation, historique
- **Starter** : aujourd'hui / demain / semaine, caddie nommé et matériel numéroté, montant à encaisser sur place
- **Mes réservations** (client) : statut de paiement, annulation en ligne dans le délai gratuit
- **Assistant IA** (personnel) : réserver en langage naturel (« book moi 2 départs à 13h le 25 mars »),
  l'IA demande ce qui manque puis prépare un brouillon que l'employé confirme ; questions directes
- **Rapports** (direction) : chiffres de la période + analyse rédigée par l'IA
- **Demandes WhatsApp / SMS** : l'IA échange avec le client, puis **chaque demande est validée par la
  réception ou la direction** avant réservation ; confirmation envoyée au client (voir `docs/MESSAGERIE.md`)
- **E-mails aux clients** : confirmation, modification, annulation et rappel, dans la langue du client ;
  consultables dans Configuration → E-mails (voir `docs/EMAILS.md`)
- Interface client en **français, anglais et arabe** (sélecteur de langue en haut à droite)
- **Configuration** (direction, administrateur) : paramètres du golf, parcours, horaires,
  exceptions et fermetures avec aperçu de la grille, tarifs, stocks et exceptions par jour,
  caddies et matériel numéroté. Chaque modification est historisée.

Les boutons de comptes de démonstration de la page de connexion se masquent
en compilant avec `VITE_DEMO=false`.

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
| `modules/orders` | Commandes, encaissements, remboursements, statut de paiement |
| `modules/pos-sync` · `integrations/pos` | File de synchronisation caisse et contrat des connecteurs (voir `docs/POS.md`) |
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
| GET | `/api/bookings/:id/order` | propriétaire / personnel | Commande, paiements, solde |
| POST | `/api/bookings/:id/payments` · `/refunds` | réception | Encaissement / remboursement constaté au golf |
| GET | `/api/bookings/:id/cancellation-preview` | propriétaire / personnel | Frais d'annulation applicables |
| POST | `/api/me/bookings/:id/cancel` | client | Annulation en ligne (délai gratuit) |
| GET · POST | `/api/clubs/:clubId/pos/jobs` · `/pos/jobs/:id/retry` · `/pos/process` | direction | Supervision de la synchronisation caisse |
| GET · PATCH | `/api/clubs/:clubId/config` | direction | Configuration complète / paramètres du golf |
| POST · PATCH | `/api/clubs/:clubId/config/:entity[/:id]` | direction | `courses`, `schedule-rules`, `tariffs`, `resource-types`, `caddies`, `resource-units` |
| PUT | `/api/clubs/:clubId/config/resource-types/:id/overrides/:date` | direction | Stock différent un jour donné |
| GET | `/api/clubs/:clubId/config/grid-preview?courseId=&date=` | direction | Aperçu des départs d'un jour |

Codes d'erreur métier stables : `TEE_TIME_FULL`, `TEE_TIME_PRIVATE`,
`PRIVATE_REQUIRES_EMPTY_TEE_TIME`, `HOLES_MISMATCH`, `CADDIE_UNAVAILABLE`,
`RESOURCE_UNAVAILABLE`, `CADDIE_ALREADY_ASSIGNED`, `UNIT_UNAVAILABLE`,
`PRICE_NOT_CONFIGURED`, `FORBIDDEN`, `UNAUTHENTICATED`…
