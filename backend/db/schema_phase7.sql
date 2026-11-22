-- Phase 7 : pharmacies multi-sites (groupe = pharmacie principale + sous-pharmacies) et rôle « gérant local » (idempotent)
-- Un site = une pharmacie (tenant). L'isolation par pharmacie (RLS) NE CHANGE PAS : l'Admin du groupe travaille dans UNE
-- sous-pharmacie à la fois (contexte posé par l'application après vérification du lien parent/enfant).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES tenants(id);                 -- pharmacie principale (NULL pour une pharmacie principale ou seule)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_subsites int NOT NULL DEFAULT 0;                   -- nombre de sous-pharmacies autorisées (0 = pharmacie simple)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS group_patient_access boolean NOT NULL DEFAULT false;   -- accès de l'Admin du groupe aux dossiers patients de CETTE sous-pharmacie (accordé par le gérant local)
CREATE INDEX IF NOT EXISTS tenants_parent_idx ON tenants (parent_id);

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_group_shape;
ALTER TABLE tenants ADD CONSTRAINT tenants_group_shape CHECK (
  max_subsites BETWEEN 0 AND 100
  AND (parent_id IS NULL OR (max_subsites = 0 AND parent_id <> id))     -- une sous-pharmacie n'a pas de sous-pharmacies
  AND (parent_id IS NOT NULL OR NOT group_patient_access)               -- l'accès patients ne concerne que les sous-pharmacies
);

-- Profondeur 1 et quota, vérifiés par la base elle-même (le verrou sur la ligne parent sérialise les créations simultanées).
CREATE OR REPLACE FUNCTION tenants_check_group() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    PERFORM 1 FROM tenants WHERE id = NEW.parent_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM tenants p WHERE p.id = NEW.parent_id AND p.parent_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Une sous-pharmacie ne peut pas avoir de sous-pharmacies';
    END IF;
    IF EXISTS (SELECT 1 FROM tenants c WHERE c.parent_id = NEW.id) THEN
      RAISE EXCEPTION 'Une pharmacie qui a des sous-pharmacies ne peut pas devenir une sous-pharmacie';
    END IF;
    IF (SELECT count(*) FROM tenants c WHERE c.parent_id = NEW.parent_id AND c.id <> NEW.id)
         >= (SELECT max_subsites FROM tenants p WHERE p.id = NEW.parent_id) THEN
      RAISE EXCEPTION 'Quota de sous-pharmacies atteint';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS tenants_group_check ON tenants;
CREATE TRIGGER tenants_group_check BEFORE INSERT OR UPDATE OF parent_id ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_check_group();

-- Une pharmacie ne peut pas réduire son quota en dessous du nombre de sous-pharmacies existantes.
CREATE OR REPLACE FUNCTION tenants_check_quota() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF (SELECT count(*) FROM tenants c WHERE c.parent_id = NEW.id) > NEW.max_subsites THEN
    RAISE EXCEPTION 'Le quota ne peut pas être inférieur au nombre de sous-pharmacies existantes';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS tenants_quota_check ON tenants;
CREATE TRIGGER tenants_quota_check BEFORE UPDATE OF max_subsites ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_check_quota();

-- Rôle « gérant local » (rang entre Admin et employés) : on remplace le CHECK du rôle, quel que soit son nom.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%pharmacien%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('superadmin','admin','gerant','pharmacien','preparateur','caissier','personnalise'));
