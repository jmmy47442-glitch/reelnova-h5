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
const zoneId = String(env.CLOUDFLARE_ZONE_ID || '').trim();
const apiToken = String(env.CLOUDFLARE_API_TOKEN || '').trim();
if (!zoneId || !apiToken) {
  throw new Error('CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN are required');
}

const apiBase = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}`;
const request = async (path, options = {}, allowNotFound = false) => {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok || !payload.success) {
    const detail = payload.errors?.map((item) => `${item.code || ''} ${item.message || ''}`.trim()).filter(Boolean).join('; ')
      || `HTTP ${response.status}`;
    throw new Error(`Cloudflare Redirect Rule operation failed: ${detail}`);
  }
  return payload.result;
};

const phase = 'http_request_dynamic_redirect';
const rule = {
  ref: 'www-to-apex',
  description: 'www-to-apex',
  expression: '(http.host eq "www.iseedrama.com")',
  action: 'redirect',
  action_parameters: {
    from_value: {
      status_code: 301,
      target_url: { expression: 'concat("https://iseedrama.com", http.request.uri.path)' },
      preserve_query_string: true,
    },
  },
  enabled: true,
};

const entrypoint = await request(`/rulesets/phases/${phase}/entrypoint`, {}, true);
if (!entrypoint) {
  await request('/rulesets', {
    method: 'POST',
    body: JSON.stringify({
      name: 'iseedrama redirect rules',
      description: 'Zone-level canonical hostname redirects',
      kind: 'zone',
      phase,
      rules: [rule],
    }),
  });
  console.log('CREATED Cloudflare Redirect Rule www-to-apex');
} else {
  const existing = entrypoint.rules?.find((item) => item.ref === rule.ref || item.description === rule.description);
  if (existing) {
    await request(`/rulesets/${encodeURIComponent(entrypoint.id)}/rules/${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(rule),
    });
    console.log('UPDATED Cloudflare Redirect Rule www-to-apex');
  } else {
    await request(`/rulesets/${encodeURIComponent(entrypoint.id)}/rules`, {
      method: 'POST',
      body: JSON.stringify(rule),
    });
    console.log('CREATED Cloudflare Redirect Rule www-to-apex');
  }
}
