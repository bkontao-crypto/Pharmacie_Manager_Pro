#!/bin/sh
# Lance les tests d'intégration dans le conteneur, sur une base DÉDIÉE « pharmacie_test » (créée si absente).
# Usage (depuis la racine du projet, stack démarrée avec `docker compose up -d`) :  ./docker/run-integration-tests.sh
set -e
[ -f .env ] || { echo "Fichier .env introuvable (copiez .env.example)" >&2; exit 1; }
get() { grep "^$1=" .env | head -n1 | cut -d= -f2-; }
APP_PW=$(get PMP_APP_PASSWORD); OWNER_PW=$(get PMP_OWNER_PASSWORD); DB=pharmacie_test
docker compose exec -T db psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
  || docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB OWNER pmp_owner"
docker compose exec -T db psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 <<SQL
ALTER SCHEMA public OWNER TO pmp_owner;
GRANT USAGE ON SCHEMA public TO pmp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pmp_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pmp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pmp_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pmp_app;
SQL
docker compose exec -T \
  -e TEST_DATABASE_URL="postgresql://pmp_app:${APP_PW}@db:5432/${DB}" \
  -e TEST_MIGRATE_DATABASE_URL="postgresql://pmp_owner:${OWNER_PW}@db:5432/${DB}" \
  app node --test backend/tests/integration/api.test.js
