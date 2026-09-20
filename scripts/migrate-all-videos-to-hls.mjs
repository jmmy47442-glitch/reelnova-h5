import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

const projectRoot = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: {
  'work-dir': { type: 'string', default: '/tmp/reelnova-hls-migration' },
  'env-file': { type: 'string', default: '.env' },
  'ffmpeg-path': { type: 'string' },
  'ffprobe-path': { type: 'string' },
  limit: { type: 'string' },
  keep: { type: 'boolean', default: false },
  'rebuild-hls': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });

if (values.help) {
  console.log(`Usage: npm run media:migrate-hls -- [options]

Options:
  --work-dir PATH       Resume/status directory (default: /tmp/reelnova-hls-migration)
  --env-file PATH       Cloudflare environment file (default: .env)
  --ffmpeg-path PATH    FFmpeg executable (or set FFMPEG_PATH)
  --ffprobe-path PATH   FFprobe executable (or set FFPROBE_PATH)
  --limit N             Process at most N assets
  --rebuild-hls         Rebuild existing packages with the high-quality HD ladder
  --keep                Keep local source and HLS packages after publication`);
  process.exit(0);
}

const loadEnv = fileName => {
  const path = resolve(projectRoot, fileName);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
};

loadEnv(values['env-file']);
const {
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_D1_DATABASE_ID: databaseId,
  CLOUDFLARE_API_TOKEN: apiToken,
  CLOUDFLARE_MEDIA_WORKER_SECRET: mediaSecret,
} = process.env;
const mediaBase = String(process.env.CLOUDFLARE_MEDIA_WORKER_URL || '').replace(/\/$/, '');
if (!accountId || !databaseId || !apiToken || !mediaBase || !mediaSecret) {
  throw new Error('Cloudflare account, D1, API token, media Worker URL and media Worker secret are required.');
}

const workDir = resolve(values['work-dir']);
mkdirSync(workDir, { recursive: true });
const statePath = join(workDir, 'state.json');
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { version: 1, assets: {} };
if (state.version !== 1 || !state.assets) throw new Error(`Invalid migration state: ${statePath}`);
const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const retry = async (label, operation, attempts = 5) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      if (error.permanent || attempt === attempts) break;
      console.warn(`${label} failed (${attempt}/${attempts}): ${error.message}`);
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
  throw lastError;
};

const responseError = async (response, label) => {
  const detail = (await response.text().catch(() => '')).slice(0, 300);
  const error = new Error(`${label}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  error.permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
  return error;
};

const d1Query = async (sql, params = []) => retry('D1 query', async () => {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json().catch(() => ({}));
  const failed = payload.result?.find(result => !result.success);
  if (!response.ok || !payload.success || failed) {
    const error = new Error(failed?.error || payload.errors?.[0]?.message || `D1 query: HTTP ${response.status}`);
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw error;
  }
  return payload.result?.[0]?.results || [];
});

const signedWorkerPost = async (path, body) => retry(`Worker ${path}`, async () => {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', mediaSecret).update(`${timestamp}.${rawBody}`).digest('hex');
  const response = await fetch(`${mediaBase}${path}`, {
    method: 'POST', body: rawBody, signal: AbortSignal.timeout(30000),
    headers: {
      'content-type': 'application/json',
      'x-reelnova-timestamp': timestamp,
      'x-reelnova-signature': signature,
    },
  });
  if (!response.ok) throw await responseError(response, `Worker ${path}`);
  return response.json();
});

const grantFor = (asset, delivery) => signedWorkerPost('/original/token', {
  key: asset.source_object_key,
  assetId: asset.asset_id,
  exp: Math.floor(Date.now() / 1000) + 15 * 60,
  delivery,
});

const run = (command, args, extraEnv = {}) => new Promise((resolvePromise, reject) => {
  console.log(`Running ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: projectRoot, stdio: 'inherit', env: { ...process.env, ...extraEnv },
  });
  child.on('error', reject);
  child.on('exit', (code, signal) => code === 0
    ? resolvePromise()
    : reject(new Error(`${command} exited with ${code ?? signal}`)));
});

