# Déploiement et mise en service — Pharmacie Manager Pro

> **Statut de vérification (à lire d'abord).** Les schémas SQL et les routes API n'ont **jamais été exécutés sur PostgreSQL** par l'équipe de développement (pas de base disponible dans son environnement). Avant toute utilisation avec de vraies données, exécutez la suite d'intégration (§3) et le plan de recette (`docs/RECETTE.md`). Ne confiez pas de données réelles de patients à l'application avant ces deux étapes.

## 1. Prérequis
PostgreSQL **≥ 13** et Node.js **≥ 18**, ou Docker + Docker Compose.

## 2. Démarrage rapide avec Docker
```bash
cp .env.example .env
# Renseigner dans .env (mots de passe ALPHANUMÉRIQUES pour les 3 premiers) :
#   POSTGRES_PASSWORD, PMP_OWNER_PASSWORD, PMP_APP_PASSWORD   → openssl rand -hex 16
#   JWT_SECRET (openssl rand -hex 32), ENCRYPTION_KEY (openssl rand -hex 32), BACKUP_ENCRYPTION_KEY (openssl rand -hex 32)
#   SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD (≥ 10 caractères, lettres + chiffres)
docker compose up -d --build
# → http://localhost:3000 (écoute sur 127.0.0.1 uniquement). Premier démarrage : migration + création du Superadmin.
```
Deux rôles PostgreSQL sont créés automatiquement (`docker/initdb/01-roles.sh`) :
- `pmp_owner` : propriétaire du schéma, utilisé **seulement** pour les migrations ;
- `pmp_app` : rôle de l'application, **non superuser, sans BYPASSRLS, sans droit de modifier le schéma**. C'est indispensable : un superuser contourne l'isolation entre pharmacies.

⚠ **Conservez `ENCRYPTION_KEY` et `BACKUP_ENCRYPTION_KEY` hors du serveur** (gestionnaire de mots de passe). Perdre `ENCRYPTION_KEY` rend illisibles les n° d'assuré, notes patients et secrets 2FA ; perdre `BACKUP_ENCRYPTION_KEY` rend les sauvegardes inutilisables. Ne les modifiez jamais après la mise en service (aucune rotation de clé n'est implémentée).

### Installation sans Docker
```sql
-- en tant que superuser, sur la base pharmacie_db
CREATE ROLE pmp_owner LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE pmp_app   LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
ALTER DATABASE pharmacie_db OWNER TO pmp_owner;
ALTER SCHEMA public OWNER TO pmp_owner;
GRANT USAGE ON SCHEMA public TO pmp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pmp_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pmp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pmp_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pmp_app;
```
Puis `npm install`, renseigner `.env` (`DATABASE_URL` = pmp_app, `MIGRATE_DATABASE_URL` = pmp_owner), `npm run migrate`, `npm run seed`, `npm start`.

