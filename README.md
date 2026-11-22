# Pharmacie Manager Pro — v0.9.1

Système de gestion d'officine multi-tenant (SaaS). Stack : **Node.js + Express + PostgreSQL**, frontend HTML/CSS/JS sans framework.

## Documentation de référence
| Fichier | Contenu |
|---|---|
| `CAHIER_DES_CHARGES.md` | Décisions validées, choix à confirmer, hors périmètre ; **fonctionnalités et règles métier par phase** (Phases 1 à 5, multi-sites, transferts de stock, fuseaux horaires, modèle d'accès) |
| `ARCHITECTURE_TECHNIQUE.md` | Pile, structure, migrations, mécanismes, tests, conventions |
| `ETAT_ACTUEL.md` | État du projet, tests exécutés, problèmes ouverts, prochaine tâche |
| `SUIVI_EXECUTION.md` | Tâches par version avec statut et preuves |
| `DIRECTIVE_AGENT.md` | Directive permanente de travail de l'assistant (économie de tokens, vérification) |
| `CHANGELOG.md` · `docs/DEPLOIEMENT.md` · `docs/RECETTE.md` | Journal des versions · mise en production · plan de recette |

## Tests
`npm test` (64 tests, sans base) · `npm run test:e2e` (interface sous Chromium contre une API simulée) · `npm run test:integration` (vraie base de test dédiée). **Les schémas SQL des phases 6 à 9 et leurs routes n'ont jamais été exécutés sur PostgreSQL** : lancez les tests d'intégration puis la recette avant toute donnée réelle. État détaillé : `ETAT_ACTUEL.md`.

## Installation
**Avec Docker (recommandé)** — crée PostgreSQL avec les bons rôles, migre et crée le Superadmin :
```bash
cp .env.example .env        # renseigner les secrets (voir docs/DEPLOIEMENT.md)
docker compose up -d --build   # http://localhost:3000
./docker/run-integration-tests.sh   # valide l'installation sur une base de test dédiée
```
**Sans Docker** : PostgreSQL ≥ 13, rôles `pmp_owner` (migrations) et `pmp_app` (application, non superuser, sans BYPASSRLS) — commandes SQL dans `docs/DEPLOIEMENT.md`.
```bash
npm install
cp .env.example .env        # DATABASE_URL (pmp_app), MIGRATE_DATABASE_URL (pmp_owner), JWT_SECRET, ENCRYPTION_KEY…
npm run migrate             # schémas (phases 1 à 9) + catalogue des modules (rôle propriétaire)
npm run seed                # crée le Superadmin (SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD)
npm run dev                 # http://localhost:3000
npm test                    # tests unitaires (sans base de données)
npm run test:integration    # tests d'intégration (TEST_DATABASE_URL requis, base dédiée)
```
Le rôle applicatif doit être **non superuser** : un superuser contourne l'isolation entre pharmacies (le premier test d'intégration le vérifie).

## Modèle d'accès
Voir `CAHIER_DES_CHARGES.md` (annexe) : le Superadmin crée la pharmacie et son Admin ; l'Admin crée les employés ; droits effectifs = (rôle ∪ permissions accordées) ∩ modules activés ; effet à la requête suivante.

