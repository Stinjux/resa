# Membres, parties ouvertes et application golfeur

## Application golfeur (mobile)

Resa s'utilise sur téléphone comme une application : ouvrir le site, puis
« Ajouter à l'écran d'accueil » (Safari sur iPhone, Chrome sur Android). Pour
un golfeur connecté, une barre d'onglets en bas donne accès à :

| Onglet | Contenu |
|---|---|
| **Réserver** | Disponibilités et réservation ; option « partie ouverte » ; tarif membre affiché |
| **Parties ouvertes** | Départs où des golfeurs cherchent des partenaires : heure, golf, parcours, places libres, joueurs avec leur index, index moyen, message de l'organisateur ; **Rejoindre** en un geste |
| **Mes parties** | À venir (paiement, annulation, reçu/facture, ouvrir ou fermer sa partie) et **historique** avec les partenaires de jeu et leurs index ; nombre de parties sur 12 mois |
| **Profil** | Nom, téléphone, **index**, n° de licence, visibilité pour les autres golfeurs, abonnements en cours |

Démonstration : `client@demo.ma` / `Demo2026!` (membre de G1, index 18.4,
historique de 3 parties, parties ouvertes à rejoindre).

## Parties ouvertes

- À la réservation (ou ensuite dans « Mes parties »), le golfeur coche
  **Partie ouverte**, avec un message facultatif (« tous niveaux »,
  « index < 15 »…).
- Les autres golfeurs connectés voient ce départ tant qu'il reste de la place.
  Rejoindre = une réservation normale sur ce départ : même formule 9/18,
  règles de capacité (4 joueurs max) et de concurrence habituelles, caddie
  partagé entre les réservations.
- Un départ privé ne peut pas être ouvert.
- Sur la feuille de départs, les parties ouvertes portent 🤝 et l'index du
  client s'affiche.

## Confidentialité

Un golfeur n'apparaît aux autres (prénom + initiale et index) **que s'il
l'accepte** dans son profil ; sinon il est affiché « Golfeur ». Téléphone,
e-mail et nom complet ne sont jamais montrés aux autres golfeurs. Les
parties ouvertes ne sont visibles que des golfeurs connectés.

## Membres (abonnés)

1. **Formules** (direction) : Configuration → Membres. Pour chaque formule :
   catégorie tarifaire (ex. `member`), réservation en ligne jusqu'à N jours
   (le public est limité à l'horizon du golf), cotisation (information).
2. **Tarifs** : onglet Tarifs, créer les tarifs de la catégorie (0 si le green
   fee est inclus dans l'abonnement ; le caddie reste payant).
3. **Inscription** (réception) : menu **Membres** → nouveau membre (ou golfeur
   existant), formule, n° de carte, période de validité, index. Renouveler,
   suspendre, réactiver ; nombre de parties jouées sur la période.

Pendant la validité de son abonnement, un membre qui réserve (en ligne ou à la
réception) obtient automatiquement le tarif de sa formule et peut réserver
plus tôt que le public. Abonnement échu ou suspendu : tarif public.

Pour que le membre utilise l'application, il crée son compte avec l'adresse
e-mail enregistrée à la réception… ou la réception le retrouve lors d'une
réservation.

## Pistes suivantes

- Saisie des scores et calcul d'index ; statistiques de jeu.
- Notification à l'organisateur quand quelqu'un rejoint sa partie.
- Liste d'attente sur les départs complets.
- Échéances et relances de cotisation.

## Où est le code

| Fichier | Rôle |
|---|---|
| `db/migrations/014_members_open_games.sql` | Profil golfeur, formules, abonnements, parties ouvertes |
| `modules/members/membership.ts` | Abonnement actif (tarif et horizon de réservation) |
| `modules/members/service.ts` | Profil, parties ouvertes, historique, administration des membres |
| `http/routes/members.ts` | API golfeur et personnel |
| `web/src/pages/OpenGames.tsx`, `MyBookings.tsx`, `Profile.tsx`, `Members.tsx` | Écrans |
| `test/members.test.ts` | Tarif et horizon membre, parties ouvertes, confidentialité, droits |
