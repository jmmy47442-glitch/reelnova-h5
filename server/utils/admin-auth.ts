import { getRequestURL, type H3Event } from 'h3';
import type { AdminRole, AssignableAdminRole } from '../../shared/admin-rbac';
import { isAdminRole } from '../../shared/admin-rbac';
import { adminPasswordIterations, base64UrlToBytes, bytesToBase64Url } from '../../shared/admin-password-proof';
import { d1All, d1First, d1Run } from './cloudflare-d1';
import { consumeChallenge, enforceAuthRateLimit, storeChallenge } from './auth-security';

type AdminAccountTier = 'super_admin' | 'admin';
export type AdminStatus = 'invited' | 'active' | 'disabled';

export interface AdminSession {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  loggedInAt: string;
  expiresAt: string;
}

interface AdminAccountRow {
  id: string;
  email: string;
  name: string;
  role: AdminAccountTier;
  permission_role: AssignableAdminRole;
  status: AdminStatus;
  password_salt: string;
  password_hash: string;
  invited_by: string | null;
  invited_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminAccount {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: AdminStatus;
  invitedBy: string | null;
  invitedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

const sessionCookie = 'reelnova-admin-session';
const protectedVerifierPrefix = 'v1';
const encoder = new TextEncoder();

const encodeJson = (value: unknown) => bytesToBase64Url(encoder.encode(JSON.stringify(value)));
const decodeJson = <T>(value: string) => JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;

const randomToken = (size = 18) => {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return bytesToBase64Url(bytes);
};

const credentialEncryptionKey = async (event: H3Event) => {
  const secret = String(useRuntimeConfig(event).adminCredentialSecret);
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`reelnova-admin-verifier:${secret}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

const protectPasswordVerifier = async (event: H3Event, verifier: string) => {
  if (process.env.NODE_ENV !== 'production') return verifier;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await credentialEncryptionKey(event), encoder.encode(verifier));
  return `${protectedVerifierPrefix}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
};

const readPasswordVerifier = async (event: H3Event, stored: string) => {
  const [version, iv, encrypted, extra] = stored.split('.');
  if (version !== protectedVerifierPrefix || !iv || !encrypted || extra) return stored;
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlToBytes(iv) },
      await credentialEncryptionKey(event),
      base64UrlToBytes(encrypted),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw createError({ statusCode: 500, statusMessage: 'Administrator credential encryption key is invalid' });
  }
};

const derivePasswordHash = async (password: string, salt: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlToBytes(salt), iterations: adminPasswordIterations }, key, 256);
  return bytesToBase64Url(new Uint8Array(bits));
};

const constantTimeEqual = (left: string, right: string) => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  return difference === 0;
};

const toAccount = (row: AdminAccountRow): AdminAccount => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role === 'super_admin' ? 'super_admin' : row.permission_role || 'content_operator',
  status: row.status,
  invitedBy: row.invited_by,
  invitedAt: row.invited_at,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

const findByEmail = async (event: H3Event, email: string) => d1First<AdminAccountRow>(
  event,
  'SELECT * FROM admin_accounts WHERE email = ? COLLATE NOCASE LIMIT 1',
  [email],
);

const findById = async (event: H3Event, id: string) => d1First<AdminAccountRow>(
  event,
  'SELECT * FROM admin_accounts WHERE id = ? LIMIT 1',
  [id],
);

