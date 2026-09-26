# Reçus, factures, avoirs et clôture de caisse

## Reçu

Justificatif des règlements d'une réservation (lignes, paiements, reste dû).
Il **ne vaut pas facture** et n'est pas numéroté. Disponible pour le personnel
(panneau de la réservation → Documents → Reçu) et pour le client (Mes
réservations).

## Facture

Panneau de la réservation → **Facturer** (réception ou direction). On peut
indiquer une raison sociale, une adresse et l'**ICE du client** (obligatoire
quand le client est une entreprise).

- **Mentions du vendeur** (Configuration → Général) : raison sociale, adresse,
  **ICE**, IF, RC, patente, pied de facture (capital, RIB…). Sans raison sociale,
  adresse et ICE (golfs au Maroc), l'émission est refusée.
- **Numérotation continue, sans trou**, par golf et par année :
  `FA-G1-2026-00001`. Le numéro est attribué dans la même transaction que la
  facture : une émission qui échoue ne consomme pas de numéro.
- Contenu : lignes avec quantité, prix unitaire HT, taux de TVA, total HT ;
  total HT, TVA par taux, total TTC, montant déjà réglé, « Arrêtée la présente
  facture à la somme de… ».
- **Une facture est figée** : vendeur, client, lignes et montants sont copiés à
  l'émission. Si la réservation change ensuite, la facture ne bouge pas.
- Une seule facture active par réservation.
- Impression ou PDF : bouton **Imprimer / PDF** (« Enregistrer au format PDF »
  dans la fenêtre d'impression).

## Facturation client et facturation partenaire

Deux circuits séparés, chacun avec sa **propre numérotation continue** :

| | Facture client | Facture partenaire |
|---|---|---|
| Série | `FA-G1-2026-00001` | `FP-G1-2026-00001` |
| Contenu | une réservation, la **part du client** | une ou plusieurs réservations d'un partenaire (ex. tout le mois), la **part du partenaire** |
| Qui l'émet | réception ou direction (panneau de la réservation) | direction : panneau de la réservation (« Facturer le partenaire ») ou **Caisse → Facturation → Tour-opérateurs** (groupée) |
| Échéance | — | date + délai de paiement du partenaire |

**Qui paie quoi** se règle par partenaire (Configuration → Partenaires →
« Facturé au partenaire ») :

- **Green fees** (par défaut) : le partenaire paie green fees, supplément
  privé, frais d'annulation/d'absence ; le client règle caddie et matériel au golf ;
- **Tout** : le partenaire paie tout ;
- **Rien** : le client paie tout, au tarif négocié du partenaire.

Un changement de réglage s'applique aux réservations pas encore facturées au
partenaire.

Sur chaque réservation, le panneau de règlement montre le reste dû **par
part** (client au comptoir / partenaire sur facture). Au comptoir,
« Encaisser » propose la part du client ; on peut aussi indiquer qu'un
paiement vient du partenaire.

**Facture partenaire groupée** : Caisse → Facturation → Tour-opérateurs →
choisir le partenaire et la période des départs → les réservations pas encore
facturées s'affichent (à décocher pour les facturer plus tard ou à part) →
Émettre. Une réservation ne peut pas être facturée deux fois au partenaire.

**Règlement d'une facture partenaire** (virement, chèque…) : journal des
factures partenaires → « Règlement ». Le montant est réparti automatiquement
sur les réservations de la facture ; il apparaît dans la caisse (clôture Z)
et le relevé du partenaire. Règlements partiels possibles.

Le journal et l'export comptable sont séparés : clients d'un côté,
partenaires de l'autre (colonne « Facturé à » dans le CSV).

## Avoir

Une facture (client ou partenaire) ne se modifie ni ne se supprime : on l'annule par un **avoir**
(direction uniquement, motif obligatoire), numéroté `AV-G1-2026-00001`, du
même montant en négatif. Les réservations concernées redeviennent facturables : on peut réémettre, par exemple regroupées autrement.

## Clôture de caisse (ticket Z)

Menu **Caisse** (réception, direction) :

1. La caisse en cours regroupe tous les encaissements et remboursements
   **confirmés** depuis la dernière clôture, par mode de paiement.
2. Saisir le fond de caisse et les **espèces comptées** : l'écart avec les
   espèces attendues (fond + espèces encaissées − espèces remboursées)
   s'affiche.
3. **Clôturer la caisse (Z)** : ticket numéroté `Z-G1-2026-00001`, avec le
   détail des opérations et les emplacements de signature. Les opérations
   clôturées ne peuvent plus être reprises dans une autre clôture.

Une opération enregistrée pendant la clôture passe simplement dans la
suivante. Deux clôtures simultanées du même golf sont impossibles.

## Comptabilité

Menu **Caisse** → Journal des factures et avoirs (direction) : liste par
période avec totaux HT / TVA / TTC et **export Excel (CSV)** pour le comptable.

## Droits

| Action | Réception | Direction / administrateur | Client |
|---|---|---|---|
| Reçu | ✅ | ✅ | ses réservations |
| Facture client | ✅ | ✅ | — (consulter les siennes) |
| Facture partenaire, règlement de facture partenaire | — | ✅ | — |
| Émettre un avoir | — | ✅ | — |
| Clôturer la caisse, voir les clôtures | ✅ | ✅ | — |
| Journal et export comptable | — | ✅ | — |

## À valider avec votre comptable

- Format de numérotation (préfixes, remise à zéro annuelle).
- Mentions complémentaires éventuelles (capital social, conditions de
  paiement, pénalités de retard pour les factures d'entreprise).
- Besoin d'un export au format de votre logiciel comptable.

## Où est le code

| Fichier | Rôle |
|---|---|
| `db/migrations/010_invoices_cash.sql` | Mentions légales, compteurs, factures, clôtures |
| `modules/billing/service.ts` | Numérotation, factures, avoirs, reçu, caisse, export |
| `http/routes/billing.ts` | API et droits |
| `web/src/pages/Documents.tsx` | Documents imprimables |
| `web/src/pages/Cash.tsx` | Écran Caisse |
| `test/billing.test.ts` | Numérotation (y compris en parallèle), figement, avoirs, clôture, droits |
