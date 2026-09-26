# Tour-opérateurs, agences et autres partenaires

## Partenaires

Configuration → **Partenaires** (direction). Un partenaire est commun à tous
les golfs de l'organisation : tour-opérateur, agence de voyage, hôtel,
entreprise.

- **Tarifs négociés** : chaque partenaire a une **catégorie tarifaire**
  (ex. `to`). Ses réservations sont **toujours** tarifées avec cette catégorie :
  il suffit de créer les tarifs correspondants dans l'onglet Tarifs (par golf,
  9/18 trous, jours, heures…). Sans tarif propre à la catégorie, le tarif
  général s'applique.
- **Règlement sur relevé** et délai de paiement (30 jours par défaut).
- Raison sociale, adresse et **ICE** : utilisés par défaut sur les factures de
  ses réservations.
- **Voucher** : chaque réservation garde le numéro de dossier du partenaire.

## Réserver pour un partenaire (réception)

Feuille de départs → nouvelle réservation ou groupe → **Partenaire** et
**N° de voucher**. Le tarif passe automatiquement sur la catégorie du
partenaire. Les réservations apparaissent avec 🧳 et le nom du partenaire.

## Allotements

Configuration → Partenaires → **Allotements de ce golf** : partenaire,
parcours, période, jours, plage horaire (ex. 08:00–08:30) et **release**
(ex. J-7).

- Les départs **libres** de la plage sont retirés de la vente (🔒 « Allotement
  … » sur la feuille, avec la date de remise en vente). Les départs déjà
  réservés ou bloqués ne sont pas pris.
- Seul ce partenaire peut y réserver (réception ou portail).
- À la date de release, les places non utilisées **reviennent
  automatiquement à la vente** (vérification toutes les minutes). Les
  réservations faites restent.
- Annuler un allotement rend immédiatement ses départs à la vente.
- Le tableau indique les départs tenus et les joueurs réservés (taux
  d'utilisation).

## Portail partenaire

Configuration → Partenaires → **Créer un accès** (e-mail et mot de passe
provisoire). Le partenaire se connecte sur la même page que le personnel et
arrive sur l'**Espace partenaire** (français, anglais, arabe) :

- disponibilités de tous les golfs, ses départs d'allotement signalés ;
- prix à son tarif négocié ;
- réservation avec voucher, nom du client principal, noms des joueurs ;
- liste de ses réservations et reste dû ; annulation dans le délai gratuit
  du golf (au-delà : contacter le golf).

Il ne voit ni la feuille de départs, ni les autres clients, ni les autres
partenaires. Démonstration : `partenaire@demo.ma` / `Demo2026!`.

## Relevé de compte

Configuration → Partenaires → **Relevé de compte** (direction) : réservations
de la période (date de départ), voucher, client, statut (confirmée, annulée,
absent), montant, réglé, reste dû, factures émises ; total ; impression / PDF
et export Excel.

Les réservations d'un partenaire se facturent une par une (facture adressée
au partenaire par défaut, voir `docs/FACTURATION.md`).

## À décider plus tard (selon vos contrats)

- Facture mensuelle unique regroupant toutes les réservations du mois.
- Commissions (agences payées à la commission plutôt qu'au tarif net).
- Allotement exprimé en nombre de joueurs plutôt qu'en départs entiers.
- Envoi automatique du relevé par e-mail.

## Où est le code

| Fichier | Rôle |
|---|---|
| `db/migrations/011_partners.sql` | Partenaires, voucher, accès portail, allotements |
| `modules/partners/service.ts` | Partenaires, allotements (tenue, release, annulation), relevé |
| `modules/booking/service.ts` | Tarif du partenaire, accès aux départs de son allotement |
| `http/routes/partners.ts` | API personnel et portail |
| `web/src/pages/Partners.tsx`, `PartnerPortal.tsx` | Écrans |
| `test/partners.test.ts` | Tarifs négociés, allotements, release, portail, droits, relevé |
