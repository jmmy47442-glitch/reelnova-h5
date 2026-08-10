PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS home_config (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
