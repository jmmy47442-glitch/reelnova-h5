PRAGMA foreign_keys = ON;

-- Keep the original account-tier column for compatibility with existing D1 data.
-- Ordinary legacy administrators are migrated to the least-privileged content role.
ALTER TABLE admin_accounts ADD COLUMN permission_role TEXT NOT NULL DEFAULT 'content_operator'
  CHECK (permission_role IN ('content_operator', 'finance_operator'));

CREATE INDEX IF NOT EXISTS idx_admin_accounts_permission_role
  ON admin_accounts(permission_role, status, created_at DESC);
