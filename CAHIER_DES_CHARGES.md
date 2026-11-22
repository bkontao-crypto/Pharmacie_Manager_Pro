# CAHIER DES CHARGES — Pharmacie Manager Pro
Dernière mise à jour : 2026-11-22 · Version du logiciel : 0.9.1

**Objectif** : système de gestion d'officine multi-tenant (SaaS), Node.js + Express + PostgreSQL, frontend sans framework. Isolation stricte entre pharmacies, droits par rôle et par module, traçabilité (audit), données de santé protégées.
**Source d'origine** : `Ordonnance_Gestion_Pharmacie.docx` et `Suivi_Fonctionnalites_Pharmacie.xlsx` (cités par le README ; non fournis à l'assistant dans les sessions récentes : à consulter en cas de doute). Ce fichier consigne ce qui est implémenté et les décisions prises en cours de travail.
**Règle** : une décision de la section A ne se modifie qu'à votre demande explicite.

## A. Décisions validées par vous (conversation de travail)
1. **Un site = une pharmacie** (ou « site pharmacie »).
2. **Fuseau horaire propre à chaque pharmacie** (v0.6.4).
3. **Pharmacie multi-sites** : elle peut avoir plusieurs sous-pharmacies, leur nombre étant choisi à l'ouverture ; un **compte administrateur local unique, attribuable** à une autre personne.
4. L'admin local crée des comptes et **désigne un gérant local** ; le **gérant local ne voit que la pharmacie à laquelle il est attribué**, crée des employés et leur attribue des rôles **inférieurs au sien**. Une sous-pharmacie peut avoir **plusieurs gérants**.
5. Une sous-pharmacie **suit l'abonnement et les modules de la principale** ; elle **n'a pas d'Admin propre** (administrée par l'Admin du groupe).
6. **Dossiers patients fermés par défaut à l'Admin du groupe** ; l'accès est accordé **uniquement par le gérant local de la sous-pharmacie lui-même** (ni le Superadmin, ni l'Admin du groupe).
7. **Transferts de stock entre pharmacies du groupe** (v0.8.0) : fonctionnalité acceptée ; les modalités de la section B sont des choix par défaut.
8. **Directive permanente de travail** : guide d'optimisation des tokens (`DIRECTIVE_AGENT.md`) ; ne jamais réduire tests ni sécurité ; ne jamais prétendre une vérification non faite.

## B. Choix par défaut de l'assistant — à confirmer ou corriger
- Transferts : produits à registre (stupéfiants) **non transférables** ; réception en **un seul passage** (écart repris ensuite par l'expéditrice) ; un transfert **reçu ne s'annule pas** ; stock en transit **non compté** chez l'un ni l'autre ; lot périmé pendant le transit : réception bloquée (à refuser) ; droit `stocks:transfer` par défaut pour Admin, gérant, pharmacien.
- Accès patients : plusieurs gérants d'une même sous-pharmacie peuvent l'accorder ou le retirer ; sans accès, l'Admin du groupe perd patients, dispensation, CRM, encaissement et remboursement (ventes lisibles sans nom de patient).
- Hiérarchie : Admin > Gérant > Pharmacien / Préparateur / Caissier / Personnalisé (ces quatre au même rang) ; le gérant n'a pas accès au journal d'audit.
- Sous-pharmacie : sa date de fin d'abonnement propre est ignorée (celle de la principale s'applique) ; le tableau de bord Superadmin compte les sous-pharmacies comme des pharmacies et reste en UTC.
- Pointage : personnel ; refusé à l'Admin du groupe qui travaille dans une sous-pharmacie.

## C. Hors périmètre / non réalisé / à valider
Patients partagés entre sites (non lancé : à l'opposé du choix A6) · e-prescription · API grossistes · envoi automatique de SMS/e-mails · heures supplémentaires et paie · parts tiers-payant et télétransmission · base médicamenteuse réelle (non livrée) · format officiel du registre des produits contrôlés et réglementation locale des données de santé : **à faire valider** (juriste / pharmacien responsable).

# Annexe — fonctionnalités et règles métier par phase (reprises telles quelles du README)

### Contenu de la Phase 1
- Connexion JWT (accès 15 min + refresh à rotation et détection de réutilisation), verrouillage après 5 échecs
- 2FA TOTP (Google Authenticator, Authy…)
- Superadmin : pharmacies, abonnements (statut, fin), activation progressive des modules, création du 1er Admin, tableau de bord global
- Admin local : employés (création, rôles, permissions fines, désactivation, réinitialisation mot de passe) dans la limite des modules activés
- Journal d'audit, isolation multi-tenant par Row-Level Security PostgreSQL, interface responsive navy/vert

### Contenu de la Phase 2
- **Patients** : dossiers (identité, assurance, allergies, contre-indications), recherche, archivage, historique des ordonnances ; n° d'assuré et notes chiffrés (AES-256-GCM) ; chaque ouverture de dossier est journalisée.
- **Stocks & Inventaire** : catalogue produits (DCI, code-barres, seuils, prix), lots avec péremption, réception, ajustement avec motif obligatoire, mouvements tracés, alertes (rupture, stock bas, péremption proche/périmé).
- **Dispensation** : saisie d'ordonnance → validation par un pharmacien (`dispensation:validate`) → délivrance avec sortie de stock **FEFO** (lot qui périme en premier, lots périmés exclus) dans une transaction verrouillée. Alerte d'allergie (nom/DCI) à acquitter explicitement avant validation.
- La dispensation exige les modules Patients **et** Stocks activés pour la pharmacie.
- Limites assumées : pas d'interactions médicamenteuses ni de classes thérapeutiques (Phase 4), pas d'OCR, pas d'impression d'étiquettes.

### Contenu de la Phase 3
- **Achats & Fournisseurs** : fournisseurs, commandes (brouillon → envoyée → reçue/partielle), suggestions automatiques (seuils min/max, déjà-commandé déduit), réception avec lot et péremption, suivi des manquants. L'envoi d'une commande exige `achats:approve`.
- **Ventes & Caisse** : vente comptoir (sortie de stock FEFO) ou facturation d'une ordonnance délivrée (le stock est déjà sorti), remise en %, paiements multiples (espèces, mobile money, carte, tiers-payant) dont le total doit égaler exactement le net à payer (calcul en centimes entiers), ticket imprimable, retour client avec remise en stock sur le lot d'origine (`ventes:refund`). Les produits « sur ordonnance » sont refusés en vente comptoir.
- **Rapports & Pilotage** : CA, ventes, panier moyen, marge brute (sur le coût d'achat figé à la vente), remises, remboursements, valeur du stock, graphique journalier, top produits, moyens de paiement, opérateurs ; export CSV (`;`, UTF-8, protégé contre l'injection de formules, sans nom de patient), **export Excel (.xlsx)** multi-feuilles (synthèse, par jour, paiements, top produits, opérateurs, ventes) et **impression / PDF** de la page via le navigateur.
- Achats et Caisse exigent le module Stocks. Dates et heures : **fuseau horaire propre à chaque pharmacie** (nom IANA, réglé par le Superadmin ; UTC par défaut) — voir « Fuseaux horaires ».
- Limites assumées : pas de calcul de parts tiers-payant ni de télétransmission, pas de scan/OCR de bons de livraison, pas de contrôle de factures fournisseurs, export Excel natif/PDF à venir.

### Contenu de la Phase 4
- **Contrôles cliniques** : allergies (nom, DCI **et classes** : « pénicillines » ⇒ amoxicilline) et interactions (entre produits prescrits **et avec les traitements des 60 derniers jours** du patient), 4 niveaux de gravité. Pour valider une ordonnance avec une alerte grave, le pharmacien doit saisir une **justification écrite**, conservée et tracée. Les produits sans DCI sont signalés (non contrôlables), ainsi que l'absence de base chargée.
- **Base de référence (module Intégrations)** : règles et classes importables en JSON/CSV, propres à la pharmacie ou **globales** (`npm run import-reference -- fichier.json`, ou `POST /api/superadmin/reference/import`).
  ⚠ **Aucune base médicamenteuse réelle n'est livrée.** `backend/data/reference.sample.json` est un jeu d'EXEMPLE non validé, uniquement pour tester : ne l'utilisez pas comme source clinique. Chargez une base reconnue dont vous avez la licence et faites-la valider par un pharmacien responsable.
- **Substitutions** : équivalents stricts (mêmes substances, dosage, forme), revérifiés côté serveur ; produit d'origine conservé.
- **Étiquettes de posologie** (impression navigateur) après validation.
- **Factures fournisseurs** : rapprochement avec la commande (prix) et la réception (quantités), écarts chiffrés.
- **Conformité** : rappel de lot (mouvements, patients à contacter), registre des produits contrôlés avec soldes (+ export CSV), journal d'audit **en ajout seul** (trigger SQL). Le format officiel du registre dépend de la réglementation locale : à valider.
- **Sauvegardes chiffrées** (AES-256-GCM, vérifiées, rotation, copie distante configurable) : `npm run backup`, `npm run backup:verify -- fichier`, `npm run restore -- fichier --yes`. Clé `BACKUP_ENCRYPTION_KEY` distincte, **conservée hors du serveur**. Planifiez avec cron (exemple dans `backend/scripts/backup.js`) et **testez régulièrement une restauration** sur une base vide.
- **PWA** : installable, coquille hors ligne. Le service worker ne met **jamais** en cache les réponses `/api/*` (données de santé).
- Reporté en Phase 5 : e-prescription, RH/planning, CRM/fidélité, API grossistes, multi-sites.

### Contenu de la Phase 5
- **Fidélité** (activable par pharmacie) : points gagnés sur le montant réellement payé, utilisés en remise à la caisse (la vente reste toujours payable), remboursement symétrique, registre **en ajout seul**, correction manuelle motivée et tracée. Deux caisses ne peuvent pas dépenser les mêmes points (verrou sur le patient).
- **Rappels de renouvellement** : cycle en jours par produit (fiche produit) → liste d'appels avec liens `tel:`/`sms:`. **Aucun envoi automatique** (il faudrait un fournisseur SMS/e-mail) ; le SMS ne contient aucun nom de médicament. Un rappel se clôt tout seul quand le patient revient.
- **Entretiens pharmaceutiques** : compte rendu et actions chiffrés, absents des listes, ouverture tracée, suivis à venir.
- **RH & Planning** : planning hebdomadaire (normal, garde, astreinte, garde de nuit), chevauchements refusés, absences, pointage arrivée/départ **par chaque employé** (sans droit RH), heures pointées vs planifiées, correction motivée et tracée. L'outil ne calcule ni heures supplémentaires ni paie.
- Reste non réalisé : e-prescription (aucun standard national identifié), API grossistes, multi-sites.

### Pharmacies multi-sites (0.7.0)
Un **site = une pharmacie**. Le Superadmin ouvre une pharmacie « multi-sites » en fixant le **nombre de sous-pharmacies** autorisées (0 = pharmacie simple) et son **Admin unique** (attribuable à une autre personne : l'ancien compte est alors désactivé).
- **Admin du groupe** (Admin de la pharmacie principale) : « Mes pharmacies » (ouvrir une sous-pharmacie dans la limite du quota, modifier ses coordonnées et son fuseau, **désigner son gérant local**), « Vue du groupe » (chiffres consolidés, chaque pharmacie calculant ses jours dans son fuseau) et un sélecteur pour **travailler dans une sous-pharmacie** (droits, modules et fuseau de cette pharmacie).
- **Gérant local** (nouveau rôle) : ne voit que sa pharmacie ; crée des employés et leur attribue des rôles **strictement inférieurs** au sien (pas d'autre gérant, pas d'Admin), sans pouvoir leur déléguer la gestion des comptes ; pas d'accès au journal d'audit.
- **Hiérarchie** : Admin > Gérant > Pharmacien / Préparateur / Caissier / Personnalisé. On ne crée, modifie ni réinitialise que des comptes de rang inférieur.
- **Dossiers patients fermés par défaut à l'Admin du groupe** : dans une sous-pharmacie, il perd patients, dispensation, CRM et l'encaissement (pilotage seulement : ventes lisibles sans nom de patient, rappels de lots sans identité). Le **gérant local de chaque sous-pharmacie** accorde (et retire) lui-même cet accès (page « Accès du groupe » ; ni le Superadmin ni l'Admin du groupe ne peuvent le faire) ; le retrait est immédiat, chaque octroi et chaque retrait sont audités, et les actions de l'Admin du groupe sont marquées « via l'Admin du groupe » dans l'audit.
- Une sous-pharmacie reprend les modules de la principale (jamais davantage : modules = les siens ∩ ceux de la principale) et suit son abonnement : suspendre ou laisser expirer la principale bloque aussi ses sous-pharmacies.
- Isolation inchangée : la RLS par pharmacie n'a pas été modifiée ; l'Admin du groupe travaille dans UNE sous-pharmacie à la fois, après vérification serveur du lien parent/enfant (`X-Pharmacy-Id`).
- Hors périmètre : patients partagés entre sites.

### Transferts de stock entre pharmacies du groupe (0.8.0)
Entre pharmacies **d'un même groupe** (principale + sous-pharmacies), en deux temps, avec le droit `stocks:transfer` (Admin, gérant, pharmacien ; délégable à la carte) :
1. **Brouillon** (menu « Transferts de stock ») : destinataire + produits + quantités ; rien n'est réservé ni déplacé, le destinataire ne le voit pas.
2. **Expédition** par l'expéditrice : le stock sort **dans l'ordre de péremption (FEFO)**, les lots expédiés (n° de lot, péremption, quantité) sont figés ; tout ou rien si le stock est insuffisant.
3. **Réception** par le destinataire, **lot par lot** (quantité reçue préremplie avec l'expédié) : mêmes n° de lot et péremptions entrent dans son stock, pour les quantités réellement reçues. Le produit est reconnu par **code-barres**, sinon par nom + forme + dosage ; absent, il est **créé** dans son catalogue (attributs et prix repris) ; plusieurs candidats : réception bloquée (jamais de choix silencieux).
4. **Écart** : si moins que prévu est reçu, le transfert passe à « Reçu partiellement — écart à reprendre » ; l'écart reste hors stock (en transit) jusqu'à ce que l'expéditrice le **reprenne** sur ses lots d'origine, ce qui solde le transfert. Rien reçu du tout : le transfert se refuse.
5. **Annulation** (expéditrice, brouillon ou en transit : stock repris sur les lots d'origine) ; **refus** (destinataire, avec motif) puis **reprise** par l'expéditrice. Un transfert reçu ne s'annule pas.
Les **produits à registre (stupéfiants) ne sont pas transférables** ici. Chaque côté agit dans sa propre transaction et son contexte d'isolation ; la base refuse tout transfert hors groupe ; mouvements `transfer_out` / `transfer_in` / `transfer_return` et audit à chaque étape. L'Admin du groupe voit les transferts récents sous « Vue du groupe ».

### Fuseaux horaires (0.6.4)
Chaque pharmacie a un fuseau (`tenants.timezone`, ex. `Africa/Bamako`, `Africa/Douala`), réglé par le Superadmin à la création ou dans « Gérer ». Les instants restent stockés en UTC ; tout **« jour »** (rapports, historique de caisse, registre des contrôlés, pointage, péremption, abonnement, « aujourd'hui » dans l'interface) se calcule dans le fuseau de la pharmacie, et les heures s'affichent et se saisissent dans ce fuseau, quel que soit le réglage de l'appareil. Côté SQL : `app_today()` / `app_date(horodatage)` lisent le fuseau posé par `tx()` pour la durée de la transaction.
À savoir : les pharmacies existantes passent en `UTC` à la migration (comme avant) — **renseignez leur fuseau** ; changer le fuseau recalcule les rapports passés avec le nouveau fuseau ; le tableau de bord Superadmin reste en UTC ; les exports CSV/Excel indiquent l'heure locale (colonne « Date (heure locale) »).

### Modèle d'accès
1. Le **Superadmin** crée une pharmacie, active ses modules, puis crée son **Admin** (mot de passe temporaire affiché une seule fois ; changement forcé à la 1re connexion).
2. L'**Admin** crée les employés. Droits effectifs = (rôle ∪ permissions accordées) ∩ modules activés. Un Admin ne peut accorder que des droits qu'il possède ; les droits « utilisateurs/audit » restent réservés à l'Admin.
3. Désactiver un module ou suspendre un abonnement prend effet à la requête suivante.

