import type { H3Event } from 'h3';
import type { UserSession } from '~/types/user';
import { d1First, d1Run, getRequestCountry } from './cloudflare-d1';
import { summarizeDevice } from './user-profile';

interface UserAccountRow {
  user_id: string;
  email: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  status: 'active' | 'restricted' | 'disabled';
  last_login_at: string | null;
  created_at: string;
}

export interface UserAccount {
  userId: string;
  email: string;
  name: string;
  status: UserAccountRow['status'];
  lastLoginAt: string | null;
  createdAt: string;
}

const sessionCookie = 'reelnova-user-session';
const encoder = new TextEncoder();

const bytesToBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');

const base64UrlToBytes = (value: string) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
};

const encodeJson = (value: unknown) => bytesToBase64Url(encoder.encode(JSON.stringify(value)));
const decodeJson = <T>(value: string) => JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;

const randomToken = (size = 18) => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(size)));

const derivePasswordHash = async (password: string, salt: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: base64UrlToBytes(salt),
    iterations: 210_000,
  }, key, 256);
  return bytesToBase64Url(new Uint8Array(bits));
};

const constantTimeEqual = (left: string, right: string) => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
};

const toAccount = (row: UserAccountRow): UserAccount => ({
  userId: row.user_id,
  email: row.email,
  name: row.display_name,
  status: row.status,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

const accountSelect = `SELECT user_id, email, display_name, password_salt, password_hash,
  status, last_login_at, created_at
  FROM users
  WHERE password_hash IS NOT NULL`;

const findByEmail = (event: H3Event, email: string) => d1First<UserAccountRow>(
  event,
  `${accountSelect} AND email = ? COLLATE NOCASE LIMIT 1`,
  [email],
);

const findById = (event: H3Event, userId: string) => d1First<UserAccountRow>(
  event,
  `${accountSelect} AND user_id = ? LIMIT 1`,
  [userId],
);

export const createUserAccount = async (event: H3Event, input: { name: string; email: string; password: string }) => {
  const email = input.email.trim().toLowerCase();
  if (await findByEmail(event, email)) {
    throw createError({ statusCode: 409, statusMessage: 'An account with this email already exists' });
  }

  if (await getUserSession(event)) {
    throw createError({ statusCode: 409, statusMessage: 'You are already signed in' });
  }
  const now = new Date().toISOString();
  const salt = randomToken();
  const row: UserAccountRow = {
    user_id: `usr_${crypto.randomUUID()}`,
    email,
    display_name: input.name.trim(),
    password_salt: salt,
    password_hash: await derivePasswordHash(input.password, salt),
    status: 'active',
    last_login_at: now,
    created_at: now,
  };
  await d1Run(event, `INSERT INTO users
    (user_id, email, display_name, password_salt, password_hash, last_login_at,
     country, device, status, created_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`, [
    row.user_id, row.email, row.display_name, row.password_salt, row.password_hash,
    row.last_login_at, getRequestCountry(event), summarizeDevice(getHeader(event, 'user-agent')),
    row.created_at, row.created_at, now,
  ]);
  return toAccount(row);
};

export const authenticateUser = async (event: H3Event, email: string, password: string) => {
  const account = await findByEmail(event, email.trim().toLowerCase());
  if (!account || account.status !== 'active') return null;
  const candidate = await derivePasswordHash(password, account.password_salt);
  if (!constantTimeEqual(candidate, account.password_hash)) return null;
  const loggedInAt = new Date().toISOString();
  await d1Run(event, 'UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?', [loggedInAt, loggedInAt, account.user_id]);
  return { ...toAccount(account), lastLoginAt: loggedInAt };
};

const sign = async (payload: string, secret: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signed));
};

export const setUserSession = async (event: H3Event, account: UserAccount, remember: boolean) => {
  const maxAge = remember ? 60 * 60 * 24 * 30 : 60 * 60 * 12;
  const loggedInAt = new Date().toISOString();
  const session: UserSession = {
    userId: account.userId,
    email: account.email,
    name: account.name,
    loggedInAt,
    expiresAt: new Date(Date.now() + maxAge * 1000).toISOString(),
  };
  const payload = encodeJson(session);
  const signature = await sign(payload, String(useRuntimeConfig(event).userSessionSecret));
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge,
    path: '/',
  };
  setCookie(event, sessionCookie, `${payload}.${signature}`, cookieOptions);
  return session;
};

export const clearUserSession = (event: H3Event) => {
  deleteCookie(event, sessionCookie, { path: '/' });
};

export const getUserSession = async (event: H3Event): Promise<UserSession | null> => {
  const token = getCookie(event, sessionCookie);
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = await sign(payload, String(useRuntimeConfig(event).userSessionSecret));
  if (!constantTimeEqual(signature, expected)) return null;

  try {
    const session = decodeJson<UserSession>(payload);
    if (!session.userId || !session.email || Date.parse(session.expiresAt) <= Date.now()) return null;
    const account = await findById(event, session.userId);
    if (!account || account.status !== 'active' || account.user_id !== session.userId || account.email !== session.email) return null;
    return { ...session, name: account.display_name };
  } catch {
    return null;
  }
};
