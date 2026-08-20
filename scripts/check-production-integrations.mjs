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

const env = { ...parseEnv('.env'), ...process.env };
const expectedWebhookUrl = env.CLOUDFLARE_STREAM_WEBHOOK_URL || 'https://iseedrama.com/api/media/stream-webhook';
const required = (keys) => keys.filter((key) => !String(env[key] || '').trim());
const report = (label, ok, detail = '') => console.log(`${ok ? 'PASS' : 'BLOCK'} ${label}${detail ? `: ${detail}` : ''}`);
let blocked = false;

const paypalKeys = [
  'PAYPAL_PRODUCTION_CLIENT_ID',
  'PAYPAL_PRODUCTION_SECRET',
  'PAYPAL_PRODUCTION_WEBHOOK_ID',
  'NUXT_PUBLIC_PAYPAL_PRODUCTION_CLIENT_ID',
];
const missingPayPal = required(paypalKeys);
report('PayPal Production four credentials', missingPayPal.length === 0,
  missingPayPal.length ? `missing ${missingPayPal.join(', ')}` : 'all present');
blocked ||= missingPayPal.length > 0;
if (!missingPayPal.length) {
  const clientIdsMatch = env.PAYPAL_PRODUCTION_CLIENT_ID === env.NUXT_PUBLIC_PAYPAL_PRODUCTION_CLIENT_ID;
  report('PayPal browser/server Client IDs match', clientIdsMatch);
  blocked ||= !clientIdsMatch;
  try {
    const basic = Buffer.from(`${env.PAYPAL_PRODUCTION_CLIENT_ID}:${env.PAYPAL_PRODUCTION_SECRET}`).toString('base64');
    const response = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    report('PayPal Production OAuth', response.ok, `HTTP ${response.status}`);
    blocked ||= !response.ok;
  } catch (error) {
    report('PayPal Production OAuth', false, error instanceof Error ? error.message : 'request failed');
    blocked = true;
  }
}

const cloudflareKeys = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_STREAM_WEBHOOK_SECRET'];
const missingCloudflare = required(cloudflareKeys);
report('Stream Webhook Secret and API access', missingCloudflare.length === 0,
  missingCloudflare.length ? `missing ${missingCloudflare.join(', ')}` : 'secrets present');
blocked ||= missingCloudflare.length > 0;
if (!missingCloudflare.length) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/stream/webhook`, {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    });
    const payload = await response.json().catch(() => ({}));
    const remoteUrl = String(payload?.result?.notification_url || payload?.result?.notificationUrl || '').replace(/\/$/, '');
    const callbackReady = Boolean(response.ok && payload?.success && remoteUrl === expectedWebhookUrl.replace(/\/$/, ''));
    report('Stream Webhook callback URL', callbackReady,
      remoteUrl ? `configured=${remoteUrl}` : `HTTP ${response.status}`);
    blocked ||= !callbackReady;
  } catch (error) {
    report('Stream Webhook callback URL', false, error instanceof Error ? error.message : 'request failed');
    blocked = true;
  }
}

const cnameReady = Boolean(String(env.CLOUDFLARE_DOMAIN_CNAME_TARGET || '').trim());
report('Cloudflare for SaaS CNAME target', cnameReady,
  env.CLOUDFLARE_DOMAIN_CNAME_TARGET ? 'configured' : 'CLOUDFLARE_DOMAIN_CNAME_TARGET is empty');
blocked ||= !cnameReady;

if (blocked) process.exitCode = 1;
