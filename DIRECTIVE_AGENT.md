# DIRECTIVE PERMANENTE — optimisation des tokens et efficacité d'exécution
Adaptation au projet Pharmacie Manager Pro du guide « Économiser les tokens de son assistant IA ». Dernière mise à jour : 2026-11-22.

Travailler avec économie de tokens **sans sacrifier** la qualité, la sécurité, les tests ni les exigences métier validées.

## Démarrage de session (nouveau)
1. Le dépôt GitHub (`bkontao-crypto/Pharmacie_Manager_Pro`) est la référence. Lire `ETAT_ACTUEL.md` puis `SUIVI_EXECUTION.md`.
2. Comparer la version et la date indiquées avec `package.json` et l'en-tête de `CHANGELOG.md`. En cas d'écart : le signaler avant toute action, ne pas choisir arbitrairement.
3. Vérifier le mode d'accès au dépôt (lecture seule ou écriture) en le disant simplement, sans rien affirmer qui n'ait été testé.

## Sources, dans cet ordre
1. `ETAT_ACTUEL.md` puis `SUIVI_EXECUTION.md` (état documenté ; vérifier la date et la version, et ne rien supposer terminé sans preuve).
2. `CAHIER_DES_CHARGES.md` section A (décisions validées : **ne jamais les modifier sans demande explicite**).
3. `ARCHITECTURE_TECHNIQUE.md` (mécanismes, conventions, tests). En cas de contradiction entre documents : la signaler, ne pas choisir arbitrairement.

## Principes
- Périmètre exact de la tâche ; pas d'audit global si un audit récent existe et que le périmètre n'a pas changé ; ne pas redemander une information documentée.
- Lire par plages (`grep`, `sed -n`) uniquement les fichiers et dépendances nécessaires ; modifier de façon ciblée (remplacements scriptés avec assertion d'occurrence unique) ; jamais réécrire un fichier entier pour une petite correction.
- Regrouper les corrections de même nature ; réutiliser les composants et fonctions existants ; pas de rapport redondant.
- Ne jamais déclarer réussi ce qui n'a pas été exécuté. Ne jamais écrire « testé sur PostgreSQL » sans l'avoir fait.
- Changement destructif ou hors autorisation : s'arrêter et demander.

## Ne jamais optimiser
Les tests (`npm test`, `npm run test:e2e`, `npm run test:integration`), l'isolation par pharmacie (RLS, `ctx(req)`), les contrôles de droits et de hiérarchie, l'audit, les vérifications avant opération risquée, le contexte métier nécessaire.

## Commandes courtes
| Commande | Action |
|---|---|
| REPRENDRE | Lire `ETAT_ACTUEL.md` et reprendre au prochain travail non terminé. |
| CONTINUER | Exécuter la prochaine tâche prioritaire déjà définie. |
| CORRIGER | Traiter les anomalies indiquées, sans élargir le périmètre. |
| AUDITER [périmètre] | Examiner uniquement ce périmètre. |
| OPTIMISER [périmètre] | Améliorer sans changer les règles métier. |
| VALIDER [périmètre] | Lancer et documenter les tests pertinents (`npm test`, `e2e`, mutation des garde-fous touchés). |
| LIVRER | ZIP complet à jour, sans `node_modules`, `.env`, secrets ni caches ; version, `CHANGELOG.md`, `ETAT_ACTUEL.md`, `SUIVI_EXECUTION.md` actualisés. |

## Compte rendu court
INTERVENTION : [tâche] · Statut : [terminé et vérifié / partiel / bloqué] · Réalisé : [concret] · Fichiers modifiés : [liste courte] · Tests : [commandes réellement exécutées + résultat] · Points à surveiller : [aucun / détails] · Prochaine tâche : [action précise] · Suivi et état actuel : [mis à jour / non mis à jour, pourquoi].

## Fin de chaque intervention significative
Actualiser `ETAT_ACTUEL.md` (dernière tâche, changements, tests exécutés, problèmes non résolus, prochaine tâche précise) et `SUIVI_EXECUTION.md` ; ne recopier ni le cahier des charges ni l'historique complet.

## Limites connues de l'assistant
Pas de PostgreSQL dans son environnement ; aucun accès aux compteurs de tokens (mesure à faire côté utilisateur) ; les fichiers du projet Claude sont en lecture seule (la continuité passe par le dépôt GitHub ou le ZIP livré) ; ne peut pas modifier les instructions du projet Claude.
Accès GitHub : peut être en lecture seule (refus 403 constaté le 2026-11-22). Dans ce cas, l'assistant livre les fichiers modifiés à copier dans le dépôt et ne prétend jamais les y avoir poussés.

## Principe fondamental
Consommer le minimum de tokens nécessaire pour un résultat techniquement complet, vérifiable, maintenable et professionnel. La concision ne justifie jamais d'omettre une étape importante.
