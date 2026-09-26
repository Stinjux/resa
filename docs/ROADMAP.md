# Feuille de route

Chaque étape livre un logiciel fonctionnel et testé.

| # | Étape | État |
|---|---|---|
| 1 | **Moteur de réservation** : schéma, grille configurable, départs, 4 joueurs max, privé, réunion, caddie unique obligatoire, matériel, concurrence, groupe, audit, API | ✅ livré |
| 2 | **Comptes, rôles, permissions**, sessions, confidentialité des golfeurs par golf, API starter (caddie nommé, matériel numéroté), **tarification** (green fee, privé, caddie, matériel, TVA) et données d'exemple | ✅ livré |
| 3 | **Interface web** : feuille de départs, création téléphone/groupe, modification, annulation, réunion, vue starter, parcours client (première version) | ✅ livré |
| 4 | **Configuration par golf** : paramètres (fuseau, devise, TVA, fenêtre de réservation, caddie), parcours, horaires/exceptions/fermetures avec aperçu de grille, tarifs, stocks et exceptions par jour, caddies, matériel numéroté | ✅ livré |
| 5 | **Parcours client** : réservation, compte client, « Mes réservations », annulation en ligne dans le délai gratuit ; restent le paiement en ligne et les e-mails de confirmation | partiel |
| 6 | **Commandes et paiements** : commande par réservation, encaissements et remboursements, statut de paiement calculé, frais d'annulation configurables, annulation par le client, contrat POS + adaptateur local, file de synchronisation idempotente avec reprises et journal (voir `docs/POS.md`) | ✅ livré |
| 7 | **International et exploitation** : interface client en français, anglais et arabe (droite à gauche), devise/TVA/fuseau/langue par golf, création de golfs, en-têtes de sécurité, limitation des tentatives, image de production, HTTPS automatique, sauvegardes, outil de mise en service (voir `docs/DEPLOIEMENT.md`) | ✅ livré |

## Garanties déjà en place (étape 1)

- **Surréservation impossible**, y compris en simultané : le départ est verrouillé
  (`SELECT … FOR UPDATE`) ; caddies et matériel sont verrouillés par type
  (`pg_advisory_xact_lock`) ; les règles sont vérifiées sur l'état relu sous verrou.
- **Un seul caddie par départ**, garanti aussi par un index unique en base.
- **Disponibilité du matériel sur la période réelle d'utilisation**
  (départ → départ + durée de jeu 9/18 du parcours + délai de remise en état),
  en comparant le **pic d'utilisation simultanée** à la capacité du jour.
- **Tout ou rien** : une réservation (ou un groupe) refusée ne laisse ni départ
  occupé, ni caddie, ni matériel alloué.
- **Idempotence** des créations (`Idempotency-Key`) : un double clic ou une
  reprise réseau ne crée pas de doublon.
- **Historique** (`audit_log`) des créations, modifications, déplacements et
  annulations, sans données personnelles en clair.

## Suites possibles

- Paiement en ligne (prestataire à choisir, ex. CMI) et e-mails / SMS de confirmation.
- Écran de gestion des comptes du personnel.
- Traduction des écrans du personnel et des libellés saisis par les golfs (tarifs, matériel).
- Connecteur du fournisseur de caisse choisi (`docs/POS.md`).
- Statistiques (taux de remplissage, chiffre d'affaires par golf).
