export const checkMediaHealth = async (env) => {
  const base = String(env.CLOUDFLARE_MEDIA_WORKER_URL || '').replace(/\/$/, '');
  const secret = env.CLOUDFLARE_MEDIA_WORKER_SECRET;
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '');
  const apiToken = String(env.CLOUDFLARE_API_TOKEN || '');
  if (!base || !secret || !accountId || !apiToken) throw new Error('Missing media Worker or Cloudflare Stream credentials');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/stream`, {
    signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${apiToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) {
    const detail = payload.errors?.map((item) => item.message).filter(Boolean).join('; ') || '';
    throw new Error(`Cloudflare Stream API health check failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
  }
};
