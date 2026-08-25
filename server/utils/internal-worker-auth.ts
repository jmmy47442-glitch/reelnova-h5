const encoder = new TextEncoder();
const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const verifyMediaWorkerRequest = async (event: Parameters<typeof readRawBody>[0], rawBody: string) => {
  const timestamp = getHeader(event, 'x-reelnova-timestamp') || '';
  const signature = getHeader(event, 'x-reelnova-signature') || '';
  const secret = String(useRuntimeConfig(event).cloudflareMediaWorkerSecret || '');
  if (!secret || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`))));
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return difference === 0;
};
