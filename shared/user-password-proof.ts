export const userPasswordIterations = 210_000;

const encoder = new TextEncoder();

const browserCrypto = () => {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto.subtle) {
    throw Object.assign(
      new Error('Password protection requires a secure browser context. Open this site with HTTPS or localhost.'),
      { code: 'INSECURE_CRYPTO_CONTEXT' },
    );
  }
  return globalThis.crypto;
};

export const userBytesToBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');

export const userBase64UrlToBytes = (value: string) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
};

export const createUserPasswordSalt = () => userBytesToBase64Url(browserCrypto().getRandomValues(new Uint8Array(18)));

export const deriveUserPasswordHash = async (
  password: string,
  salt: string,
  iterations = userPasswordIterations,
) => {
  const passwordCrypto = browserCrypto();
  const passwordKey = await passwordCrypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const passwordHash = await passwordCrypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: userBase64UrlToBytes(salt),
    iterations,
  }, passwordKey, 256);
  return userBytesToBase64Url(new Uint8Array(passwordHash));
};

export const deriveUserPasswordProof = async (
  password: string,
  salt: string,
  challenge: string,
  iterations = userPasswordIterations,
) => {
  const passwordHash = await deriveUserPasswordHash(password, salt, iterations);
  const passwordCrypto = browserCrypto();
  const proofKey = await passwordCrypto.subtle.importKey(
    'raw',
    userBase64UrlToBytes(passwordHash),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const proof = await passwordCrypto.subtle.sign('HMAC', proofKey, encoder.encode(challenge));
  return userBytesToBase64Url(new Uint8Array(proof));
};
