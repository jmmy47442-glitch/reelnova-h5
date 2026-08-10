PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  actor_id TEXT,
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('普通', '高风险')),
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_module_risk ON admin_audit_logs(module, risk, created_at DESC);

-- Backfill user actions recorded before the unified audit table existed.
INSERT INTO admin_audit_logs (id, actor, actor_id, module, action, target, detail, risk, ip, created_at)
SELECT
  'user-action-' || id,
  actor,
  NULL,
  '用户与权益',
  CASE action
    WHEN 'status_change' THEN CASE WHEN detail LIKE '%-> disabled' THEN '禁用账号' WHEN detail LIKE '%-> active' THEN '恢复账号' ELSE '变更账号状态' END
    WHEN 'device_restriction_release' THEN '解除设备限制'
    WHEN 'entitlement_grant' THEN '手工补发权益'
    ELSE action
  END,
  visitor_id,
  detail,
  '高风险',
  NULL,
  created_at
FROM admin_user_actions
WHERE NOT EXISTS (SELECT 1 FROM admin_audit_logs WHERE admin_audit_logs.id = 'user-action-' || admin_user_actions.id);
