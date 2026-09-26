# Intelligence artificielle

Deux fonctions, réservées au personnel :

- **Assistant IA** (réception, direction) : réserver en langage naturel
  (« book moi 2 départs à 13h le 25 mars ») et poser des questions (« qui joue
  à 9h demain ? », « reste à encaisser cette semaine ? »).
- **Rapports** (direction) : chiffres de la période calculés par Resa, puis
  analyse rédigée par l'IA (synthèse, remplissage, chiffre d'affaires,
  encaissements, caddies, matériel, recommandations).

Modèle utilisé : **Claude** (Anthropic), `claude-opus-5` par défaut.

## Activer

1. Créer une clé API sur https://console.anthropic.com (Settings → API keys)
   et approvisionner le compte.
2. **En local (Docker)** : créer un fichier `.env` à la racine du projet (à côté
   de `docker-compose.yml`) contenant :
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   puis relancer `docker compose up`. Le journal affiche « IA activée ».
3. **En production** : ajouter la même ligne dans `.env.production`.

Ne transmettez jamais la clé par e-mail ou messagerie ; elle ne doit exister que
dans ces fichiers (ignorés par Git). En cas de fuite : la révoquer dans la
console Anthropic et en créer une nouvelle.

Sans clé, tout Resa fonctionne ; seuls l'assistant et l'analyse rédigée sont
indisponibles (les chiffres des rapports restent accessibles).

## Garde-fous

| Risque | Protection |
|---|---|
| L'IA réserve seule ou se trompe | L'IA ne fait que **préparer un brouillon** (`propose_booking`). La réservation est créée uniquement quand l'employé clique sur **Confirmer**, avec les mêmes contrôles que la feuille de départs (4 joueurs, caddie, matériel, concurrence). Brouillon valable 30 min, confirmation idempotente. |
| Informations manquantes ou inventées | Le prompt impose de demander ce qui manque en une seule question ; le brouillon affiche tout (date, heure, joueurs, formule, client, prix) avant confirmation. |
| Disponibilités inventées | L'IA doit passer par `find_available_tee_times` ; `propose_booking` revérifie chaque créneau. |
| Accès aux données | Chaque outil s'exécute avec les **droits de l'utilisateur connecté** : un starter ne peut rien préparer, une réception ne voit que son golf, les statistiques sont réservées à la direction. |
| Chiffres faux dans les rapports | Les chiffres sont **calculés en SQL** par Resa et affichés à côté du texte ; l'IA ne fait que rédiger à partir d'eux. |
| Données personnelles | Rapports : aucune donnée personnelle envoyée (agrégats uniquement). Assistant : noms des clients nécessaires aux réservations, téléphones masqués (4 derniers chiffres). |
| Instructions cachées dans des données (notes clients) | Le prompt les traite comme des données ; toute réservation exige de toute façon la confirmation humaine. |
| Coûts | 30 appels IA par minute et par IP (`AI_RATE_LIMIT`), mise en cache du prompt, effort « medium » pour l'assistant. |

## Coûts indicatifs

Tarif `claude-opus-5` : 5 $ par million de jetons en entrée, 25 $ en sortie
(le cache réduit fortement l'entrée répétée). Ordre de grandeur : une
réservation complète par l'assistant (4 à 6 échanges avec outils) coûte
quelques centimes de dollar ; un rapport mensuel, quelques centimes à une
dizaine de centimes. Suivi réel : console Anthropic → Usage.

## Réglages (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Active l'IA |
| `AI_MODEL` | `claude-opus-5` | Modèle Claude utilisé |
| `AI_ASSISTANT_EFFORT` | `medium` | Profondeur de réflexion de l'assistant (`low` → plus rapide) |
| `AI_REPORT_EFFORT` | `high` | Profondeur de réflexion des rapports |
| `AI_RATE_LIMIT` | `30` | Appels IA par minute et par IP |

Si le modèle refuse une demande (filtres de sécurité), l'API la rejoue
automatiquement sur le modèle de repli recommandé par Anthropic
(`fallbacks: "default"`).

## Où est le code

| Fichier | Rôle |
|---|---|
| `apps/api/src/modules/ai/model.ts` | Connexion à l'API Anthropic (remplaçable par un faux modèle dans les tests) |
| `apps/api/src/modules/ai/assistant.ts` | Prompt, outils, boucle de conversation, brouillons et confirmation |
| `apps/api/src/modules/ai/reports.ts` | Calcul des chiffres (SQL) et rédaction du rapport |
| `apps/api/test/ai.test.ts` | Scénario « 2 départs à 13h », droits, créneau indisponible, expiration, rapports |
