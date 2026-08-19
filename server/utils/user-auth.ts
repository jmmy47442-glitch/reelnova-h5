import type { H3Event } from 'h3';
import type { UserSession } from '~/types/user';
import {
  userBase64UrlToBytes,
  userBytesToBase64Url,
  userPasswordIterations,
} from '../../shared/user-password-proof';
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

const encodeJson = (value: unknown) => userBytesToBase64Url(encoder.encode(JSON.stringify(value)));
const decodeJson = <T>(value: string) => JSON.parse(new TextDecoder().decode(userBase64UrlToBytes(value))) as T;

const randomToken = (size = 18) => userBytesToBase64Url(crypto.getRandomValues(new Uint8Array(size)));

const signWithKey = async (value: string, keyBytes: BufferSource) => {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return userBytesToBase64Url(new Uint8Array(signed));
};

const sign = (payload: string, secret: string) => signWithKey(payload, encoder.encode(secret));

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

export const createUserAccount = async (event: H3Event, input: {
  name: string;
  email: string;
  passwordSalt: string;
  passwordHash: string;
}) => {
  const email = input.email.trim().toLowerCase();
  if (await findByEmail(event, email)) {
    throw createError({ statusCode: 409, statusMessage: 'An account with this email already exists' });
  }

  if (await getUserSession(event)) {
    throw createError({ statusCode: 409, statusMessage: 'You are already signed in' });
  }
  const now = new Date().toISOString();
  const row: UserAccountRow = {
    user_id: `usr_${crypto.randomUUID()}`,
    email,
    display_name: input.name.trim(),
    password_salt: input.passwordSalt,
    password_hash: input.passwordHash,
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

interface UserLoginChallengePayload {
  email: string;
  nonce: string;
  expiresAt: number;
}

export const createUserLoginChallenge = async (event: H3Event, email: string) => {
  const normalizedEmail = email.trim().toLowerCase();
  const account = await findByEmail(event, normalizedEmail);
  const payload = encodeJson({
    email: normalizedEmail,
    nonce: randomToken(),
    expiresAt: Date.now() + 60_000,
  } satisfies UserLoginChallengePayload);
  const signature = await sign(payload, String(useRuntimeConfig(event).userSessionSecret));
  return {
    challenge: `${payload}.${signature}`,
    salt: account?.password_salt || randomToken(),
    iterations: userPasswordIterations,
  };
};

const verifyUserLoginChallenge = async (event: H3Event, challenge: string, email: string) => {
  const [payload, signature, extra] = challenge.split('.');
  if (!payload || !signature || extra) return false;
  const expected = await sign(payload, String(useRuntimeConfig(event).userSessionSecret));
  if (!constantTimeEqual(signature, expected)) return false;
  try {
    const value = decodeJson<UserLoginChallengePayload>(payload);
    return value.email === email && Boolean(value.nonce) && value.expiresAt > Date.now();
  } catch {
    return false;
  }
};

export const authenticateUserProof = async (event: H3Event, email: string, challenge: string, proof: string) => {
  const normalizedEmail = email.trim().toLowerCase();
  const account = await findByEmail(event, normalizedEmail);
  if (!account || account.status !== 'active') return null;
  if (!await verifyUserLoginChallenge(event, challenge, normalizedEmail)) return null;
  const expectedProof = await signWithKey(challenge, userBase64UrlToBytes(account.password_hash));
  if (!constantTimeEqual(proof, expectedProof)) return null;
  const loggedInAt = new Date().toISOString();
  await d1Run(event, 'UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?', [loggedInAt, loggedInAt, account.user_id]);
  return { ...toAccount(account), lastLoginAt: loggedInAt };
};

export const resetUserPassword = async (
  event: H3Event,
  email: string,
  passwordSalt: string,
  passwordHash: string,
) => {
  const account = await findByEmail(event, email.trim().toLowerCase());
  if (!account) return null;
  if (account.status !== 'active') {
    throw createError({ statusCode: 403, statusMessage: 'This account cannot reset its password' });
  }
  const updatedAt = new Date().toISOString();
  await d1Run(event, 'UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE user_id = ?', [
    passwordSalt,
    passwordHash,
    updatedAt,
    account.user_id,
  ]);
  return toAccount({ ...account, password_salt: passwordSalt, password_hash: passwordHash });
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
