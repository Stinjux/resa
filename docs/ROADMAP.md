# Feuille de route

Chaque étape livre un logiciel fonctionnel et testé.

| # | Étape | État |
|---|---|---|
| 1 | **Moteur de réservation** : schéma, grille configurable, départs, 4 joueurs max, privé, réunion, caddie unique obligatoire, matériel, concurrence, groupe, audit, API | ✅ livré |
| 2 | **Comptes, rôles, permissions**, sessions, confidentialité des golfeurs par golf, API starter (caddie nommé, matériel numéroté), **tarification** (green fee, privé, caddie, matériel, TVA) et données d'exemple | ✅ livré |
| 3 | **Interface web** : feuille de départs, création téléphone/groupe, modification, annulation, réunion, vue starter, parcours client (première version) | ✅ livré |
| 4 | **Configuration par golf** : horaires, exceptions, fermetures, intervalles, capacités, tarifs, inventaires, effectif caddies | à faire |
| 5 | **Parcours client** : première version livrée à l'étape 3 ; reste paiement en ligne, e-mails de confirmation, annulation par le client | partiel |
| 6 | **Commandes et paiements** : commandes internes à partir des lignes de prix, états dû/payé/remboursé, contrat POS + adaptateur local, file de synchronisation idempotente et journal d'erreurs | à faire |
| 7 | **International et exploitation** : langues (fr/en/ar), devises, taxes, déploiement, sauvegardes, supervision | à faire |

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
