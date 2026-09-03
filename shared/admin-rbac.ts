export const adminRoles = ['super_admin', 'content_operator', 'finance_operator'] as const;
export type AdminRole = typeof adminRoles[number];
export type AssignableAdminRole = Exclude<AdminRole, 'super_admin'>;

export const adminPermissions = [
  'dashboard.read',
  'content.read',
  'content.manage',
  'finance.read',
  'finance.manage',
  'system.read',
  'system.manage',
  'audit.read',
  'administrators.manage',
  'domains.manage',
] as const;
export type AdminPermission = typeof adminPermissions[number];

const rolePermissions: Record<AdminRole, readonly AdminPermission[]> = {
  super_admin: adminPermissions,
  content_operator: ['content.read', 'content.manage'],
  finance_operator: ['dashboard.read', 'finance.read', 'finance.manage'],
};

export const adminRoleLabels: Record<AdminRole, string> = {
  super_admin: '超级管理员',
  content_operator: '内容运营',
  finance_operator: '财务/运营管理员',
};

export const isAdminRole = (value: unknown): value is AdminRole =>
  typeof value === 'string' && (adminRoles as readonly string[]).includes(value);

export const hasAdminPermission = (role: AdminRole | null | undefined, permission: AdminPermission) =>
  Boolean(role && rolePermissions[role].includes(permission));

export const getAdminLandingPath = (role: AdminRole | null | undefined) =>
  role === 'content_operator' ? '/admin/series' : '/admin';

export const getAdminPagePermission = (path: string): AdminPermission => {
  if (path === '/admin') return 'dashboard.read';
  if (/^\/admin\/metrics(?:\/|$)/.test(path)) return 'dashboard.read';
  if (/^\/admin\/(?:series|operations|taxonomy)(?:\/|$)/.test(path)) return 'content.read';
  if (/^\/admin\/(?:orders|users|reconciliation)(?:\/|$)/.test(path)) return 'finance.read';
  if (/^\/admin\/administrators(?:\/|$)/.test(path)) return 'administrators.manage';
  if (/^\/admin\/domains(?:\/|$)/.test(path)) return 'domains.manage';
  if (/^\/admin\/audit(?:\/|$)/.test(path)) return 'audit.read';
  return 'system.read';
};

interface ApiPermissionRule {
  pattern: RegExp;
  read: AdminPermission;
  write?: AdminPermission;
}

const apiPermissionRules: ApiPermissionRule[] = [
  { pattern: /^\/api\/admin\/dashboard$/, read: 'dashboard.read' },
  { pattern: /^\/api\/admin\/metrics(?:\/|$)/, read: 'dashboard.read' },
  { pattern: /^\/api\/admin\/pending-items$/, read: 'dashboard.read' },
  { pattern: /^\/api\/admin\/(?:series|media|home-config|taxonomy)(?:\/|$)/, read: 'content.read', write: 'content.manage' },
  { pattern: /^\/api\/admin\/(?:orders|users|reconciliation)(?:\/|$)/, read: 'finance.read', write: 'finance.manage' },
  { pattern: /^\/api\/admin\/connection$/, read: 'system.read' },
  { pattern: /^\/api\/admin\/paypal(?:\/|$)/, read: 'system.read', write: 'system.manage' },
  { pattern: /^\/api\/admin\/audit$/, read: 'audit.read' },
  { pattern: /^\/api\/admin\/administrators(?:\/|$)/, read: 'administrators.manage', write: 'administrators.manage' },
  { pattern: /^\/api\/admin\/domains(?:\/|$)/, read: 'domains.manage', write: 'domains.manage' },
];

export const getAdminApiPermission = (path: string, method: string): AdminPermission | null => {
  const rule = apiPermissionRules.find((item) => item.pattern.test(path));
  if (!rule) return null;
  return method === 'GET' || method === 'HEAD' ? rule.read : rule.write || rule.read;
};
