#!/bin/sh
# Exécuté UNE fois à la création du volume PostgreSQL.
# pmp_owner : propriétaire du schéma (migrations). pmp_app : rôle de l'application — NON superuser, NON BYPASSRLS,
# uniquement lecture/écriture des données : il ne peut ni modifier le schéma ni contourner l'isolation entre pharmacies.
# Les mots de passe doivent être alphanumériques (ils sont insérés dans du SQL et dans des URL de connexion).
set -e
for v in PMP_OWNER_PASSWORD PMP_APP_PASSWORD; do
  eval val=\$$v
  case "$val" in ''|*[!A-Za-z0-9]*) echo "ERREUR : $v doit être non vide et alphanumérique (A-Z a-z 0-9)" >&2; exit 1;; esac
done
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE pmp_owner LOGIN PASSWORD '${PMP_OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE pmp_app   LOGIN PASSWORD '${PMP_APP_PASSWORD}'   NOSUPERUSER NOBYPASSRLS;
REVOKE CONNECT ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
GRANT  CONNECT ON DATABASE ${POSTGRES_DB} TO pmp_owner, pmp_app;
ALTER SCHEMA public OWNER TO pmp_owner;
GRANT USAGE ON SCHEMA public TO pmp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pmp_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pmp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pmp_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pmp_app;
SQL
