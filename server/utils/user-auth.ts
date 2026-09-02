import { getRequestURL, type H3Event } from 'h3';
import type { UserSession } from '~/types/user';
import {
  userBase64UrlToBytes,
  userBytesToBase64Url,
  userPasswordIterations,
} from '../../shared/user-password-proof';
import { d1First, d1Run, getRequestCountry, hasD1Connection } from './cloudflare-d1';
import { summarizeDevice } from './user-profile';
import { consumeChallenge, enforceAuthRateLimit, storeChallenge } from './auth-security';

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
const standardSessionMaxAge = 60 * 60 * 2;
const rememberedSessionMaxAge = 60 * 60 * 24 * 7;
const encoder = new TextEncoder();
const memoryAccounts = new Map<string, UserAccountRow>();
const canUseMemoryAuth = (event: H3Event) => process.env.NODE_ENV === 'development' && !hasD1Connection(event);

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

const findByEmail = (event: H3Event, email: string) => {
  if (canUseMemoryAuth(event)) return Promise.resolve(memoryAccounts.get(email.toLowerCase()) || null);
  return d1First<UserAccountRow>(event, `${accountSelect} AND email = ? COLLATE NOCASE LIMIT 1`, [email]);
};

const findById = (event: H3Event, userId: string) => {
  if (canUseMemoryAuth(event)) {
    return Promise.resolve([...memoryAccounts.values()].find((account) => account.user_id === userId) || null);
  }
  return d1First<UserAccountRow>(event, `${accountSelect} AND user_id = ? LIMIT 1`, [userId]);
};

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
  if (canUseMemoryAuth(event)) {
    memoryAccounts.set(row.email, row);
  } else {
    await d1Run(event, `INSERT INTO users
      (user_id, email, display_name, password_salt, password_hash, last_login_at,
       country, device, status, created_at, last_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`, [
      row.user_id, row.email, row.display_name, row.password_salt, row.password_hash,
      row.last_login_at, getRequestCountry(event), summarizeDevice(getHeader(event, 'user-agent')),
      row.created_at, row.created_at, now,
    ]);
  }
  return toAccount(row);
};

interface UserLoginChallengePayload {
  email: string;
  nonce: string;
  purpose: 'login' | 'reset';
  expiresAt: number;
}

export const createUserLoginChallenge = async (event: H3Event, email: string, purpose: 'login' | 'reset' = 'login') => {
  await enforceAuthRateLimit(event, purpose === 'reset' ? 'user-reset-challenge' : 'user-challenge', email, purpose === 'reset'
    ? { ip: 10, email: 4, windowSeconds: 600, blockSeconds: 900 }
    : { ip: 20, email: 8, windowSeconds: 60, blockSeconds: 120 });
  const normalizedEmail = email.trim().toLowerCase();
  const account = await findByEmail(event, normalizedEmail);
  const nonce = randomToken();
  const expiresAt = Date.now() + 60_000;
  const payload = encodeJson({
    email: normalizedEmail,
    nonce,
    purpose,
    expiresAt,
  } satisfies UserLoginChallengePayload);
  const signature = await sign(payload, String(useRuntimeConfig(event).userSessionSecret));
  await storeChallenge(event, { nonce, email: normalizedEmail, purpose, expiresAt });
  return {
    challenge: `${payload}.${signature}`,
    salt: account?.password_salt || randomToken(),
    iterations: userPasswordIterations,
  };
};

const verifyUserLoginChallenge = async (event: H3Event, challenge: string, email: string, purpose: 'login' | 'reset') => {
  const [payload, signature, extra] = challenge.split('.');
  if (!payload || !signature || extra) return null;
  const expected = await sign(payload, String(useRuntimeConfig(event).userSessionSecret));
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const value = decodeJson<UserLoginChallengePayload>(payload);
    return value.email === email && value.purpose === purpose && Boolean(value.nonce) && value.expiresAt > Date.now() ? value : null;
  } catch {
    return null;
  }
};

export const authenticateUserProof = async (event: H3Event, email: string, challenge: string, proof: string) => {
  await enforceAuthRateLimit(event, 'user-login', email, { ip: 15, email: 6, windowSeconds: 600, blockSeconds: 900 });
  const normalizedEmail = email.trim().toLowerCase();
  const account = await findByEmail(event, normalizedEmail);
  if (!account || account.status !== 'active') return null;
  const challengePayload = await verifyUserLoginChallenge(event, challenge, normalizedEmail, 'login');
  if (!challengePayload) return null;
  const expectedProof = await signWithKey(challenge, userBase64UrlToBytes(account.password_hash));
  if (!constantTimeEqual(proof, expectedProof)) return null;
  if (!await consumeChallenge(event, challengePayload.nonce, normalizedEmail, 'login')) return null;
  const loggedInAt = new Date().toISOString();
  if (canUseMemoryAuth(event)) {
    const stored = memoryAccounts.get(account.email);
    if (stored) memoryAccounts.set(account.email, { ...stored, last_login_at: loggedInAt });
  } else {
    await d1Run(event, 'UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?', [loggedInAt, loggedInAt, account.user_id]);
  }
  return { ...toAccount(account), lastLoginAt: loggedInAt };
};

export const resetUserPassword = async (
  event: H3Event,
  email: string,
  passwordSalt: string,
  passwordHash: string,
  challenge: string,
  proof: string,
) => {
  await enforceAuthRateLimit(event, 'user-reset', email, { ip: 10, email: 4, windowSeconds: 600, blockSeconds: 900 });
  const account = await findByEmail(event, email.trim().toLowerCase());
  if (!account) return null;
  if (account.status !== 'active') {
    throw createError({ statusCode: 403, statusMessage: 'This account cannot reset its password' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const challengePayload = await verifyUserLoginChallenge(event, challenge, normalizedEmail, 'reset');
  if (!challengePayload) return null;
  const expectedProof = await signWithKey(challenge, userBase64UrlToBytes(passwordHash));
  if (!constantTimeEqual(proof, expectedProof) || !await consumeChallenge(event, challengePayload.nonce, normalizedEmail, 'reset')) return null;
  const updatedAt = new Date().toISOString();
  if (canUseMemoryAuth(event)) {
    const stored = memoryAccounts.get(account.email);
    if (stored) memoryAccounts.set(account.email, { ...stored, password_salt: passwordSalt, password_hash: passwordHash });
  } else {
    await d1Run(event, 'UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE user_id = ?', [
      passwordSalt,
      passwordHash,
      updatedAt,
      account.user_id,
    ]);
  }
  return toAccount({ ...account, password_salt: passwordSalt, password_hash: passwordHash });
};

export const setUserSession = async (event: H3Event, account: UserAccount, remember: boolean) => {
  const maxAge = remember ? rememberedSessionMaxAge : standardSessionMaxAge;
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
    // Respect the actual request protocol so HTTP previews do not receive a
    // Secure cookie that the browser will silently reject.
    secure: getRequestURL(event).protocol === 'https:',
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
  const context = event.context as typeof event.context & {
    userSession?: UserSession | null;
    userSessionPromise?: Promise<UserSession | null>;
  };
  if (Object.prototype.hasOwnProperty.call(context, 'userSession')) return context.userSession || null;
  if (context.userSessionPromise) return context.userSessionPromise;

  context.userSessionPromise = (async () => {
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
  })();
  const session = await context.userSessionPromise;
  context.userSession = session;
  context.userSessionPromise = undefined;
  return session;
};
