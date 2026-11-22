# ARCHITECTURE TECHNIQUE — Pharmacie Manager Pro
Dernière mise à jour : 2026-11-22 · Version : 0.9.1

## Pile et structure
Node.js + Express + PostgreSQL (≥ 13) ; frontend HTML/CSS/JS sans framework (PWA). Dépendances minimales ; aucun bundler.
- `backend/src/` : `app.js` (montage des routes), `server.js`, `db.js` (pool, `tx`, `audit`), `config.js` · `routes/` (une par module) · `lib/` (logique) · `middleware/` (`auth.js`, `rateLimit.js`).
- `backend/db/` : `schema.sql` + `schema_phase2…9.sql` (idempotents, appliqués dans l'ordre par `scripts/migrate.js`, rôle propriétaire).
- `backend/scripts/` : migrate, seed-superadmin, backup / backup-verify / restore, import-reference.
- `frontend/` : `index.html` charge `api.js, ui.js, modules.js … modules4.js, pwa.js, app.js` (ordre significatif) ; `sw.js` (cache de la coquille uniquement, jamais `/api/*`).
- `docker/`, `docs/` (DEPLOIEMENT, RECETTE), `e2e/` (test navigateur).

## Migrations
P1 `schema.sql` : pharmacies, comptes, modules, audit, RLS · P2 patients, stocks, dispensation · P3 achats, ventes, rapports · P4 base de référence, substitutions, factures, conformité, journal d'audit en ajout seul · P5 CRM/fidélité, RH/planning · P6 `tenants.timezone`, fonctions `app_tz/app_today/app_date` · P7 groupes (`parent_id`, `max_subsites`, `group_patient_access`), rôle `gerant`, déclencheurs profondeur et quota · P8 transferts de stock (3 tables, RLS, `app_tenant/app_bypass`, types de mouvement) · P9 réception partielle (`received_quantity`, `shortfall_*`, statut `received_short`).

## Montage des routes (`/api/…`)
auth · superadmin · users · groupe · site · transferts · patients · stocks · dispensation · achats · ventes · rapports · integrations · conformite · crm · rh. Le détail des routes et droits est dans la table API du `README.md`.

## Mécanismes à connaître avant de modifier le code
- **Isolation** : RLS PostgreSQL, rôle applicatif non superuser. Toute requête métier passe par `tx(ctx(req), …)` ; `ctx(req)` = `{ tenantId, timezone, actingFrom }` (exigé par un test de cohérence) ; `tx({ system: true }, …)` contourne la RLS : réservé au Superadmin et aux contrôles de groupe, avec vérification explicite en code.
- **Droits** (`lib/permissions.js`) : droits effectifs = (rôle ∪ droits accordés) ∩ modules activés ; rangs `ROLE_RANK` (on ne gère que des rangs inférieurs) ; `withoutPatientAccess` pour l'Admin du groupe sans accès accordé.
- **Pharmacie de travail** (`lib/sites.js`, `middleware/auth.js`) : l'Admin d'une pharmacie principale peut travailler dans une de SES sous-pharmacies via l'en-tête `X-Pharmacy-Id` ; `req.user.tenantId` désigne alors la sous-pharmacie ; `homeTenantId` reste la sienne ; modules d'une sous-pharmacie = les siens ∩ ceux de la principale ; l'abonnement de la principale s'applique.
- **Dates** : instants en UTC ; tout « jour » via `app_today()` / `app_date()` côté SQL et `lib/tz.js` / `today(tz)` côté JS ; jamais `CURRENT_DATE` ni `colonne::date` sur un horodatage (test de cohérence).
- **Stock** : `lib/stock.js` (FEFO pur), `lib/stockOps.js` (`receiveLot`, `consumeFEFO`, `restock`) ; types de mouvement : reception, adjustment, dispensation, sale, return, transfer_out, transfer_in, transfer_return (CHECK en base + libellés alignés par test).
- **Transferts** : `lib/transfers.js` (états, appariement des produits, plan de réception : logique pure) ; `routes/transferts.js` ; chaque côté dans sa transaction ; verrou `FOR UPDATE` sur le transfert.
- **Audit** : `audit(c, …)` ; actions de l'Admin du groupe marquées `via_group_admin`.
- **Interface** : `app.js` (coque, menus, vues Superadmin / groupe / transferts), `modules*.js` (vues par module), `ui.js` (fuseau, dates, modales), `api.js` (jetons, `X-Pharmacy-Id`). Les noms de comptes et pharmacies Superadmin arrivent en snake_case, le reste en camelCase.
- **Variables d'environnement** : DATABASE_URL, MIGRATE_DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, BACKUP_ENCRYPTION_KEY, BACKUP_DIR, BACKUP_KEEP, BACKUP_UPLOAD_CMD, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD, API_RATE_MAX, LOGIN_RATE_MAX (voir `.env.example`).

## Tests et vérification (quatre niveaux)
1. `npm test` — 64 tests, sans base : logique pure + contrôles de cohérence statique (tables/colonnes du SQL, nombre de paramètres `$n`, appels de l'interface ↔ routes, `ctx(req)`, droits des routes de transferts, types de mouvement, statuts, dossiers de référence). Validés par mutation ; ils ne détectent ni les erreurs de logique SQL ni les colonnes non qualifiées dans un `SELECT`.
2. `npm run test:e2e` — Chromium (Playwright) contre un faux serveur d'API (`e2e/server.js`) : valide l'interface et son contrat avec l'API. Prérequis : `npm i -D playwright && npx playwright install chromium`.
3. `npm run test:integration` — vraie API + PostgreSQL de test dédiée (`TEST_DATABASE_URL`) ; ou `./docker/run-integration-tests.sh`. **Jamais exécuté pour les phases 6 à 9.**
4. `docs/RECETTE.md` — plan de recette manuel (R1 à R70).

## Conventions de travail
Modifications ciblées par remplacements scriptés avec assertions (une occurrence attendue) ; relire par plages (`sed`, `grep`) plutôt que des fichiers entiers ; après chaque changement : `npm test`, plus `npm run test:e2e` si l'interface change ; garde-fous de sécurité contrôlés par mutation ; version (`package.json`), cache du service worker (`frontend/sw.js`) et `CHANGELOG.md` mis à jour à chaque livraison.
