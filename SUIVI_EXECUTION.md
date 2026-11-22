# SUIVI D'EXÉCUTION — Pharmacie Manager Pro
Dernière mise à jour : 2026-11-22 · Version : 0.9.1
Statuts : **terminé et vérifié** · **partiel** (livré, mais une partie non vérifiée) · **bloqué**. Un fichier de suivi n'est pas une preuve : vérifier le code et relancer les tests.

## Tâches
| Version | Tâche | Statut | Preuve / réserve |
|---|---|---|---|
| 0.6.4 | Fuseau horaire par pharmacie | partiel | Logique pure, interface et cohérence statique vérifiées. SQL (`app_today`, `app_date`, requêtes modifiées) jamais exécuté sur PostgreSQL. |
| 0.7.0 | Multi-sites : groupe, quota, Admin unique, gérant local, hiérarchie des rôles | partiel | Pharmacie de travail et rôles : tests unitaires + parcours navigateur. Schéma P7 (déclencheurs, CHECK du rôle), RLS et requêtes de `groupe.js` non exécutés. |
| 0.7.1 | Accès patients accordé par le gérant local | partiel | Règle pure testée, parcours navigateur. Route `site.js` non exécutée sur PostgreSQL. |
| 0.8.0 | Transferts de stock entre pharmacies du groupe | partiel | États, appariement, droits : tests unitaires et statiques. Schéma P8 (RLS, déclencheur) et `transferts.js` non exécutés. |
| 0.8.1 | Test navigateur (`e2e/`) + correction du pointage de l'Admin du groupe | terminé et vérifié (interface) | `npm run test:e2e` 2026-11-22 : 71/71. Refus serveur du pointage : non exécuté sur PostgreSQL. |
| 0.9.0 | Réception partielle des transferts | partiel | `planReceipt` testé (cas limites, clés piégées), parcours navigateur. Schéma P9 et routes non exécutés. |
| 0.9.1 | Dossiers de référence et directive d'agent | terminé et vérifié | Test de cohérence (présence, version, rubriques, règles métier conservées) validé par mutation. |
| 0.9.1 (doc) | `DIRECTIVE_AGENT.md` : démarrage de session, limite d'accès GitHub (PR n°1) | partiel | PR fusionnée (état renvoyé par GitHub). Contenu sur `main` non relu ; `npm test` non relancé après cette modification documentaire. |

## Bloqué
- **Exécution des tests d'intégration** (`npm run test:integration`) : pas de PostgreSQL dans l'environnement de l'assistant. À lancer chez vous (base de test dédiée) puis communiquer les échecs.

## Restant
- Recette manuelle R44 à R70 (`docs/RECETTE.md`).
- Confirmation ou correction des choix par défaut (`CAHIER_DES_CHARGES.md`, section B).
- Validation réglementaire : registre des produits contrôlés, données de santé.

## Preuves de test (2026-11-22, v0.9.1)
- `npm test` : 64 tests, 64 réussis, 0 échec.
- `npm run test:e2e` : 71/71 contrôles, 0 erreur JavaScript.
- Contrôles par mutation des garde-fous de sécurité : voir le détail par version dans `CHANGELOG.md`.
- `npm run test:integration` : **non exécuté**.
