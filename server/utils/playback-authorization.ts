import type { H3Event } from 'h3';

const encoder = new TextEncoder();

export const getPlaybackAuthorizationSecret = (event: H3Event) => {
  const config = useRuntimeConfig(event);
  const secret = String(config.cloudflareMediaSigningSecret || config.userSessionSecret || '');
  if (!secret) throw createError({ statusCode: 503, statusMessage: 'Playback authorization is not configured' });
  return secret;
};

export const signPlaybackAuthorization = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return Array.from(signed, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const playbackAuthorizationMatches = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

export const createStreamTokenGrant = async (event: H3Event, uid: string, tokenExpires: number) => {
  const grantExpires = Math.floor(Date.now() / 1000) + 60;
  const signature = await signPlaybackAuthorization(
    `stream:${uid}:${tokenExpires}:${grantExpires}`,
    getPlaybackAuthorizationSecret(event),
  );
  return `${grantExpires}.${signature}`;
};

export const verifyStreamTokenGrant = async (
  event: H3Event,
  uid: string,
  tokenExpires: number,
  grant: string,
) => {
  const [grantExpiresRaw, suppliedSignature, extra] = grant.split('.');
  const grantExpires = Number(grantExpiresRaw);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(tokenExpires) || tokenExpires < now + 30 || tokenExpires > now + 15 * 60
    || !Number.isInteger(grantExpires) || grantExpires < now || grantExpires > now + 90
    || !suppliedSignature || extra) return false;
  const expected = await signPlaybackAuthorization(
    `stream:${uid}:${tokenExpires}:${grantExpires}`,
    getPlaybackAuthorizationSecret(event),
  );
  return playbackAuthorizationMatches(suppliedSignature, expected);
};
