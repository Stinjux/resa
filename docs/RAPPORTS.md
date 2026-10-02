# Rapports modulables et barre de menu

## Barre de menu modulable

Chaque utilisateur choisit les onglets affichés dans la barre du haut et leur
ordre : menu **Plus ▾ → Personnaliser la barre…** (cocher, monter, descendre,
« Par défaut »). Les autres onglets restent dans **Plus ▾**. Le choix est
enregistré sur le compte : il suit l'utilisateur sur tous ses appareils. Par
défaut, les 5 premiers onglets de son rôle sont dans la barre.

## Rapports

Menu **Rapports** (direction, administrateur du groupe).

**Filtres** (une ligne au-dessus des indicateurs) :
- golfs : un, plusieurs ou tous (vue groupe) ;
- période : **Aujourd'hui**, **Cette semaine** (lundi → dimanche), **Ce mois** (mois civil) ou **Personnalisée** (jusqu'à 366 jours) ;
- comparaison : période précédente de même durée, ou même période l'an dernier ;
- **Filtres ▾** : canaux (web, téléphone, WhatsApp, portail partenaire…),
  catégories de client (standard, membre, résident, tour-opérateur…), partenaire.

**Indicateurs** (bouton ⚙ Indicateurs : cocher, ordonner ; choix mémorisé sur le compte) :

| Bloc | Contenu |
|---|---|
| Chiffres clés | joueurs, taux de remplissage, réservations, chiffre d'affaires, encaissé, joueurs par départ, annulations, absences, avec évolution ▲▼ |
| Chiffre d'affaires | par poste (green fees, caddies, matériel…), part clients / partenaires, frais d'annulation |
| Par golf | joueurs, remplissage, chiffre d'affaires de chaque golf |
| Par canal | réservations, joueurs, chiffre d'affaires |
| Par catégorie de client | idem, par catégorie tarifaire |
| Tour-opérateurs et partenaires | joueurs, part partenaire, total |
| Par jour de la semaine / par heure / jour par jour | fréquentation et remplissage |
| Encaissements | par mode, reste à encaisser, à rembourser |
| Caddies et matériel | départs avec caddie, caddies nommés, locations |
| Clientèle | clients distincts, nouveaux, membres |

Périmètre : réservations dont le **départ** est dans la période. Les chiffres
sont calculés par Resa (SQL) ; l'analyse rédigée par l'IA reste disponible
pour un golf à la fois.

**Export** : ⬇ Excel (CSV, un tableau par bloc) et 🖨 PDF (impression du
rapport affiché, sans les filtres).

## Envois automatiques par e-mail

« + Programmer ce rapport » enregistre le rapport affiché (golfs, filtres,
indicateurs) avec :
- fréquence : chaque lundi ou chaque 1er du mois, à 7 h (heure du Maroc) ;
- période couverte : semaine précédente, mois précédent, 7 ou 30 derniers jours, mois en cours ;
- jusqu'à 10 destinataires (direction, comptable…).

L'e-mail contient les tableaux et le détail en pièce jointe Excel. « Envoyer
maintenant » permet de tester. Sans serveur d'e-mails (`SMTP_URL`), l'envoi
est seulement journalisé. À chaque envoi, les droits du créateur sont
revérifiés : si son compte est désactivé ou n'a plus accès à un golf, l'envoi
échoue (statut « échec ») et rien ne part.

## Où est le code

| Fichier | Rôle |
|---|---|
| `modules/analytics/service.ts` | Calcul des blocs, capacité, comparaison, CSV, rendu e-mail |
| `modules/analytics/schedules.ts` | Envois programmés, périodes, échéances |
| `http/routes/analytics.ts` | API rapports et envois ; `routes/users.ts` : préférences |
| `web/src/components/NavBar.tsx` | Barre de menu modulable |
| `web/src/pages/Reports.tsx` | Page Rapports |
| `test/analytics.test.ts` | Blocs, filtres, comparaison, envois, droits, préférences |


## Indicateurs de gestion (définitions)

Chaque bloc affiche « Comment c'est calculé » ; l'export CSV reprend ces définitions.

- **Périmètre** : réservations dont le départ a lieu dans la période. Un départ
  partagé par plusieurs réservations n'est compté qu'une fois (départs, caddies).
- **Taux d'occupation** = joueurs des réservations confirmées (absences incluses)
  ÷ places ouvertes à la vente (grille d'ouverture − départs bloqués ; les
  départs tenus pour un allotement restent ouverts).
- **Départs exclusifs** présentés à part : nombre, joueurs, places neutralisées.
- **Montants** séparés, par devise (jamais additionnés entre devises) :
  réservé, frais d'annulation, encaissé, remboursé, net, solde à recevoir, à rembourser.
  Seuls les paiements **confirmés** comptent.
- **Annulations et absences** : absences rapportées aux départs déjà passés.
- **Matériel** : unités réservées, pic simultané / parc, jours au complet, part des numéros affectés.
- **Caddies** : départs avec caddie, dont nommé ; par caddie, départs et jours travaillés.

**Données non disponibles** : affiché (au lieu d'un faux zéro) avec la raison,
par exemple absences sans pointage, caddies non nommés, golfs de devises
différentes pour un montant global.
