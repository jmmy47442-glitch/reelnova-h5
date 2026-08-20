import { readFileSync } from 'node:fs';

const parseEnv = (file) => {
  const values = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
};

const env = parseEnv('.env');

const required = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_MEDIA_WORKER_URL',
  'CLOUDFLARE_MEDIA_WORKER_SECRET',
  'CLOUDFLARE_MEDIA_SIGNING_SECRET',
];

const optional = [
  'CLOUDFLARE_ZONE_ID',
  'CLOUDFLARE_FOR_SAAS_ENABLED',
  'CLOUDFLARE_DOMAIN_CNAME_TARGET',
  'CLOUDFLARE_STREAM_CUSTOMER_CODE',
  'CLOUDFLARE_STREAM_WEBHOOK_SECRET',
];

const status = (key) => env[key] ? 'SET' : 'MISSING';
const errorMessages = (payload) => Array.isArray(payload?.errors)
  ? payload.errors.map((item) => `${item.code || ''} ${item.message || ''}`.trim()).filter(Boolean)
  : [];

const requestCloudflare = async (label, url) => {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
  const payload = await response.json().catch(() => ({}));
  const errors = errorMessages(payload);
  console.log(`${label}: ${response.status} ${response.statusText} / success=${Boolean(payload.success)}`);
  if (errors.length) console.log(`${label} errors: ${errors.join(' | ')}`);
  return { response, payload, errors };
};

console.log('Cloudflare environment');
for (const key of required) console.log(`- ${key}: ${status(key)}`);
for (const key of optional) console.log(`- ${key}: ${status(key)}${['CLOUDFLARE_FOR_SAAS_ENABLED', 'CLOUDFLARE_DOMAIN_CNAME_TARGET', 'CLOUDFLARE_STREAM_CUSTOMER_CODE'].includes(key) ? ' (optional for MVP)' : ''}`);

const missingRequired = required.filter((key) => !env[key]);
if (missingRequired.length) {
  console.log(`\nMissing required values: ${missingRequired.join(', ')}`);
  process.exitCode = 1;
  process.exit();
}

console.log('\nCloudflare API checks');
const tokenCheck = await requestCloudflare('Token verify', 'https://api.cloudflare.com/client/v4/user/tokens/verify');
if (!tokenCheck.payload?.success) {
  console.log('Fix: replace CLOUDFLARE_API_TOKEN with a valid Cloudflare API token.');
  process.exitCode = 1;
  process.exit();
}

const streamCheck = await requestCloudflare(
  'Stream API',
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/stream`,
);
if (!streamCheck.payload?.success) {
  const authenticationError = streamCheck.errors.some((message) => message.includes('Authentication error'));
  console.log(authenticationError
    ? 'Fix: the token is valid, but it cannot access Stream for this account. Check CLOUDFLARE_ACCOUNT_ID and add Account / Stream / Edit to the token.'
    : 'Fix: check Cloudflare Stream permissions and account scope for CLOUDFLARE_API_TOKEN.');
  process.exitCode = 1;
}

if (env.CLOUDFLARE_ZONE_ID) {
  const zoneCheck = await requestCloudflare(
    'Zone API',
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.CLOUDFLARE_ZONE_ID)}`,
  );
  if (!zoneCheck.payload?.success) {
    console.log('Fix: custom domain automation needs Zone / Zone / Read and SSL certificate permissions for this zone.');
    process.exitCode = 1;
  }
}
