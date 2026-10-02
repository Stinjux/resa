# Disponibilité des ressources et historique des modifications

## Ressources (menu **Ressources**)

Par golf : voiturettes, chariots, sacs de location (homme droitier, homme
gaucher, femme droitière, femme gauchère) et caddies.

| Qui | Peut |
|---|---|
| Tout le personnel | consulter les disponibilités du jour et les conflits |
| Accueil (réception) | réserver des **quantités** depuis la réservation (panneau latéral de la feuille de départs, boutons − / +) |
| Starter | **affecter** un caddie nommé et les numéros de matériel (voiturette n° 12…) |
| Direction / administrateur | déclarer une **maintenance** (matériel) ou une **absence** (caddie), avec dates et motif ; remettre en service |

**Quantité réservée ≠ affectation précise** : la réservation tient « 1 voiturette »
(capacité bloquée) ; le starter choisit ensuite « V-12 ». Le caddie est réservé en
nombre à la réservation, puis nommé par le starter.

**Statuts** (toujours écrits en toutes lettres) :
- **Disponible** : ni affecté, ni indisponible ;
- **Réservé** : affecté à un départ à venir de la journée ;
- **En utilisation** : affecté à un départ en cours (maintenant dans sa période d'utilisation) ;
- **Indisponible** : maintenance, absence ou unité retirée du service.

### Règles de disponibilité

- La période d'utilisation couvre **toute la partie** : durée 9 / 18 trous du
  parcours (Configuration › Parcours) + temps de préparation du type de
  ressource (Configuration › Matériel, « Remise en état après usage »).
- Contrôle sous verrou (verrou par type de ressource, puis par unité / caddie) :
  deux employés qui réservent la dernière voiturette en même temps → une seule
  réservation passe, l'autre reçoit « Voiturette : 0 disponible(s) ».
- Une modification (joueurs, formule, matériel) ou un déplacement recalcule les
  allocations ; les numéros déjà affectés sont **conservés s'ils restent libres**,
  sinon signalés « à réattribuer ». Une annulation libère tout.
- **Un caddie par départ**, quel que soit le nombre de joueurs ; plusieurs
  réservations sur le même départ partagent ce caddie (garanti en base).
- Une maintenance ou une absence **réduit la capacité** sur sa période et
  interdit l'affectation nominative. Si l'unité / le caddie était déjà affecté,
  les réservations concernées sont listées immédiatement (et dans l'encadré
  « affectations à revoir ») avec le choix d'un remplaçant libre. Si la capacité
  devient insuffisante, un avertissement indique le nombre de réservations en trop.
- Au moment du choix, chaque unité / caddie affiche son état : « Libre »,
  « Déjà prise 08 h 04–12 h 49 (G1-000001) », « En maintenance jusqu'au … : motif ».

L'ancien état « maintenance » sans dates des unités a été repris en
maintenance ouverte (« jusqu'à nouvel ordre ») ; Configuration › Matériel ne
propose plus que « En service » / « Retiré définitivement ».

## Historique

Enregistré **par le serveur, dans la même transaction que l'opération** :
pas d'opération sans trace. La table est protégée par un déclencheur en base
(aucune modification ni suppression possible, même en SQL direct).

Événements tracés : création, modification (joueurs, formule, départ privé,
matériel, tarif, paiement du caddie, prix), déplacement (date, heure, parcours),
combinaison / séparation sur un départ, annulation (motif, frais), prix recalculé
par le partage du caddie, encaissements et remboursements (motif), arrivée /
absence, départ parti, affectation ou changement de caddie et de numéros de
matériel, maintenances et absences, blocage de départs, factures, clôtures.

Chaque événement : date et heure, auteur (ou « Système »), action, élément
concerné, **ancienne et nouvelle valeur** des champs modifiés, motif. Le contenu
des notes et les noms des joueurs ne sont pas copiés (seulement « notes
modifiées ») ; aucune donnée bancaire.

- Bouton **🕘 Historique** dans chaque réservation (inclut le caddie et le
  matériel du départ, et les réservations réunies).
- Menu **Historique** (direction) : filtres par golf, dates, utilisateur, type
  d'action (réservations, paiements, caddies et matériel, accueil et départs,
  configuration, comptes) et référence de réservation.

Exemple : « Sarah a déplacé le départ de G1-000123 de 10 h à 10 h 12 ».

## Limites connues

- Pas de fonction de **remise manuelle** dans l'application : les changements de
  prix tracés viennent des changements de tarif, de joueurs, de matériel ou du
  partage du caddie.
- La **sortie effective** du matériel et la **présence** des caddies ne sont pas
  pointées : « en utilisation » se déduit de l'heure du départ, et les jours
  travaillés d'un caddie sont les jours avec au moins un départ affecté.
- Les événements antérieurs à cette version gardent leur forme d'origine
  (phrase plus courte, sans ancienne valeur).
