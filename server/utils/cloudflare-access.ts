import type { H3Event } from 'h3';

interface AccessClaims { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; }
interface AccessJwk { kid?: string; kty: string; alg?: string; n: string; e: string; }
interface AccessJwks { keys: AccessJwk[]; }

const decoder = new TextDecoder();
const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
const parseJson = <T>(value: string) => JSON.parse(decoder.decode(fromBase64Url(value))) as T;
const jwksCache = new Map<string, { expiresAt: number; keys: AccessJwk[] }>();

const getKeys = async (teamDomain: string) => {
  const cached = jwksCache.get(teamDomain);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await $fetch<AccessJwks>(`${teamDomain.replace(/\/$/, '')}/cdn-cgi/access/certs`, { timeout: 5_000 });
  const keys = response.keys || [];
  jwksCache.set(teamDomain, { keys, expiresAt: Date.now() + 5 * 60_000 });
  return keys;
};

export const verifyCloudflareAccessJwt = async (event: H3Event) => {
  const token = getHeader(event, 'cf-access-jwt-assertion');
  const config = useRuntimeConfig(event);
  const teamDomain = String(config.cloudflareAccessTeamDomain || '').replace(/\/$/, '');
  const audience = String(config.cloudflareAccessAudience || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!token || !teamDomain || !audience.length) return false;
  const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) return false;
  try {
    const header = parseJson<{ alg?: string; kid?: string }>(encodedHeader);
    if (header.alg !== 'RS256' || !header.kid) return false;
    const claims = parseJson<AccessClaims>(encodedPayload);
    const issuer = String(claims.iss || '').replace(/\/$/, '');
    if (issuer !== teamDomain || !claims.exp || claims.exp <= Math.floor(Date.now() / 1000) || (claims.nbf && claims.nbf > Math.floor(Date.now() / 1000) + 30)) return false;
    const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!audience.some(value => tokenAudiences.includes(value))) return false;
    const jwk = (await getKeys(teamDomain)).find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) return false;
    const cryptoKey = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, fromBase64Url(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
  } catch {
    return false;
  }
};
