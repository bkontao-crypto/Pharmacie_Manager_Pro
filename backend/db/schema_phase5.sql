-- Phase 5 : CRM & Fidélité, RH & Planning (idempotent)

ALTER TABLE products ADD COLUMN IF NOT EXISTS renewal_days int CHECK (renewal_days IS NULL OR renewal_days BETWEEN 1 AND 365);  -- cycle de renouvellement (rappels)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS redeemed_points int NOT NULL DEFAULT 0 CHECK (redeemed_points >= 0);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS redeem_amount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (redeem_amount >= 0);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS earned_points   int NOT NULL DEFAULT 0 CHECK (earned_points >= 0);

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  loyalty_enabled     boolean NOT NULL DEFAULT false,
  loyalty_earn_amount numeric(12,2) NOT NULL DEFAULT 1000 CHECK (loyalty_earn_amount > 0),   -- FCFA dépensés pour gagner 1 point
  loyalty_point_value numeric(12,2) NOT NULL DEFAULT 10 CHECK (loyalty_point_value > 0),     -- FCFA de remise par point utilisé
  reminder_lead_days  int NOT NULL DEFAULT 3 CHECK (reminder_lead_days BETWEEN 0 AND 30),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_ledger (          -- registre append-only : le solde = somme des lignes
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  points     int NOT NULL CHECK (points <> 0),
  reason     text NOT NULL,
  sale_id    uuid REFERENCES sales(id),
  user_id    uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_patient_idx ON loyalty_ledger (tenant_id, patient_id);

CREATE TABLE IF NOT EXISTS patient_reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id   uuid NOT NULL REFERENCES patients(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  last_on      date NOT NULL,                      -- dernière délivrance
  due_on       date NOT NULL,                      -- renouvellement attendu
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','contacted','done','dismissed')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  contacted_at timestamptz,
  updated_by   uuid,
  UNIQUE (tenant_id, patient_id, product_id, due_on)
);
CREATE INDEX IF NOT EXISTS reminders_idx ON patient_reminders (tenant_id, status, due_on);

CREATE TABLE IF NOT EXISTS pharma_interviews (       -- entretiens pharmaceutiques : contenu chiffré
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id     uuid NOT NULL REFERENCES patients(id),
  interview_on   date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('bilan_medication','asthme','anticoagulants','diabete','autre')),
  summary_enc    text NOT NULL,
  actions_enc    text,
  follow_up_on   date,
  follow_up_done boolean NOT NULL DEFAULT false,
  pharmacist_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interviews_idx ON pharma_interviews (tenant_id, patient_id, interview_on DESC);

CREATE TABLE IF NOT EXISTS staff_shifts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  shift_date date NOT NULL,
  start_time time NOT NULL,
  end_time   time NOT NULL,                        -- fin <= début : le créneau se termine le lendemain (garde de nuit)
  kind       text NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','garde','astreinte')),
  note       text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time <> end_time)
);
CREATE INDEX IF NOT EXISTS shifts_idx ON staff_shifts (tenant_id, shift_date, user_id);

CREATE TABLE IF NOT EXISTS staff_absences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  start_date date NOT NULL,
  end_date   date NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('conge','maladie','autre')),
  note       text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS absences_idx ON staff_absences (tenant_id, user_id, start_date);

CREATE TABLE IF NOT EXISTS time_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  clock_in   timestamptz NOT NULL DEFAULT now(),
  clock_out  timestamptz,
  note       text,
  CHECK (clock_out IS NULL OR clock_out > clock_in)
);
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_open_uq ON time_entries (tenant_id, user_id) WHERE clock_out IS NULL;   -- un seul pointage ouvert par personne
CREATE INDEX IF NOT EXISTS time_entries_idx ON time_entries (tenant_id, clock_in);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_settings','loyalty_ledger','patient_reminders','pharma_interviews','staff_shifts','staff_absences','time_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING      (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Le registre de fidélité est en ajout seul (comme l'audit) : on corrige par une ligne inverse, jamais par modification
CREATE OR REPLACE FUNCTION loyalty_ledger_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'loyalty_ledger est en ajout seul : % interdit', TG_OP; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS loyalty_ledger_no_change ON loyalty_ledger;
CREATE TRIGGER loyalty_ledger_no_change BEFORE UPDATE OR DELETE ON loyalty_ledger FOR EACH ROW EXECUTE FUNCTION loyalty_ledger_immutable();
