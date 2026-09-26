# Intégration d'une caisse (POS)

Aucun fournisseur n'est encore choisi. Resa est prêt à s'y brancher **sans
modifier les règles de réservation ni la tarification** : il suffit d'écrire un
connecteur qui respecte le contrat décrit ici.

> Aucun endpoint de fournisseur n'est supposé ni simulé. Le seul connecteur
> fourni, `local`, n'appelle aucun système externe : il sert à faire tourner et
> à tester toute la chaîne (file, reprises, correspondances d'identifiants).

## Vue d'ensemble

```
Réservation ──► Lignes de prix ──► Commande (orders / order_lines) ──► File POS (pos_sync_jobs) ──► Connecteur ──► API du fournisseur
                                     ▲                                   │
       Encaissements / remboursements ┘                                   └─► external_refs (correspondance d'identifiants)
                                                                              pos_sync_log (journal de chaque tentative)
```

| Élément | Fichier | Rôle |
|---|---|---|
| Contrat | `apps/api/src/integrations/pos/contract.ts` | Objets envoyés (`PosSale`, `PosLine`, `PosPayment`, `PosRefund`), interface `PosConnector`, `PosError` |
| Connecteur local | `apps/api/src/integrations/pos/local.ts` | Implémentation de démonstration, sans appel externe |
| Registre | `apps/api/src/integrations/pos/registry.ts` | **Point de branchement** du futur connecteur |
| Commandes | `apps/api/src/modules/orders/service.ts` | Commande par réservation, paiements, remboursements, statut de paiement |
| File | `apps/api/src/modules/pos-sync/` | Mise en file transactionnelle, traitement, reprises, journal |

## Ce que Resa garantit déjà

- **Identifiants internes stables** : réservation, départ, client, commande,
  paiement, remboursement ont chacun un UUID permanent. La référence lisible
  (`G1-000042`) est commune à la réservation et à la commande.
- **Correspondance** : `external_refs` associe chaque entité interne à son
  identifiant chez le fournisseur, **par golf** (deux golfs peuvent avoir deux
  comptes chez le même fournisseur).
- **États distincts** : réservation (`confirmed` / `cancelled`), commande
  (`open` / `cancelled`, total dû), paiements (`pending` / `confirmed` /
  `failed` / `cancelled`), remboursements (idem). Le « payé » est **calculé**
  (paiements confirmés − remboursements confirmés) ; un paiement `pending` ne
  compte jamais.
- **Outbox transactionnelle** : un travail de synchronisation est écrit dans la
  même transaction que le changement métier. Rien n'est perdu en cas de panne,
  rien n'est envoyé si la transaction échoue.
- **Idempotence** : chaque travail a une clé stable
  `fournisseur:opération:entité:vVersion`, transmise au connecteur
  (`ctx.idempotencyKey`) avec l'identifiant externe déjà connu
  (`ctx.existingExternalId`). Une reprise ne crée pas de doublon.
- **Dernière version seulement** : si une vente change plusieurs fois avant
  l'envoi, seules les données à jour partent ; les versions intermédiaires sont
  marquées `superseded`.
- **Ordre** : un paiement ou un remboursement attend que la vente existe chez
  le fournisseur.
- **Reprises** : délai croissant (30 s, 1 min, 2 min… jusqu'à 1 h),
  `max_attempts` = 8, puis état `dead` visible dans **Configuration → Caisse
  (POS)**, avec bouton « Relancer ». Chaque tentative est journalisée
  (`pos_sync_log`).
- **Traitement** : automatique toutes les 30 s dans le serveur
  (`POS_WORKER=0` pour désactiver, `POS_WORKER_INTERVAL_MS` pour l'intervalle),
  ou à la demande (« Synchroniser maintenant »). Plusieurs serveurs peuvent
  tourner en parallèle (`FOR UPDATE SKIP LOCKED`).

## Brancher le fournisseur choisi

1. **Créer** `apps/api/src/integrations/pos/<fournisseur>.ts`, une classe qui
   implémente `PosConnector` :
   - `provider` : identifiant court (`'acme'`), enregistré dans `clubs.pos_provider`.
   - `capabilities` : ce que l'API du fournisseur permet réellement.
   - `upsertSale(sale, ctx)` : créer la vente si `ctx.existingExternalId` est
     nul, sinon la mettre à jour (ou l'annuler si `sale.status = 'cancelled'`).
     Retourner `{ externalId }`.
   - `recordPayment` / `recordRefund` : seulement si le fournisseur les accepte.
   - Transmettre `ctx.idempotencyKey` si l'API accepte une clé d'idempotence.
   - Lever `new PosError(message, true)` pour une panne passagère (réseau,
     429, 5xx) et `new PosError(message, false)` pour un refus définitif.
2. **Enregistrer** le connecteur dans `registry.ts` (lecture des clés depuis
   l'environnement, jamais dans le code ni en base).
3. **Activer** pour un golf : Configuration → Général → « Caisse (POS) ».
4. **Tester** : écrire un test sur le modèle de `test/orders-pos.test.ts`
   (faux serveur HTTP du fournisseur), puis un essai sur le bac à sable du
   fournisseur.

Si le fournisseur **notifie** des paiements encaissés en caisse (webhook) :
ajouter une route qui vérifie la signature, puis appelle
`createPendingPayment` (si besoin) et `settleProviderPayment` : le paiement ne
devient `confirmed` qu'à ce moment, avec contrôle du montant et de la devise.

## Informations à demander au fournisseur

| Sujet | Question | Où cela intervient |
|---|---|---|
| Accès | Type d'authentification (clé API, OAuth2), environnement de test (bac à sable) | Variables d'environnement du connecteur |
| Comptes | Un compte / un établissement par golf ? Identifiant d'établissement ou de caisse | `external_refs` par golf, config du connecteur |
| Ventes | Création et mise à jour d'une vente/commande ouverte ? Annulation ? | `upsertSale` |
| Articles | Faut-il des articles créés à l'avance (SKU) ? Codes utilisés par Resa : `GREEN_FEE_9`, `GREEN_FEE_18`, `CADDIE`, `PRIVATE_SURCHARGE`, `CANCELLATION_FEE`, codes du matériel (`CART`, `TROLLEY`, `BAG_…`) | `PosLine.sku` |
| Taxes | Prix TTC ou HT ? Taux ou code de taxe à envoyer ? Arrondis ? | `PosLine.taxRateBp`, `capabilities.priceMode` |
| Devises | Montants en unités mineures (centimes) ou décimales ? | Conversion dans le connecteur |
| Clients | Création de fiches clients ? Champs obligatoires ? | `PosSale.customer`, `external_refs` (`customer`) |
| Paiements | Enregistrer un paiement reçu ailleurs (espèces à la réception) ? Moyens de paiement acceptés | `recordPayment`, correspondance des moyens |
| Remboursements | Remboursement total/partiel, lié au paiement d'origine ? | `recordRefund` |
| Idempotence | Clé d'idempotence acceptée ? En-tête ? Durée de validité ? | `ctx.idempotencyKey` |
| Limites | Nombre de requêtes autorisé, codes d'erreur | `PosError(retryable)` |
| Notifications | Webhooks (paiement encaissé en caisse, vente modifiée) ? Signature ? | Route de notification + `settleProviderPayment` |

Variables d'environnement à prévoir (exemple, à adapter) :
`POS_<FOURNISSEUR>_API_KEY`, `POS_<FOURNISSEUR>_BASE_URL`,
`POS_<FOURNISSEUR>_WEBHOOK_SECRET`, identifiant d'établissement par golf.

## Paiement en ligne (prestataire de paiement)

Même principe, séparé du POS : le paiement est créé `pending` avec
`createPendingPayment`, puis confirmé **uniquement** par la notification signée
du prestataire (`settleProviderPayment`, idempotent, contrôle du montant). Le
réglage `clubs.online_payment` (`none` / `optional` / `required`) est prêt ; le
prestataire (ex. CMI au Maroc) reste à choisir.