const insertAccount = async (event: H3Event, row: AdminAccountRow) => {
  await d1Run(event, `INSERT INTO admin_accounts
    (id, email, name, role, permission_role, status, password_salt, password_hash, invited_by, invited_at, last_login_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    row.id, row.email, row.name, row.role, row.permission_role, row.status, row.password_salt, row.password_hash,
    row.invited_by, row.invited_at, row.last_login_at, row.created_at, row.updated_at,
  ]);
};

const updateLogin = async (event: H3Event, id: string, loggedInAt: string) => {
  await d1Run(event, `UPDATE admin_accounts
    SET status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, last_login_at = ?, updated_at = ? WHERE id = ?`,
  [loggedInAt, loggedInAt, id]);
};

export const ensureSuperAdmin = async (event: H3Event) => {
  const config = useRuntimeConfig(event);
  const email = String(config.superAdminEmail).trim().toLowerCase();
  const existing = await findByEmail(event, email);
  if (existing) return existing;

  const now = new Date().toISOString();
  const salt = randomToken();
  const account: AdminAccountRow = {
    id: `adm_${crypto.randomUUID()}`,
    email,
    name: String(config.superAdminName).trim() || '超级管理员',
    role: 'super_admin',
    permission_role: 'content_operator',
    status: 'active',
    password_salt: salt,
    password_hash: await protectPasswordVerifier(event, await derivePasswordHash(String(config.superAdminPassword), salt)),
    invited_by: null,
    invited_at: null,
    last_login_at: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await insertAccount(event, account);
    return account;
  } catch {
    const concurrent = await findByEmail(event, email);
    if (concurrent) return concurrent;
    throw createError({ statusCode: 500, statusMessage: 'Failed to initialize super administrator' });
  }
};

interface AdminLoginChallengePayload {
  email: string;
  nonce: string;
  expiresAt: number;
}

const signWithKey = async (value: string, keyBytes: BufferSource) => {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
};

const sign = (payload: string, secret: string) => signWithKey(payload, encoder.encode(secret));

export const createAdminLoginChallenge = async (event: H3Event, email: string) => {
  await enforceAuthRateLimit(event, 'admin-challenge', email, { ip: 20, email: 5, windowSeconds: 60, blockSeconds: 120 });
  await ensureSuperAdmin(event);
  const normalizedEmail = email.trim().toLowerCase();
  const account = await findByEmail(event, normalizedEmail);
  if (process.env.NODE_ENV === 'production' && account && !account.password_hash.startsWith(`${protectedVerifierPrefix}.`)) {
    const protectedVerifier = await protectPasswordVerifier(event, account.password_hash);
    await d1Run(event, 'UPDATE admin_accounts SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash = ?', [
      protectedVerifier, new Date().toISOString(), account.id, account.password_hash,
    ]);
  }
  const nonce = randomToken();
  const expiresAt = Date.now() + 60_000;
  const payload = encodeJson({
    email: normalizedEmail,
    nonce,
    expiresAt,
  } satisfies AdminLoginChallengePayload);
  const signature = await sign(payload, String(useRuntimeConfig(event).adminSessionSecret));
  await storeChallenge(event, { nonce, email: normalizedEmail, purpose: 'login', expiresAt });
  return {
    challenge: `${payload}.${signature}`,
    salt: account?.password_salt || randomToken(),
    iterations: adminPasswordIterations,
  };
};

const verifyAdminLoginChallenge = async (event: H3Event, challenge: string, email: string) => {
  const [payload, signature, extra] = challenge.split('.');
  if (!payload || !signature || extra) return null;
  const expected = await sign(payload, String(useRuntimeConfig(event).adminSessionSecret));
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const value = decodeJson<AdminLoginChallengePayload>(payload);
    return value.email === email && Boolean(value.nonce) && value.expiresAt > Date.now() ? value : null;
  } catch {
    return null;
  }
};

export const authenticateAdminProof = async (event: H3Event, email: string, challenge: string, proof: string) => {
  await enforceAuthRateLimit(event, 'admin-login', email, { ip: 15, email: 6, windowSeconds: 600, blockSeconds: 900 });
  await ensureSuperAdmin(event);
  const normalizedEmail = email.trim().toLowerCase();
  const account = await findByEmail(event, normalizedEmail);
  if (!account || account.status === 'disabled') return null;
  const challengePayload = await verifyAdminLoginChallenge(event, challenge, normalizedEmail);
  if (!challengePayload) return null;
  const expectedProof = await signWithKey(challenge, base64UrlToBytes(await readPasswordVerifier(event, account.password_hash)));
  if (!constantTimeEqual(proof, expectedProof)) return null;
  if (!await consumeChallenge(event, challengePayload.nonce, normalizedEmail, 'login')) return null;
  const loggedInAt = new Date().toISOString();
  await updateLogin(event, account.id, loggedInAt);
  return { ...toAccount(account), status: 'active' as const, lastLoginAt: loggedInAt };
};

export const setAdminSession = async (event: H3Event, account: AdminAccount, remember: boolean) => {
  const maxAge = remember ? 60 * 60 * 24 * 7 : 60 * 60 * 12;
  const loggedInAt = new Date().toISOString();
  const payload: AdminSession = {
    id: account.id,
    email: account.email,
    name: account.name,
    role: account.role,
    loggedInAt,
    expiresAt: new Date(Date.now() + maxAge * 1000).toISOString(),
  };
  const encoded = encodeJson(payload);
  const signature = await sign(encoded, String(useRuntimeConfig(event).adminSessionSecret));
  setCookie(event, sessionCookie, `${encoded}.${signature}`, {
    httpOnly: true,
    sameSite: 'strict',
    // Respect the actual request protocol so HTTP previews do not receive a
    // Secure cookie that the browser will silently reject.
    secure: getRequestURL(event).protocol === 'https:',
    maxAge,
    path: '/',
  });
  return payload;
};

export const clearAdminSession = (event: H3Event) => deleteCookie(event, sessionCookie, { path: '/' });

export const getAdminSession = async (event: H3Event): Promise<AdminSession | null> => {
  const token = getCookie(event, sessionCookie);
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = await sign(payload, String(useRuntimeConfig(event).adminSessionSecret));
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const session = decodeJson<AdminSession>(payload);
    if (!session.id || !session.email || !isAdminRole(session.role) || Date.parse(session.expiresAt) <= Date.now()) return null;
    const account = await findById(event, session.id);
    if (!account || account.status === 'disabled' || toAccount(account).role !== session.role || account.email !== session.email) return null;
    return session;
  } catch {
    return null;
  }
};

export const requireSuperAdmin = (event: H3Event) => {
  const session = event.context.adminSession as AdminSession | undefined;
  if (session?.role !== 'super_admin') throw createError({ statusCode: 403, statusMessage: 'Super administrator access required' });
  return session;
};

export const listAdminAccounts = async (event: H3Event) => {
  await ensureSuperAdmin(event);
  const rows = await d1All<AdminAccountRow>(event, 'SELECT * FROM admin_accounts ORDER BY created_at DESC');
  return rows.map(toAccount);
};

export const createAdminAccount = async (event: H3Event, input: { email: string; name: string; role: AssignableAdminRole; createdBy: string }) => {
  const email = input.email.trim().toLowerCase();
  if (await findByEmail(event, email)) throw createError({ statusCode: 409, statusMessage: 'Administrator email already exists' });

  const password = generateInitialPassword();
  const salt = randomToken();
  const now = new Date().toISOString();
  const row: AdminAccountRow = {
    id: `adm_${crypto.randomUUID()}`,
    email,
    name: input.name.trim(),
    role: 'admin',
    permission_role: input.role,
    status: 'invited',
    password_salt: salt,
    password_hash: await protectPasswordVerifier(event, await derivePasswordHash(password, salt)),
    invited_by: input.createdBy,
    invited_at: now,
    last_login_at: null,
    created_at: now,
    updated_at: now,
  };
  await insertAccount(event, row);
  return { account: toAccount(row), initialPassword: password };
};

export const updateAdminStatus = async (event: H3Event, id: string, status: Extract<AdminStatus, 'active' | 'disabled'>) => {
  const account = await findById(event, id);
  if (!account) throw createError({ statusCode: 404, statusMessage: 'Administrator not found' });
  if (account.role === 'super_admin') throw createError({ statusCode: 400, statusMessage: 'Super administrator cannot be disabled' });
  const now = new Date().toISOString();
  await d1Run(event, 'UPDATE admin_accounts SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
  return { ...toAccount(account), status };
};

export const updateAdminRole = async (event: H3Event, id: string, role: AssignableAdminRole) => {
  const account = await findById(event, id);
  if (!account) throw createError({ statusCode: 404, statusMessage: 'Administrator not found' });
  if (account.role === 'super_admin') throw createError({ statusCode: 400, statusMessage: 'Super administrator role cannot be changed' });
  const now = new Date().toISOString();
  await d1Run(event, 'UPDATE admin_accounts SET permission_role = ?, updated_at = ? WHERE id = ?', [role, now, id]);
  return { ...toAccount(account), role };
};

export const deleteAdminAccount = async (event: H3Event, id: string) => {
  const account = await findById(event, id);
  if (!account) throw createError({ statusCode: 404, statusMessage: 'Administrator not found' });
  if (account.role === 'super_admin') throw createError({ statusCode: 400, statusMessage: 'Super administrator cannot be deleted' });
  await d1Run(event, 'DELETE FROM admin_accounts WHERE id = ?', [id]);
  return { id };
};

const generateInitialPassword = () => {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%'];
  const randomCharacter = (characters: string) => characters[crypto.getRandomValues(new Uint32Array(1))[0] % characters.length];
  const characters = groups.map(randomCharacter);
  const pool = groups.join('');
  while (characters.length < 14) characters.push(randomCharacter(pool));
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const target = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
    [characters[index], characters[target]] = [characters[target], characters[index]];
  }
  return characters.join('');
};
