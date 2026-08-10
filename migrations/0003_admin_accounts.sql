PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admin_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  invited_by TEXT,
  invited_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(invited_by) REFERENCES admin_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_accounts_status ON admin_accounts(status, created_at DESC);
