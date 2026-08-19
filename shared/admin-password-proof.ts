export const adminPasswordIterations = 210_000;

const encoder = new TextEncoder();

export const bytesToBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');

export const base64UrlToBytes = (value: string) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
};

export const deriveAdminPasswordProof = async (
  password: string,
  salt: string,
  challenge: string,
  iterations = adminPasswordIterations,
) => {
  const passwordKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const passwordHash = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: base64UrlToBytes(salt),
    iterations,
  }, passwordKey, 256);
  const proofKey = await crypto.subtle.importKey('raw', passwordHash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const proof = await crypto.subtle.sign('HMAC', proofKey, encoder.encode(challenge));
  return bytesToBase64Url(new Uint8Array(proof));
};
