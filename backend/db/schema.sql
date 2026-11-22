-- Pharmacie Manager Pro — Schéma Phase 1 (idempotent)
-- Multi-tenant : isolation par tenant_id + Row-Level Security (RLS).
-- L'application positionne app.tenant_id / app.bypass_rls par transaction (voir src/db.js).
-- IMPORTANT : l'application doit se connecter avec un rôle NON superuser (un superuser contourne la RLS).

-- PostgreSQL ≥ 13 requis : gen_random_uuid() est natif (aucune extension, donc aucun droit superuser nécessaire).

CREATE TABLE IF NOT EXISTS tenants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  city               text,
  country            text NOT NULL DEFAULT 'ML',
  phone              text,
  email              text,
  plan               text NOT NULL DEFAULT 'starter',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','expired')),
  subscription_start date NOT NULL DEFAULT CURRENT_DATE,
  subscription_end   date,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modules (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  description text,
  is_core     boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tenant_modules (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key text NOT NULL REFERENCES modules(key),
  enabled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);

CREATE TABLE IF NOT EXISTS users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid REFERENCES tenants(id) ON DELETE CASCADE,
  email                text NOT NULL,
  full_name            text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('superadmin','admin','pharmacien','preparateur','caissier','personnalise')),
  permissions          text[] NOT NULL DEFAULT '{}',
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  totp_secret_enc      text,
  totp_enabled         boolean NOT NULL DEFAULT false,
  failed_attempts      int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT superadmin_has_no_tenant CHECK ((role = 'superadmin') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  ip         text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS refresh_user_idx ON refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid,
  user_id    uuid,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_tenant_idx ON audit_logs (tenant_id, created_at DESC);

-- ---------- Row-Level Security ----------
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          FORCE  ROW LEVEL SECURITY;
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_modules FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs     FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING      (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON tenant_modules;
CREATE POLICY tenant_isolation ON tenant_modules
  USING      (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING      (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
