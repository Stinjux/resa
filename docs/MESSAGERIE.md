# Réservations par WhatsApp et SMS

## Règle métier

**Toute demande reçue par WhatsApp ou SMS doit être validée par une
réceptionniste ou un directeur du golf avant d'être réservée.** Ni l'IA ni le
système ne réservent seuls.

## Déroulement

1. Le client écrit au numéro WhatsApp ou SMS du golf (« 2 départs à 13h
   demain »).
2. **Avec l'IA activée** (`ANTHROPIC_API_KEY`) : l'assistant client répond, demande
   ce qui manque (joueurs, 9/18 trous, nom), vérifie les disponibilités,
   propose des horaires, puis **transmet une demande** au golf et prévient le
   client qu'elle est en attente de validation.
   **Sans IA** : un accusé de réception est envoyé et le personnel répond depuis
   Resa.
3. La demande apparaît dans **Demandes** (compteur dans la barre de
   navigation) pour la réception et la direction du golf.
4. Le personnel **valide** : la réservation est créée (canal WhatsApp ou SMS),
   le client est retrouvé par son numéro ou créé, et **une confirmation est
   envoyée** avec la référence et le prix. Ou il **refuse** : le client reçoit un
   message, avec le motif s'il est indiqué.
5. Si le créneau a été pris entre-temps, la validation échoue avec un message
   clair ; la demande reste en attente (répondre au client ou refuser).

Le personnel peut aussi écrire directement au client depuis la conversation.
Chaque validation et chaque refus est historisé avec son auteur.

## Garde-fous de l'assistant client

- Il ne voit que les **disponibilités et les prix de ce golf**, jamais les
  données d'autres clients ni la feuille de départs.
- Il ne peut que **déposer une demande** (`submit_booking_request`), qui revérifie
  chaque créneau.
- Il traite le texte des clients comme une demande, jamais comme une
  instruction.
- Coût maîtrisé : 40 tours d'IA par conversation et par 24 h
  (`AI_MESSAGING_TURNS_PER_DAY`), au-delà le personnel prend le relais.

## Tester sans fournisseur : le simulateur

Configuration → Général → **Messagerie WhatsApp / SMS : local (simulateur)**.
Dans **Demandes**, « Simuler un message client » : saisir un numéro et un
message comme si le client écrivait. Les réponses « envoyées » restent visibles
dans Resa (rien ne part réellement). Le golf G1 de démonstration est déjà
configuré ainsi, avec une demande WhatsApp en attente de validation.

## Brancher le vrai fournisseur

Aucun fournisseur n'est choisi ; aucune API n'est supposée. Options courantes :
**WhatsApp Business Platform** (Meta, API Cloud), un intermédiaire
comme **Twilio** ou **Vonage** (WhatsApp et SMS), ou un **opérateur SMS
marocain**.

1. Créer `apps/api/src/integrations/messaging/<fournisseur>.ts` qui implémente
   `MessagingConnector` (`contract.ts`) :
   - `send(message, { idempotencyKey })` : envoi, renvoie l'identifiant du
     message chez le fournisseur ; lever `MessagingError(message, retryable)`.
   - `handleWebhook(req)` : **vérifier la signature** avec `req.rawBody`, puis
     renvoyer les messages entrants (`providerMessageId` obligatoire : c'est
     l'anti-doublon), et `challenge` pour la vérification d'URL si le
     fournisseur en utilise une.
2. L'enregistrer dans `registry.ts` (clés lues dans l'environnement).
3. Déclarer chez le fournisseur l'URL de notification du golf :
   `https://<domaine>/api/messaging/<fournisseur>/webhook/<id du golf>`.
4. Configuration → Général → Messagerie : choisir le fournisseur.

Les envois partent automatiquement (toutes les 5 s), avec 5 essais à délai
croissant ; un message en échec est signalé dans la conversation.

## Informations à obtenir du fournisseur

| Sujet | Question |
|---|---|
| Accès | Clé ou jeton d'API, identifiant du compte / du numéro émetteur, environnement de test |
| Notifications | Format des messages entrants, méthode de signature (secret, en-tête), vérification d'URL |
| WhatsApp | Numéro WhatsApp Business validé ; **fenêtre de 24 h** : hors de cette fenêtre, seuls des **modèles de messages pré-approuvés** peuvent être envoyés (prévoir des modèles pour la confirmation et le refus si la validation peut tarder) |
| SMS | Nom d'expéditeur (sender ID) autorisé au Maroc, longueur maximale, caractères arabes (encodage Unicode, coût) |
| Coûts | Prix par message ou par conversation, par pays |
| Limites | Débit maximal, codes d'erreur à réessayer |

Variables d'environnement à prévoir (exemple) :
`MESSAGING_<FOURNISSEUR>_TOKEN`, `MESSAGING_<FOURNISSEUR>_WEBHOOK_SECRET`,
identifiant du numéro émetteur par golf.

## Où est le code

| Fichier | Rôle |
|---|---|
| `integrations/messaging/` | Contrat, simulateur local, registre |
| `modules/messaging/agent.ts` | Assistant IA côté client (prompt, 3 outils) |
| `modules/messaging/service.ts` | Réception, file d'envoi, boîte de réception, validation / refus |
| `modules/messaging/templates.ts` | Messages automatiques (fr, en, ar) |
| `test/messaging.test.ts` | Validation obligatoire, droits, refus, créneau pris, doublons, reprises |
