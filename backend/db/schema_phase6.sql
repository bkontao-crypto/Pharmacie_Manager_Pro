-- Phase 6 : fuseau horaire par pharmacie (idempotent)
-- Les instants restent en timestamptz (UTC) ; tout « jour » se calcule dans le fuseau de la pharmacie.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';   -- nom IANA, validé par l'application (et par pg_timezone_names à l'enregistrement)

-- Le fuseau de la pharmacie courante est posé par l'application, pour la durée de la transaction (set_config(..., true)).
-- Hors contexte (réglage absent ou vide) : UTC, comme avant la 0.6.4.
CREATE OR REPLACE FUNCTION app_tz() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT COALESCE(NULLIF(current_setting('app.tz', true), ''), 'UTC') $$;

CREATE OR REPLACE FUNCTION app_today() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT (now() AT TIME ZONE app_tz())::date $$;

CREATE OR REPLACE FUNCTION app_date(ts timestamptz) RETURNS date LANGUAGE sql STABLE AS
$$ SELECT (ts AT TIME ZONE app_tz())::date $$;
