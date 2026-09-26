# Mise en ligne

Resa tourne sur n'importe quel serveur Linux avec Docker : un seul serveur
suffit pour les 4 golfs (PostgreSQL + application + HTTPS automatique +
sauvegardes quotidiennes).

## 1. Prérequis

- Un serveur (VPS) Linux, 2 Go de RAM minimum, par exemple chez OVHcloud,
  Hetzner, Scaleway ou DigitalOcean. Choisissez un centre de données proche du
  Maroc (France, Espagne) pour la rapidité.
- Un nom de domaine, par exemple `resa.mon-golf.ma`, dont l'enregistrement DNS
  **A** pointe vers l'adresse IP du serveur.
- Docker installé sur le serveur : `curl -fsSL https://get.docker.com | sh`.
- Ports 80 et 443 ouverts.

## 2. Installation

```bash
git clone https://github.com/Stinjux/resa.git && cd resa
cp .env.production.example .env.production
nano .env.production      # DOMAIN et POSTGRES_PASSWORD (lettres et chiffres, 24+ caractères)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Le certificat HTTPS est obtenu automatiquement (Caddy + Let's Encrypt) quand le
DNS pointe bien vers le serveur. En production, aucun compte ni donnée de
démonstration n'est créé, et les boutons de démo sont absents.

## 3. Premier administrateur

```bash
docker compose -f docker-compose.prod.yml exec \
  -e ADMIN_PASSWORD='un-mot-de-passe-long-et-unique' app \
  node --import tsx apps/api/src/cli/bootstrap.ts \
  --org-code GOLFS-MA --org-name "Golfs du Maroc" --email vous@exemple.ma --name "Votre nom"
```

Puis sur `https://<votre-domaine>` : **Connexion** → **Configuration** →
**+ Nouveau golf**, pour chacun des 4 golfs. Pour chaque golf, saisir les
horaires, les tarifs (aucune réservation n'est possible sans green fee), le
nombre de caddies et le matériel. Enfin, créer les comptes du personnel : pour
l'instant avec l'outil `bootstrap` (administrateurs), un écran de gestion des
utilisateurs restant à faire.

## 4. Exploitation

| Action | Commande |
|---|---|
| État | `docker compose -f docker-compose.prod.yml ps` (l'application expose `/health`) |
| Journaux | `docker compose -f docker-compose.prod.yml logs -f app` |
| Mise à jour | `git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build` (migrations automatiques) |
| Arrêt | `docker compose -f docker-compose.prod.yml down` (les données restent) |

### Sauvegardes

Le service `backup` fait un `pg_dump` par jour dans `./backups`, conservé 14
jours. **Copiez aussi ce dossier hors du serveur** (autre machine, stockage
objet), sinon une panne du serveur emporterait les sauvegardes.

Restauration :

```bash
docker compose -f docker-compose.prod.yml stop app
docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U resa -d resa --clean --if-exists < backups/resa-AAAA-MM-JJ-HHMM.dump
docker compose -f docker-compose.prod.yml start app
```

## 5. Sécurité en place

- HTTPS obligatoire, en-têtes de sécurité (CSP stricte, anti-iframe, nosniff).
- Mots de passe hachés (scrypt), jetons de session stockés sous forme
  d'empreinte, sessions de 12 h nettoyées automatiquement.
- Limitation : 10 tentatives de connexion ou d'inscription par minute et par
  IP (`LOGIN_RATE_LIMIT`), 600 requêtes par minute et par IP au total.
- Cloisonnement par golf, données personnelles masquées au starter, historique
  des changements sans données personnelles.
- L'application tourne sans privilèges (`node`), la base n'est pas exposée sur
  Internet.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Connexion PostgreSQL |
| `NODE_ENV=production` | Désactive la démo |
| `AUTO_MIGRATE=1` | Applique les migrations au démarrage |
| `TRUST_PROXY=1` | Derrière Caddy : IP réelle des clients, HTTPS forcé |
| `LOGIN_RATE_LIMIT` | Tentatives de connexion par minute et par IP (10) |
| `POS_WORKER=0` · `POS_WORKER_INTERVAL_MS` | Synchronisation caisse (voir `docs/POS.md`) |
