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