## API (préfixe `/api`)
| Route | Accès | Rôle |
|---|---|---|
| `POST /auth/login`, `/auth/2fa/login`, `/auth/refresh`, `/auth/logout` | public | Authentification |
| `GET /auth/me`, `POST /auth/change-password` | connecté | Profil, mot de passe |
| `POST /auth/2fa/setup`, `/2fa/enable`, `/2fa/disable` | connecté | Gestion 2FA |
| `GET /superadmin/dashboard`, `/modules`, `/audit` | Superadmin | Vue globale |
| `GET/POST /superadmin/tenants`, `PATCH /superadmin/tenants/:id` | Superadmin | Pharmacies (dont `timezone`, `maxSubsites`) ; `POST …/admin` avec `replace: true` attribue l'Admin à une autre personne |
| `GET/PUT /site/patient-access` | Gérant local | Accès de l'Admin du groupe aux dossiers patients de sa sous-pharmacie |
| `GET/POST /transferts`, `GET /transferts/sites`, `GET /transferts/:id`, `POST /transferts/:id/{send,cancel,receive,refuse,return}` | `stocks:read` / `stocks:transfer` | Transferts de stock entre pharmacies du groupe |
| `GET /groupe/transfers` | Admin du groupe | Transferts récents du groupe (lecture seule) |
| `GET/POST /groupe/sites`, `PATCH /groupe/sites/:id`, `GET /groupe/overview` | Admin du groupe | Sous-pharmacies (quota) et chiffres consolidés |
| `PUT /superadmin/tenants/:id/modules` | Superadmin | Activation des modules |
| `GET/POST /superadmin/tenants/:id/admin`, `POST …/admin/reset-password` | Superadmin | Admin local |
| `GET/POST /patients`, `GET/PATCH/DELETE /patients/:id` | `patients:read/write/delete` | Dossiers patients (DELETE = archivage) |
| `GET/POST /stocks/products`, `GET/PATCH /stocks/products/:id` | `stocks:read/write` | Catalogue et lots |
| `POST /stocks/receive`, `POST /stocks/adjust`, `GET /stocks/alerts` | `stocks:write` / `stocks:adjust` / `stocks:read` | Entrées, ajustements, alertes |
| `GET/POST /dispensation/prescriptions`, `GET …/:id` | `dispensation:read/write` | Ordonnances |
| `POST /dispensation/prescriptions/:id/validate` | `dispensation:validate` | Validation pharmacien (`acknowledgeAlerts` si alertes) |
| `POST /dispensation/prescriptions/:id/dispense`, `…/cancel` | `dispensation:write` | Délivrance (sortie FEFO), annulation |
| `GET /dispensation/lookup/patients`, `/lookup/products` | `dispensation:write` | Recherches minimales pour la saisie |
| `GET/POST /achats/suppliers`, `PATCH /achats/suppliers/:id`, `GET /achats/suggestions`, `GET /achats/lookup/products` | `achats:read/write` | Fournisseurs, suggestions |
| `GET/POST /achats/orders`, `GET /achats/orders/:id`, `POST …/receive`, `…/cancel` | `achats:read/write` | Commandes, réception |
| `POST /achats/orders/:id/send` | `achats:approve` | Envoi au fournisseur |
| `POST /ventes/sales`, `GET /ventes/lookup/products`, `GET /ventes/billable-prescriptions` | `ventes:write` | Encaissement |
| `GET /ventes/sales`, `GET /ventes/sales/:id` | `ventes:read` | Historique, ticket |
| `POST /ventes/sales/:id/refund` | `ventes:refund` | Retour client |
| `GET /rapports/overview?from&to` | `rapports:read` | Indicateurs |
| `GET /rapports/export/sales.csv?from&to` | `rapports:export` | Export CSV |
| `GET /rapports/export/report.xlsx?from&to` | `rapports:export` | Export Excel multi-feuilles |
| `GET /dispensation/substitutes`, `POST /dispensation/prescriptions/:id/items/:itemId/substitute`, `GET …/:id/labels` | `dispensation:write/read` | Substituts, étiquettes |
| `GET/POST /achats/orders/:id/invoices` | `achats:read/write` | Contrôle des factures |
| `GET /integrations/status`, `GET/POST/DELETE /integrations/interactions`, `…/classes`, `POST /integrations/import` | `integrations:read/write` | Base de référence |
| `POST /superadmin/reference/import` | Superadmin | Base globale |
| `GET /conformite/lot-trace?lotNumber=`, `GET /conformite/controlled-register(.csv)` | `conformite:read/export` | Rappel de lot, registre |
| `GET/PUT /crm/settings`, `GET /crm/loyalty/:patientId`, `POST …/adjust`, `GET/POST /crm/reminders…`, `GET/POST/PATCH /crm/interviews…` | `crm:read/write` | CRM, fidélité |
| `GET /ventes/lookup/patients` | `ventes:write` | Client fidélité à la caisse |
| `GET/POST/DELETE /rh/shifts`, `/rh/absences`, `GET /rh/staff`, `/rh/hours`, `/rh/time-entries`, `PATCH /rh/time-entries/:id` | `rh:read/write` | Planning, heures |
| `GET/POST /rh/clock` | tout employé (module RH activé) | Pointage personnel |
| `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-password`, `GET /users/catalog`, `GET /users/audit/logs` | Admin (`users:*`, `audit:read`) | Employés, audit |

## Sécurité en place / à prévoir
En place : bcrypt (coût 12), AES-256-GCM (secrets 2FA), JWT HS256 courts, jetons de refresh hachés, RLS, CORS strict, CSP stricte, Helmet, limitation de débit, redirection HTTPS en production, validation des entrées, requêtes paramétrées, audit.
Refresh token en **cookie HttpOnly** (SameSite=Strict, limité à `/api/auth`, Secure en production, cookie de session) : il n'est plus lisible par le JavaScript ni renvoyé dans le corps des réponses. À prévoir : limiteur de débit partagé (Redis) en multi-instance, sauvegardes chiffrées, QR code 2FA, chiffrement des données patients (Phase 2).
