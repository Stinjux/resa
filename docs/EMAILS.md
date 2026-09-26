# E-mails aux clients

## Ce qui est envoyé

| E-mail | Quand |
|---|---|
| Confirmation | À la création (web, téléphone, assistant IA, WhatsApp/SMS validé). Un groupe reçoit **un seul récapitulatif** de tous ses départs |
| Modification | Déplacement, réunion sur un autre départ, changement de joueurs, de formule 9/18, d'options ou de départ privé (pas pour une note interne) |
| Annulation | À l'annulation, avec les frais d'annulation éventuels |
| Rappel | X heures avant le départ (24 h par défaut, réglable par golf, 0 = aucun) ; une seule fois, et pas pour une réservation faite après l'heure du rappel |

Seuls les clients **ayant une adresse e-mail** reçoivent des messages. La langue
est celle du client (français, anglais, arabe), sinon la langue par défaut du golf.
Le contenu : date, heure, parcours, joueurs, formule, options, référence, total
TTC et part à régler sur place, date limite d'annulation gratuite, téléphone et
adresse de contact du golf.

## Réglages par golf

Configuration → Général : activer / désactiver les e-mails, délai du rappel,
téléphone affiché, adresse de réponse (les clients qui répondent écrivent à cette
adresse).

Configuration → **E-mails** : liste des e-mails (état, erreurs), aperçu, renvoi.

## Brancher l'envoi réel

Sans configuration, Resa fonctionne en **mode journal** : les e-mails sont
préparés et consultables, mais **aucun ne part**. Pour envoyer, il suffit d'un
compte chez n'importe quel fournisseur SMTP (Brevo, Mailjet, Amazon SES, OVH,
Google Workspace…), dans le fichier `.env` / `.env.production` :

```
SMTP_URL=smtps://utilisateur:motdepasse@smtp.fournisseur.com:465
EMAIL_FROM=reservations@mon-golf.ma
```

- `EMAIL_FROM` doit appartenir à un domaine **vérifié chez le fournisseur**
  (enregistrements SPF et DKIM dans le DNS du domaine), sinon les e-mails
  arrivent en indésirables. Le nom affiché est celui du golf.
- Redémarrer Resa : le journal indique « E-mails : envoi SMTP activé ».

Les envois partent toutes les 30 s ; en cas d'erreur, 5 essais à délai
croissant, puis l'e-mail passe « en échec » (renvoi possible depuis l'écran).

## Où est le code

| Fichier | Rôle |
|---|---|
| `integrations/email/sender.ts` | Envoi SMTP (nodemailer) ou mode journal |
| `modules/notifications/service.ts` | Contenu (fr/en/ar, texte + HTML), file, rappels, renvoi |
| `modules/booking/service.ts` | Mise en file dans la même transaction que la réservation |
| `test/notifications.test.ts` | Déclencheurs, langues, échappement HTML, groupe, rappels, reprises, droits |
