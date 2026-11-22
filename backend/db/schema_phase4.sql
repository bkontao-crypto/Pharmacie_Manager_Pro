-- Phase 4 : base de référence (interactions/classes), substitutions, factures fournisseurs, conformité (idempotent)

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_generic    boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_controlled boolean NOT NULL DEFAULT false;  -- stupéfiants / produits à registre
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS substituted_from uuid REFERENCES products(id);
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS ack_note text;                             -- justification écrite du pharmacien

-- Référence clinique : tenant_id NULL = base globale (gérée par le Superadmin), sinon règles propres à la pharmacie
CREATE TABLE IF NOT EXISTS drug_interactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,
  term_a         text NOT NULL,
  term_b         text NOT NULL,
  severity       text NOT NULL CHECK (severity IN ('contre_indication','association_deconseillee','precaution','a_prendre_en_compte')),
  description    text NOT NULL,
  recommendation text,
  source         text NOT NULL DEFAULT 'manuel',
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drug_interactions_terms_ordered CHECK (term_a COLLATE "C" <= term_b COLLATE "C")   -- ordre d'octets : identique au tri JavaScript, quelle que soit la locale de la base
);
-- bases déjà migrées avec l'ancienne contrainte (dépendante de la locale)
ALTER TABLE drug_interactions DROP CONSTRAINT IF EXISTS drug_interactions_check;
ALTER TABLE drug_interactions DROP CONSTRAINT IF EXISTS drug_interactions_terms_ordered;
ALTER TABLE drug_interactions ADD CONSTRAINT drug_interactions_terms_ordered CHECK (term_a COLLATE "C" <= term_b COLLATE "C");
CREATE UNIQUE INDEX IF NOT EXISTS drug_interactions_uq
  ON drug_interactions (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), term_a, term_b);

CREATE TABLE IF NOT EXISTS substance_classes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,
  substance  text NOT NULL,
  class      text NOT NULL,
  source     text NOT NULL DEFAULT 'manuel',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS substance_classes_uq
  ON substance_classes (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), substance, class);

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL REFERENCES purchase_orders(id),
  invoice_number text NOT NULL,
  invoice_date   date NOT NULL,
  total          numeric(12,2) NOT NULL DEFAULT 0,
  expected_total numeric(12,2) NOT NULL DEFAULT 0,   -- ce qui aurait dû être facturé (reçu × prix commandé)
  status         text NOT NULL CHECK (status IN ('conforme','ecart')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_id, invoice_number)
);
CREATE TABLE IF NOT EXISTS supplier_invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES purchase_order_items(id),
  quantity    int NOT NULL CHECK (quantity >= 0),
  unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  qty_gap     int NOT NULL DEFAULT 0,             -- facturé − reçu
  price_gap   numeric(12,2) NOT NULL DEFAULT 0    -- prix facturé − prix commandé
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['drug_interactions','substance_classes','supplier_invoices','supplier_invoice_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING      (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- la base globale (tenant_id NULL) est lisible par toutes les pharmacies, modifiable seulement en contexte système
DROP POLICY IF EXISTS global_read ON drug_interactions;
CREATE POLICY global_read ON drug_interactions FOR SELECT USING (tenant_id IS NULL);
DROP POLICY IF EXISTS global_read ON substance_classes;
CREATE POLICY global_read ON substance_classes FOR SELECT USING (tenant_id IS NULL);

-- Conformité : le journal d'audit devient append-only (aucune modification ni suppression, même par l'application)
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs est en ajout seul : % interdit', TG_OP; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_logs_no_change ON audit_logs;
CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
