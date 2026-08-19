ALTER TABLE media_upload_sessions ADD COLUMN idempotency_key TEXT;
ALTER TABLE media_upload_sessions ADD COLUMN r2_completion_key TEXT;
ALTER TABLE media_upload_sessions ADD COLUMN stream_idempotency_key TEXT;
ALTER TABLE media_upload_sessions ADD COLUMN completion_parts_json TEXT CHECK (completion_parts_json IS NULL OR json_valid(completion_parts_json));
ALTER TABLE media_upload_sessions ADD COLUMN source_etag TEXT;
ALTER TABLE media_upload_sessions ADD COLUMN stream_uid TEXT;
ALTER TABLE media_upload_sessions ADD COLUMN r2_completed_at TEXT;
ALTER TABLE media_upload_sessions ADD COLUMN stream_created_at TEXT;
ALTER TABLE media_upload_sessions ADD COLUMN last_error TEXT;
ALTER TABLE media_upload_sessions ADD COLUMN reconciled_at TEXT;

UPDATE media_upload_sessions
SET idempotency_key = 'legacy:' || id,
    r2_completion_key = 'r2:' || id,
    stream_idempotency_key = 'reelnova:upload:' || id
WHERE idempotency_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_sessions_idempotency
  ON media_upload_sessions(idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_sessions_r2_completion
  ON media_upload_sessions(r2_completion_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_sessions_stream_idempotency
  ON media_upload_sessions(stream_idempotency_key);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_recovery
  ON media_upload_sessions(status, updated_at)
  WHERE status = 'completing';
