# Plan de recette — Pharmacie Manager Pro

Ce plan couvre ce que les tests automatisés **ne peuvent pas** prouver : usage réel, imprimantes, base clinique, réglementation locale, restauration, performance. Il est suivi dans l'onglet **Recette** du classeur `Suivi_Fonctionnalites_Pharmacie.xlsx` (statuts : À exécuter / Conforme / Non conforme / Bloqué).

**Ordre conseillé** : 1) `npm run test:integration` sur une base de test (voir `docs/DEPLOIEMENT.md`) → 2) ce plan sur une pharmacie de test → 3) mise en production seulement si tout est « Conforme » ou si les écarts sont acceptés par écrit par le pharmacien responsable.

La colonne « Auto » indique si la suite d'intégration couvre déjà tout ou partie du scénario (elle n'a pas encore été exécutée : ce n'est pas une preuve tant qu'elle n'a pas réussi).

| ID | Module | Scénario | Résultat attendu | Fonct. | Auto |
|---|---|---|---|---|---|
| R01 | Authentification | Connexion Superadmin avec le mot de passe initial, changement de mot de passe imposé, reconnexion. | Connexion refusée à toute autre page tant que le mot de passe n'est pas changé ; accès normal ensuite. | 1-3 | Oui |
| R02 | Authentification | 2FA avec une vraie application (Google Authenticator/Authy) : saisie manuelle de la clé, activation, connexion en deux étapes. | Code de l'application accepté ; mauvais code refusé ; connexion sans code impossible. | 2 | Partiel |
| R03 | Multi-pharmacies | Superadmin : créer une pharmacie, activer des modules, créer son Admin. | Mot de passe temporaire affiché une seule fois ; Admin forcé à le changer à la première connexion. | 6-8 | Oui |
| R04 | Multi-pharmacies | Désactiver un module pour une pharmacie en cours d'utilisation. | Le module disparaît du menu à l'actualisation et ses routes répondent « interdit » immédiatement. | 7 | Oui |
| R05 | Multi-pharmacies | Suspendre l'abonnement d'une pharmacie. | Les comptes de cette pharmacie ne peuvent plus utiliser l'application ; message clair. | 7 | Oui |
| R06 | Utilisateurs | Admin : créer un caissier, un préparateur, un pharmacien ; vérifier ce que chacun voit et peut faire. | Caissier sans Rapports/Employés ; préparateur ne peut pas valider ; pharmacien peut valider. | 10-11 | Partiel |
| R07 | Interface | Utiliser caisse, dispensation et stocks sur un vrai téléphone (écran étroit). | Menu utilisable, formulaires lisibles, aucune zone inaccessible. | 50 | Non |
| R08 | Interface | Navigation au clavier seule sur la caisse et la dispensation ; contrôle rapide avec un lecteur d'écran. | Tous les champs et boutons atteignables, focus visible, étiquettes présentes. | 50 | Non |
| R09 | Patients | Créer, modifier, archiver un patient ; rechercher par nom et téléphone ; saisir des allergies. | Dossier retrouvé ; archivé = absent des listes mais présent dans l'historique. | 12-15 | Partiel |
| R10 | Stocks | Créer un produit, réceptionner deux lots, consulter les alertes de rupture, de stock bas et de péremption. | Alertes cohérentes avec les seuils et dates saisis. | 22-24 | Partiel |
| R11 | Stocks | Ajuster un lot avec motif ; vérifier le mouvement et le journal d'audit. | Mouvement signé visible ; ajustement sans motif impossible. | 26 | Partiel |
| R12 | Dispensation | Parcours complet : saisie → validation → délivrance. | Stock décrémenté sur le lot qui périme en premier ; ordonnance non délivrable deux fois. | 16,20 | Oui |
| R13 | Dispensation | Ordonnance avec allergie déclarée : tenter de valider. | Validation impossible sans justification écrite ; justification retrouvée dans le journal d'audit. | 14,20 | Oui |
| R14 | Clinique | Avec la base d'interactions RÉELLE chargée : rejouer au moins 20 cas fournis par le pharmacien responsable (dont cas dangereux connus). | Tous les cas dangereux sont signalés avec la bonne gravité. Aucun faux négatif toléré sur les cas de référence. | 18,46 | Non |
| R15 | Clinique | Prescrire un produit sans DCI ; consulter l'écran Intégrations. | Message « non contrôlable » dans l'ordonnance ; compteur de produits sans DCI correct. | 18,46 | Partiel |
| R16 | Clinique | Substituer un produit par un équivalent ; tenter un non-équivalent. | Équivalent accepté et tracé ; non-équivalent refusé ; alertes recalculées. | 19 | Oui |
| R17 | Dispensation | Imprimer les étiquettes de posologie sur l'imprimante réelle de la pharmacie. | Contenu complet, lisible, format adapté (sinon : demander un format dédié). | 21 | Non |
| R18 | Achats | Suggestions automatiques → brouillon → envoi → réception partielle → réception du reste. | Quantités proposées conformes aux seuils ; manquants suivis ; stock mis à jour. | 27-30 | Oui |
| R19 | Achats | Saisir une facture fournisseur avec un prix supérieur à la commande. | Écart signalé avec le bon montant (« on vous facture X de plus »). | 31 | Oui |
| R20 | Caisse | Vente comptoir avec remise et deux moyens de paiement ; calcul de la monnaie ; impression du ticket. | Total exact au centime ; ticket complet sur l'imprimante réelle. | 32-35 | Partiel |
| R21 | Caisse | Facturer une ordonnance déjà délivrée. | Aucune seconde sortie de stock ; ordonnance non refacturable. | 32,33 | Oui |
| R22 | Caisse | Retour client d'une vente comptoir. | Remboursement tracé ; stock remis sur le bon lot. | 36 | Oui |
| R23 | Caisse | Deux postes vendent simultanément la dernière unité. | Un seul encaissement réussit, l'autre est refusé proprement. | 32 | Oui |
| R24 | Rapports | Comparer CA, marge et panier moyen du jour avec un calcul manuel sur 10 ventes. | Écart nul ou expliqué. | 37-38 | Partiel |
| R25 | Rapports | Ouvrir l'export CSV dans Excel (version française). | Accents corrects, colonnes séparées, aucune formule exécutée, aucun nom de patient. | 39 | Partiel |
| R26 | Conformité | Rappel d'un lot réel : comparer avec les ordonnances et ventes connues. | Liste des patients à contacter exacte et complète. | 49 | Partiel |
| R27 | Conformité | Registre des produits contrôlés : comparer les soldes avec un inventaire physique ; faire valider le format par le pharmacien responsable. | Soldes concordants ; format conforme à la réglementation locale. | 49 | Partiel |
| R28 | Sécurité | Isolation : deux pharmacies de test, vérifier qu'aucune donnée de l'une n'apparaît chez l'autre (écrans, recherches, exports). | Aucune fuite. | 6,49 | Oui |
| R29 | Sécurité | Journal d'audit : actions sensibles visibles ; un administrateur de base tente de supprimer/modifier une ligne. | Suppression et modification refusées par la base. | 4,49 | Oui |
| R30 | Sécurité | HTTPS : accès HTTP, certificat, en-têtes de sécurité (scan externe). | Redirection vers HTTPS ; certificat valide ; pas d'alerte majeure. | 5 | Non |
| R31 | Sauvegarde | Lancer une sauvegarde manuelle puis `npm run backup:verify`. | Fichier créé, vérification « intacte », copie distante présente. | 48 | Partiel |
| R32 | Sauvegarde | RESTAURER la dernière sauvegarde sur une base vide ; se connecter et contrôler des données. | Données retrouvées, application fonctionnelle ; temps de restauration noté. | 48 | Non |
| R33 | PWA | Installer l'application (téléphone et PC) ; couper le réseau. | Icône correcte ; message « hors connexion » ; aucune donnée patient visible hors connexion. | 52 | Partiel |
| R34 | Performance | Charger 5 000 produits et 20 000 lots ; chercher, vendre, ouvrir le tableau de bord. | Recherche en moins d'une seconde ; caisse fluide ; pas d'erreur. | 22-38 | Non |
| R35 | Mise en production | Supprimer les comptes et données de test ; changer tous les mots de passe ; activer la 2FA des Admins. | Aucun compte de test ; 2FA active pour Superadmin et Admins. | 1-3 | Non |
| R36 | Fidélité | Activer la fidélité ; vendre 5 000 FCFA à un client ; vérifier les points ; utiliser des points sur une 2e vente ; vérifier le ticket. | Points gagnés sur le montant payé ; remise exacte au centime ; ticket indique les points utilisés. | 43 | Oui |
| R37 | Fidélité | Rembourser une vente où des points ont été utilisés et gagnés. | Points restitués et points gagnés annulés ; solde cohérent. | 43 | Oui |
| R38 | Fidélité | Deux caisses utilisent simultanément les mêmes points d'un client. | Une seule réussit ; solde jamais négatif. | 43 | Oui |
| R39 | CRM | Définir un cycle de 30 jours sur un produit chronique ; délivrer ; actualiser les rappels après échéance ; appeler/envoyer un SMS depuis un téléphone. | Rappel apparu à l'échéance ; l'appli SMS s'ouvre avec un message sans nom de médicament ; rappel clos quand le patient revient. | 44 | Partiel |
| R40 | CRM | Créer un entretien pharmaceutique avec suivi ; relire ; vérifier la liste et le journal d'audit. | Contenu absent des listes, lisible à l'ouverture, ouverture tracée ; suivi apparaît 14 jours avant. | 45 | Oui |
| R41 | RH | Construire le planning d'une semaine réelle avec une garde de nuit et une absence. | Chevauchements et créneaux sur absence refusés ; grille lisible sur écran et mobile. | 41 | Partiel |
| R42 | RH | Chaque employé pointe arrivée/départ depuis son compte ; un responsable corrige un oubli ; comparer heures pointées/planifiées. | Pointage sans droit RH ; correction motivée et tracée ; totaux exacts. | 42 | Partiel |
| R43 | RH | Faire valider les règles de calcul d'heures et de gardes par la personne en charge de la paie / le droit du travail local. | Règles confirmées par écrit (l'outil ne calcule ni heures supplémentaires ni paie). | 41,42 | Non |
| R44 | Fuseau | Pharmacie réglée sur un fuseau en avance sur UTC (ex. `Africa/Douala`, UTC+1) : enregistrer une vente entre 00 h 00 et 01 h 00 heure locale ; ouvrir Rapports (période du jour) et l'historique de caisse du jour. | La vente est dans le jour LOCAL (rapport, historique, export) et pas dans la veille. | — | Non |
| R45 | Fuseau | Téléphone ou PC réglé sur un AUTRE fuseau que celui de la pharmacie : pointer l'arrivée, ouvrir un ticket de vente, la liste des pointages. | Heures affichées = heure de la pharmacie, identiques sur tous les appareils. | — | Non |
| R46 | Fuseau | Corriger un pointage (saisir 08:00) puis relire ; passer l'heure d'été/d'hiver si le pays en a (ex. `Europe/Paris`). | La valeur relue est 08:00 ; heures travaillées exactes ; audit avant/après cohérent. | — | Partiel |
| R47 | Fuseau | Changer le fuseau d'une pharmacie (Gérer) ; recharger un rapport déjà consulté ; exporter CSV et Excel. | Effet immédiat sans reconnexion ; rapports recalculés ; colonne « Date (heure locale) » cohérente avec l'écran. | — | Partiel |
| R48 | Fuseau | Réceptionner un lot dont la péremption est le jour LOCAL (accepté) puis la veille locale (refusé) ; vérifier l'alerte « périmé » à minuit local. | Bascule « périmé » à minuit heure de la pharmacie, pas à minuit UTC. | — | Non |
| R49 | Multi-sites | Superadmin : créer une pharmacie avec 2 sous-pharmacies autorisées et son Admin ; l'Admin ouvre 2 sous-pharmacies puis tente une 3e. | 3e refusée (« Quota atteint ») ; liste « Mes pharmacies » 2/2, 0 place. Quota non réductible sous le nombre ouvert. | — | Partiel |
| R50 | Multi-sites | Admin du groupe : désigner un gérant dans la sous-pharmacie A ; le gérant se connecte. | Il ne voit que A (aucun sélecteur, aucune « Mes pharmacies »), en-tête `X-Pharmacy-Id` vers B ou la principale refusé. | — | Partiel |
| R51 | Rôles | Gérant : créer un caissier ; tenter de créer un gérant, un Admin, ou d'accorder « utilisateurs » ; tenter de promouvoir le caissier gérant. | Caissier créé ; les autres tentatives refusées. Un caissier n'a pas accès aux comptes. | — | Partiel |
| R52 | Patients | Admin du groupe : ouvrir A ; consulter Patients, Dispensation, CRM, Ventes (liste), rappel de lot. | Modules patients/dispensation/CRM absents ; encaissement absent ; ventes sans nom de patient ; rappel de lot sans nom ni téléphone. | — | Partiel |
| R53 | Patients | Le gérant local de A (menu « Accès du groupe ») accorde l'accès puis le retire ; l'Admin du groupe retente d'ouvrir les dossiers de A. | Accès à A immédiat puis retiré immédiatement ; B toujours fermée ; octrois/retraits et actions de l'Admin du groupe tracés dans l'audit de A. | — | Partiel |
| R59 | Patients | Tenter de s'accorder l'accès : Admin du groupe (dans A ou depuis la principale), Superadmin, employé de A, gérant d'une autre pharmacie. | Tous refusés ; seul un gérant de A y parvient. | — | Oui |
| R54 | Isolation | Admin d'une pharmacie ordinaire / d'un autre groupe : tenter d'ouvrir A (en-tête). | Refus identique à une pharmacie inexistante. | — | Oui |
| R55 | Groupe | « Vue du groupe » sur 30 jours avec des ventes dans la principale et dans A (fuseaux différents). | Une ligne par pharmacie + total ; jours calculés dans le fuseau de chaque pharmacie ; pharmacie sans module Rapports signalée. | — | Partiel |
| R56 | Abonnement | Suspendre la principale ; tester la connexion du gérant de A et de l'Admin du groupe ; réactiver. | Tous bloqués (abonnement inactif) puis rétablis. | — | Oui |
| R57 | Admin unique | Superadmin : « Attribuer à une autre personne » sur l'Admin du groupe. | Ancien Admin déconnecté et désactivé ; un seul Admin actif ; le nouveau voit le groupe. | — | Oui |
| R58 | Base | Tenter (SQL) une 3e sous-pharmacie hors quota, une sous-sous-pharmacie, un quota inférieur à l'existant. | Refus par la base elle-même. | — | Oui |
| R60 | Transferts | Pharmacie A : lots L1 (10, péremption proche) et L2 (20) ; créer un transfert de 15 vers B, l'expédier. | A : L1 = 0, L2 = 15 (ordre de péremption). B voit le transfert « en transit » avec les lots ; le brouillon n'était pas visible de B. | — | Partiel |
| R61 | Transferts | B réceptionne (produit absent de son catalogue). | Produit créé chez B (attributs et prix repris), lots L1 = 10, L2 = 5 avec leurs péremptions ; A inchangée ; mouvements `transfert sortant/entrant` visibles. | — | Partiel |
| R62 | Transferts | Second transfert du même produit vers B. | Produit reconnu par code-barres (aucune création), lots cumulés. | — | Partiel |
| R63 | Transferts | B refuse avec motif ; A reprend. Puis A annule un envoi en transit. | Stock de A rétabli sur les lots d'origine dans les deux cas ; statuts « Refusé » puis « Repris », « Annulé ». | — | Partiel |
| R64 | Transferts | Transfert supérieur au stock ; produit stupéfiant ; destinataire d'un autre groupe ou sans module Stocks. | Refus clairs, aucun mouvement de stock partiel. | — | Partiel |
| R65 | Transferts | Employé sans droit « transfert » ; expéditeur qui tente de réceptionner ; destinataire qui tente d'annuler. | Refusés. Lecture de la liste autorisée avec le droit stocks:read. | — | Oui |
| R66 | Transferts | Admin du groupe : « Vue du groupe ». | Transferts récents du groupe listés (lecture seule). | — | Oui |
| R67 | Multi-sites | Admin du groupe : pointer son arrivée dans sa pharmacie ; ouvrir une sous-pharmacie. | Le bouton de pointage n'apparaît plus dans la sous-pharmacie (et l'API refuse). Aucun pointage créé dans la sous-pharmacie. | — | Oui |
| R68 | Transferts | Transfert de 8 unités d'un lot ; le destinataire saisit 5 reçues et réceptionne. | Statut « Reçu partiellement — écart à reprendre » ; stock du destinataire +5 ; stock de l'expéditrice reste réduit de 8 ; écart de 3 visible des deux côtés. | — | Partiel |
| R69 | Transferts | L'expéditrice clique « Reprendre l'écart ». | Stock de l'expéditrice +3 sur le lot d'origine ; transfert « Reçu » ; second clic impossible ; mouvement « Retour de transfert ». | — | Partiel |
| R70 | Transferts | Saisies incohérentes : quantité supérieure à l'expédié, négative, décimale, toutes à 0. | Refus clair, rien n'est déplacé ; pour « rien reçu », message invitant à refuser le transfert. | — | Oui |

## Critères d'acceptation minimaux avant données réelles
- Tous les cas « Sécurité », « Sauvegarde », « Clinique » et « Conformité » : **Conforme** (aucune dérogation).
- Aucun cas « Non conforme » ou « Bloqué » ouvert sur Dispensation, Caisse ou Stocks.
- Compte rendu signé par le pharmacien responsable.
