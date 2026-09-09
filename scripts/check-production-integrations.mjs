import { existsSync, readFileSync } from 'node:fs';

const parseEnv = (file) => {
  const values = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
};

const envFile = process.env.PRODUCTION_ENV_FILE || '.env';
const env = { ...(existsSync(envFile) ? parseEnv(envFile) : {}), ...process.env };
const appBaseUrl = String(env.APP_BASE_URL || 'https://iseedrama.com').replace(/\/$/, '');
const expectedWebhookUrl = env.CLOUDFLARE_STREAM_WEBHOOK_URL || 'https://iseedrama.com/api/media/stream-webhook';
const expectedPayPalWebhookUrl = env.PAYPAL_WEBHOOK_URL || 'https://iseedrama.com/api/paypal/webhook';
const requiredPayPalWebhookEvents = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
];
const required = (keys) => keys.filter((key) => !String(env[key] || '').trim());
const report = (label, ok, detail = '') => console.log(`${ok ? 'PASS' : 'BLOCK'} ${label}${detail ? `: ${detail}` : ''}`);
const info = (label, detail) => console.log(`INFO ${label}: ${detail}`);
let blocked = false;

const paypalKeys = [
  'PAYPAL_PRODUCTION_CLIENT_ID',
  'PAYPAL_PRODUCTION_SECRET',
  'PAYPAL_PRODUCTION_WEBHOOK_ID',
  'NUXT_PUBLIC_PAYPAL_PRODUCTION_CLIENT_ID',
];
const missingPayPal = required(paypalKeys);
let deployedPayPal = null;
try {
  const response = await fetch(`${appBaseUrl}/api/paypal/config`, { signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({}));
  deployedPayPal = payload?.data || null;
  const ready = response.ok && deployedPayPal?.environment === 'production' && deployedPayPal?.available === true
    && Boolean(String(deployedPayPal?.clientId || '').trim());
  report('Deployed PayPal Production checkout', ready,
    response.ok ? `environment=${deployedPayPal?.environment || 'unknown'}, available=${Boolean(deployedPayPal?.available)}` : `HTTP ${response.status}`);
  blocked ||= !ready;
} catch (error) {
  report('Deployed PayPal Production checkout', false, error instanceof Error ? error.message : 'request failed');
  blocked = true;
}

const localPayPalConfigured = missingPayPal.length === 0;
const localPayPalPartiallyConfigured = missingPayPal.length > 0 && missingPayPal.length < paypalKeys.length;
if (localPayPalPartiallyConfigured) {
  report('Local PayPal Production credential set', false, `partial set; missing ${missingPayPal.join(', ')}`);
  blocked = true;
} else if (!localPayPalConfigured) {
  info('Local PayPal Production credential audit', `skipped; all four values are absent from ${envFile}`);
} else {
  report('Local PayPal Production credential set', true, `all present in ${envFile}`);
  const clientIdsMatch = env.PAYPAL_PRODUCTION_CLIENT_ID === env.NUXT_PUBLIC_PAYPAL_PRODUCTION_CLIENT_ID;
  report('PayPal browser/server Client IDs match', clientIdsMatch);
  blocked ||= !clientIdsMatch;
  const deployedClientMatches = !deployedPayPal?.clientId || deployedPayPal.clientId === env.PAYPAL_PRODUCTION_CLIENT_ID;
  report('Local/deployed PayPal Client IDs match', deployedClientMatches);
  blocked ||= !deployedClientMatches;
  try {
    const basic = Buffer.from(`${env.PAYPAL_PRODUCTION_CLIENT_ID}:${env.PAYPAL_PRODUCTION_SECRET}`).toString('base64');
    const response = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    report('PayPal Production OAuth', response.ok, `HTTP ${response.status}`);
    blocked ||= !response.ok;
    if (response.ok) {
      const tokenPayload = await response.json();
      const webhookResponse = await fetch(
        `https://api-m.paypal.com/v1/notifications/webhooks/${encodeURIComponent(env.PAYPAL_PRODUCTION_WEBHOOK_ID)}`,
        { headers: { Authorization: `Bearer ${tokenPayload.access_token}` } },
      );
      const webhook = await webhookResponse.json().catch(() => ({}));
      const webhookExists = webhookResponse.ok && webhook?.id === env.PAYPAL_PRODUCTION_WEBHOOK_ID;
      report('PayPal Production Webhook ID', webhookExists, `HTTP ${webhookResponse.status}`);
      blocked ||= !webhookExists;
      if (webhookExists) {
        const configuredUrl = String(webhook.url || '').replace(/\/$/, '');
        const webhookUrlMatches = configuredUrl === expectedPayPalWebhookUrl.replace(/\/$/, '');
        report('PayPal Production Webhook callback URL', webhookUrlMatches,
          configuredUrl ? `configured=${configuredUrl}` : 'callback URL missing');
        blocked ||= !webhookUrlMatches;

        const subscribedEvents = new Set((webhook.event_types || []).map((eventType) => eventType.name));
        const missingEvents = requiredPayPalWebhookEvents.filter((eventType) => !subscribedEvents.has(eventType));
        report('PayPal Production Webhook event subscriptions', missingEvents.length === 0,
          missingEvents.length ? `missing ${missingEvents.join(', ')}` : 'required capture events present');
        blocked ||= missingEvents.length > 0;
      }
    }
  } catch (error) {
    report('PayPal Production API validation', false, error instanceof Error ? error.message : 'request failed');
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

const cloudflareForSaasEnabled = String(env.CLOUDFLARE_FOR_SAAS_ENABLED || '').trim().toLowerCase() === 'true';
if (cloudflareForSaasEnabled) {
  const cnameReady = Boolean(String(env.CLOUDFLARE_DOMAIN_CNAME_TARGET || '').trim());
  report('Cloudflare for SaaS CNAME target', cnameReady,
    cnameReady ? 'configured' : 'CLOUDFLARE_DOMAIN_CNAME_TARGET is empty');
  blocked ||= !cnameReady;
} else {
  report('MVP domain mode', true, 'ordinary Cloudflare Custom Domains; SaaS automation deferred');
}

if (blocked) process.exitCode = 1;
