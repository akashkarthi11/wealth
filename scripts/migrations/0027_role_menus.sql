-- 0027: role management (owner, 2026-11-12). The admin chooses which menus a role can see. Additive: one new table.
-- No row for a role = every menu is visible (today's behaviour). The admin role always sees everything.
CREATE TABLE IF NOT EXISTS wealth_role_menus (
  role       text PRIMARY KEY CHECK (role IN ('user')),
  menus      text[] NOT NULL CHECK (cardinality(menus) >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES wealth_users(id) ON DELETE SET NULL
);
DROP TRIGGER IF EXISTS wealth_role_menus_audit ON wealth_role_menus;
CREATE TRIGGER wealth_role_menus_audit AFTER INSERT OR UPDATE OR DELETE ON wealth_role_menus FOR EACH ROW EXECUTE FUNCTION wealth_trg_audit();
DROP TRIGGER IF EXISTS wealth_role_menus_data_version ON wealth_role_menus;
CREATE TRIGGER wealth_role_menus_data_version AFTER INSERT OR UPDATE OR DELETE ON wealth_role_menus FOR EACH STATEMENT EXECUTE FUNCTION wealth_bump_data_version();
