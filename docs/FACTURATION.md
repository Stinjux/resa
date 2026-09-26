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

## Avoir

Une facture ne se modifie ni ne se supprime : on l'annule par un **avoir**
(direction uniquement, motif obligatoire), numéroté `AV-G1-2026-00001`, du
même montant en négatif. On peut ensuite émettre une nouvelle facture.

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
| Émettre une facture | ✅ | ✅ | — (consulter les siennes) |
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