## 3. Valider l'installation : tests d'intégration
Avant même de lancer une base : `npm test` exécute 41 tests dont des **contrôles de cohérence statique** (tout nom de table/colonne cité dans le SQL existe dans les schémas ; chaque requête reçoit le bon nombre de paramètres ; chaque appel de l'interface correspond à une route). Ils attrapent fautes de frappe et oublis, **pas** les erreurs de logique SQL : seule l'exécution sur PostgreSQL (ci-dessous) le prouve.

Sur une base **dédiée aux tests** (jamais la production) :
```bash
./docker/run-integration-tests.sh          # avec Docker : crée pharmacie_test et lance la suite
# ou, sans Docker :
TEST_DATABASE_URL=postgresql://pmp_app:…@localhost:5432/pharmacie_test \
TEST_MIGRATE_DATABASE_URL=postgresql://pmp_owner:…@localhost:5432/pharmacie_test npm run test:integration
```
La suite (31 scénarios) couvre : migrations idempotentes, rôle non superuser, **isolation entre pharmacies (RLS) par l'API et en SQL direct**, droits et modules, chiffrement des données patient au repos, sortie de stock FEFO, **concurrence** (deux ventes de la dernière unité), délivrance, interactions via classes, substitutions, achats/factures, rapports, rappel de lot, journal d'audit en ajout seul, fidélité (gain, utilisation, remboursement, **deux caisses sur les mêmes points**), rappels de renouvellement, entretiens chiffrés, plannings (garde de nuit, absences), pointage, rotation des jetons, verrouillage, 2FA, limites de taille des requêtes.
> Cette suite n'a pas pu être exécutée par ses auteurs. Au premier lancement, un échec peut venir d'un défaut du code **ou** d'un défaut du test : lisez le message (il indique la réponse HTTP reçue) et signalez-le avant de continuer.

## 4. Mise en production
**HTTPS obligatoire.** Placez un reverse proxy devant l'application, par exemple Caddy (certificats automatiques) :
```
pharmacie.exemple.ml {
    reverse_proxy 127.0.0.1:3000
}
```
Dans `.env` : `NODE_ENV=production`, `TRUST_PROXY=1`, `CORS_ORIGINS=` (vide : même origine uniquement). En production, tout accès HTTP est redirigé vers HTTPS.

**Premiers pas** : connexion Superadmin (changement de mot de passe imposé) → *Pharmacies* → créer la pharmacie, activer ses modules, créer son Admin (le mot de passe temporaire s'affiche une seule fois) → l'Admin crée son équipe.

**Base clinique** : aucune base d'interactions réelle n'est fournie. Chargez une base reconnue (module *Intégrations* ou `npm run import-reference`) et faites-la valider par le pharmacien responsable. Le fichier `backend/data/reference.sample.json` est un exemple de test, pas une source clinique.

## 5. Sauvegardes
```bash
# crontab (tous les jours à 2 h 30)
30 2 * * * cd /opt/pmp && docker compose exec -T app npm run backup >> backup.log 2>&1
```
- Configurez `BACKUP_UPLOAD_CMD` (copie hors serveur, ex. `rclone copy "$BACKUP_FILE" remote:pmp/`) : une sauvegarde sur le même serveur ne protège pas de sa perte.
- Surveillez `backup.log` : un échec doit vous alerter.
- **Testez une restauration** au moins une fois par trimestre, sur une base vide : `npm run backup:verify -- fichier` puis `npm run restore -- fichier --yes`.

## 6. Mise à jour
1. `npm run backup` (et vérifier la copie) → 2. récupérer la nouvelle version → 3. `docker compose up -d --build` (la migration s'exécute au démarrage ; elle est idempotente) → 4. relancer le test d'intégration sur la base de test → 5. contrôle visuel rapide.

### Passage à la 0.6.4 (fuseau horaire par pharmacie)
La migration ajoute `tenants.timezone` (défaut `UTC`) et trois fonctions SQL (`app_tz`, `app_today`, `app_date`) : elle doit s'exécuter avec le rôle **propriétaire** (`pmp_owner`), comme les autres. Le rôle applicatif les appelle sans droit particulier. Ensuite, Superadmin → Pharmacies → Gérer : **renseigner le fuseau de chaque pharmacie** (ex. `Africa/Bamako`). Tant que ce n'est pas fait, les jours se calculent en UTC, comme avant. Les noms acceptés sont ceux de la base `tzdata` de PostgreSQL ; gardez le paquet à jour (changements d'heure légale des pays).

### Passage à la 0.7.0 (pharmacies multi-sites)
La migration (`schema_phase7.sql`, rôle **propriétaire**) ajoute trois colonnes à `tenants`, des contraintes et deux déclencheurs (profondeur et quota), et remplace le `CHECK` du rôle des comptes pour y ajouter `gerant`. Elle est idempotente. Les pharmacies existantes restent simples (quota 0). Pour ouvrir un groupe : Superadmin → Pharmacies → Nouvelle pharmacie → « Sous-pharmacies autorisées » (ou Gérer sur une pharmacie existante), créer son Admin ; c'est ensuite cet Admin qui ouvre les sous-pharmacies et désigne les gérants. L'accès de l'Admin du groupe aux dossiers patients d'une sous-pharmacie est fermé par défaut : seul le gérant local de cette sous-pharmacie peut l'accorder (menu « Accès du groupe ») et le retirer ; le Superadmin n'intervient pas. Faites valider ce fonctionnement par un juriste selon la réglementation sur les données de santé de votre pays. Si un reverse proxy filtre les en-têtes, laissez passer `X-Pharmacy-Id`.

### Passage à la 0.8.0 (transferts de stock)
La migration (`schema_phase8.sql`, rôle **propriétaire**, idempotente) crée trois tables avec leurs politiques RLS, deux fonctions (`app_tenant`, `app_bypass`), un déclencheur, et **remplace le CHECK des types de mouvements** de stock. Aucun changement de configuration. Le droit « stocks:transfer » est donné par défaut aux Admins, gérants et pharmaciens ; pour d'autres rôles, l'activer à la carte dans « Employés ». Les produits à registre ne sont pas transférables : prévoyez la procédure réglementaire habituelle pour eux.

### Passage à la 0.9.0 (réception partielle)
La migration (`schema_phase9.sql`, rôle **propriétaire**, idempotente) ajoute trois colonnes et remplace le CHECK des statuts de transfert pour y ajouter `received_short`. Aucune donnée existante n'est modifiée : un transfert déjà reçu reste « Reçu ».

## 7. Checklist avant de recevoir de vraies données
- [ ] Tests d'intégration verts · plan de recette exécuté (`docs/RECETTE.md`)
- [ ] Fuseau horaire renseigné pour chaque pharmacie (Superadmin → Gérer)
- [ ] Transferts : un transfert de test complet (envoi, réception, refus, reprise) vérifié entre deux pharmacies du groupe
- [ ] Groupes multi-sites : quota, Admin unique et gérants vérifiés ; accès patients du groupe fermé sauf décision du gérant local
- [ ] HTTPS actif, `NODE_ENV=production`, base non exposée sur Internet
- [ ] Rôle applicatif vérifié non superuser (le test « rôle applicatif » le contrôle)
- [ ] Clés conservées hors serveur · sauvegarde quotidienne + copie distante + restauration testée
- [ ] Mots de passe Superadmin/Admin changés, 2FA activée pour Superadmin et Admins
- [ ] Base clinique validée par un pharmacien · registre des produits contrôlés validé selon la réglementation locale
- [ ] Information des patients et formalités de protection des données de santé selon la loi applicable (à faire avec un juriste)

## 8. Limites connues
Pas de rotation des clés de chiffrement · limiteur de débit en mémoire (une seule instance) · refresh token en cookie HttpOnly de session (SameSite=Strict) : l'application et l'API doivent être servies sur la **même origine** (pas de CORS avec cookies) · pas de saisie hors ligne · e-prescription, API grossistes, multi-sites non réalisés · pas d'envoi automatique de SMS/e-mail · pas de calcul d'heures supplémentaires ni de paie · pas de package-lock.json (exécutez `npm install` une fois et versionnez le fichier généré pour des builds reproductibles).