const downloadSource = async (asset, target, assetState) => {
  const size = Number(asset.source_size_bytes);
  const databaseEtag = String(asset.source_etag || '').replace(/^"|"$/g, '');
  if (!Number.isSafeInteger(size) || size <= 0 || !databaseEtag) throw new Error('D1 source metadata is incomplete');
  const objectPath = asset.source_object_key.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/reelnova-media-private/objects/${objectPath}`;
  const partial = `${target}.part`;
  const downloaded = await retry('R2 source download', async () => {
    rmSync(partial, { force: true });
    const result = await fetch(url, {
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    if (!result.ok || !result.body) throw await responseError(result, 'R2 source download');
    const responseSize = Number(result.headers.get('content-length'));
    const responseEtag = String(result.headers.get('etag') || '').replace(/^"|"$/g, '');
    if (responseSize !== size || responseEtag !== databaseEtag) {
      await result.body.cancel();
      throw Object.assign(new Error(`R2 source metadata mismatch for ${asset.asset_id}`), { permanent: true });
    }
    if (existsSync(target) && statSync(target).size === size) {
      await result.body.cancel();
      console.log(`Using complete local source ${target}`);
      return false;
    }
    await pipeline(Readable.fromWeb(result.body), createWriteStream(partial, { flags: 'w', mode: 0o600 }));
    if (statSync(partial).size !== size) throw new Error('Downloaded source is incomplete');
    return true;
  }, 8);
  if (downloaded) {
    rmSync(target, { force: true });
    renameSync(partial, target);
    console.log(`Downloaded ${Math.ceil(size / 1024 / 1024)} MiB from the R2 object API for ${asset.asset_id}`);
  }
  assetState.download = { etag: databaseEtag, size, completed: true, source: 'r2-api' };
  saveState();
  return databaseEtag;
};

const verifyHls = async asset => {
  const grant = await grantFor(asset, 'auto');
  if (grant.delivery !== 'hls' || !grant.url) throw new Error('Fresh playback grant did not select HLS');
  const getText = async url => retry(`Verify ${url}`, async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw await responseError(response, 'HLS verification');
    return response.text();
  });
  const master = await getText(grant.url);
  if (!master.startsWith('#EXTM3U') || !master.includes('#EXT-X-STREAM-INF')) throw new Error('Invalid HLS master playlist');
  const variantName = master.split(/\r?\n/).find(line => line && !line.startsWith('#'));
  const variantUrl = new URL(variantName, grant.url).href;
  const variant = await getText(variantUrl);
  const mediaNames = variant.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  const mapName = variant.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
  if (!mapName || !mediaNames.length || !variant.includes('#EXT-X-ENDLIST')) throw new Error('Invalid HLS media playlist');
  for (const name of [mapName, mediaNames[0]]) {
    const response = await retry(`Verify ${name}`, async () => {
      const result = await fetch(new URL(name, variantUrl), { signal: AbortSignal.timeout(30000) });
      if (!result.ok) throw await responseError(result, `HLS file ${name}`);
      return result;
    });
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw new Error(`Empty HLS file: ${name}`);
  }
  return { url: grant.url, rendition: variantName, firstSegment: mediaNames[0] };
};

const assets = await d1Query(`SELECT
  a.id AS asset_id, a.source_object_key, a.source_size_bytes, a.source_etag,
  e.episode_no, e.id AS episode_id, s.id AS series_id, s.title AS series_title
FROM series s
JOIN episodes e ON e.series_id = s.id
JOIN media_assets a ON a.id = e.active_media_asset_id
WHERE s.deleted_at IS NULL AND e.deleted_at IS NULL
  AND a.deleted_at IS NULL AND a.status = 'ready' AND a.storage_provider = 'r2'
  AND a.source_object_key LIKE 'originals/%' AND a.source_content_type = 'video/mp4'
ORDER BY s.title, e.episode_no`);
const limit = values.limit === undefined ? assets.length : Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
console.log(`Found ${assets.length} active playable R2 assets; processing up to ${Math.min(limit, assets.length)}.`);

const ffmpegPath = values['ffmpeg-path'] || process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = values['ffprobe-path'] || process.env.FFPROBE_PATH || 'ffprobe';
const summary = { total: assets.length, processed: 0, converted: 0, skipped: 0, failed: 0 };
for (const asset of assets.slice(0, limit)) {
  const assetState = state.assets[asset.asset_id] ||= {};
  console.log(`\n[${summary.processed + 1}/${Math.min(limit, assets.length)}] ${asset.series_title} episode ${asset.episode_no} (${asset.asset_id})`);
  try {
    const current = await grantFor(asset, 'auto');
    if (current.delivery === 'hls' && !values['rebuild-hls']) {
      await verifyHls(asset);
      assetState.status = 'verified';
      assetState.verifiedAt = new Date().toISOString();
      summary.skipped += 1;
      console.log('Already HLS; verified and skipped.');
      saveState();
      summary.processed += 1;
      continue;
    }
    const assetDir = join(workDir, asset.asset_id);
    const source = join(assetDir, 'source.mp4');
    const output = join(assetDir, 'hls');
    mkdirSync(assetDir, { recursive: true });
    assetState.status = 'downloading';
    saveState();
    const sourceEtag = await downloadSource(asset, source, assetState);
    assetState.status = 'transcoding';
    saveState();
    const localReady = existsSync(join(output, 'ready.json'))
      ? JSON.parse(readFileSync(join(output, 'ready.json'), 'utf8')) : null;
    if (localReady?.sourceEtag !== sourceEtag || localReady?.assetId !== asset.asset_id
      || localReady?.encodingProfile !== 'h264-hq1080-v2') {
      rmSync(output, { recursive: true, force: true });
      await run(process.execPath, [join(projectRoot, 'scripts/prepare-hls-video.mjs'),
        '--input', source, '--output', output, '--asset-id', asset.asset_id,
        '--source-etag', sourceEtag],
      { FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath });
    }
    assetState.status = 'publishing';
    saveState();
    await run(process.execPath, [join(projectRoot, 'scripts/publish-hls-video.mjs'), '--directory', output, '--upload']);
    assetState.status = 'verifying';
    saveState();
    assetState.verification = await verifyHls(asset);
    assetState.status = 'verified';
    assetState.verifiedAt = new Date().toISOString();
    delete assetState.error;
    summary.converted += 1;
    saveState();
    if (!values.keep) rmSync(assetDir, { recursive: true, force: true });
    console.log('Published and verified HLS.');
  } catch (error) {
    assetState.status = 'failed';
    assetState.error = { message: error.message, at: new Date().toISOString() };
    summary.failed += 1;
    saveState();
    console.error(`Failed ${asset.asset_id}: ${error.stack || error.message}`);
  }
  summary.processed += 1;
}
console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exitCode = 1;
