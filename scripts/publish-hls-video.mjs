import { parseArgs } from 'node:util';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const { values } = parseArgs({ options: {
  directory: { type: 'string' }, bucket: { type: 'string', default: 'reelnova-media-private' },
  upload: { type: 'boolean', default: false },
} });
if (!values.directory) throw new Error('Required: --directory PATH [--upload]. Without --upload, validates the local package only.');
const directory = resolve(values.directory);
const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
if (ready.version !== 1 || !/^media_[0-9a-f-]{36}$/i.test(ready.assetId || '')
  || !/^[0-9a-f-]{36}$/i.test(ready.buildId || '') || typeof ready.sourceEtag !== 'string' || !ready.sourceEtag
  || !Array.isArray(ready.renditions) || !ready.renditions.length || ready.renditions.length > 3) throw new Error('Invalid HLS package');
const files = ['master.m3u8'];
const levels = new Set();
const master = readFileSync(join(directory, 'master.m3u8'), 'utf8');
for (const rendition of ready.renditions) {
  if (!/^v(360|480|720)$/.test(rendition.id) || levels.has(rendition.id)
    || !Number.isInteger(rendition.segments) || rendition.segments < 1 || rendition.segments > 10801) throw new Error('Invalid rendition');
  levels.add(rendition.id);
  if (!master.split(/\r?\n/).includes(`${rendition.id}/index.m3u8`)) throw new Error('Missing master playlist entry');
  const manifest = readFileSync(join(directory, rendition.id, 'index.m3u8'), 'utf8');
  const segments = manifest.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  if (!manifest.startsWith('#EXTM3U') || !manifest.includes('#EXT-X-ENDLIST')
    || !manifest.includes('#EXT-X-MAP:URI="init.mp4"') || segments.length !== rendition.segments) throw new Error('Incomplete rendition playlist');
  files.push(`${rendition.id}/index.m3u8`, `${rendition.id}/init.mp4`);
  segments.forEach((name, i) => {
    if (name !== `seg-${String(i).padStart(6, '0')}.m4s`) throw new Error('Invalid segment sequence');
    files.push(`${rendition.id}/${name}`);
  });
}
let totalBytes = 0;
for (const file of files) {
  const size = statSync(join(directory, file)).size;
  if (size <= 0 || size > 8 * 1024 * 1024) throw new Error(`Invalid file size: ${file}`);
  totalBytes += size;
}
const root = `hls/${ready.assetId}/${encodeURIComponent(ready.sourceEtag)}`;
const prefix = `${root}/${ready.buildId}/`;
console.log(JSON.stringify({ validated: true, prefix, files: files.length, totalBytes, upload: values.upload }));
if (!values.upload) process.exit(0);
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
if (!account || !token) throw new Error('Load CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN before publishing.');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${encodeURIComponent(values.bucket)}/objects/`;
const urlFor = key => base + key.split('/').map(encodeURIComponent).join('/');
const headers = { authorization: `Bearer ${token}` };
const backup = await fetch(urlFor(`${root}/ready.json`), { headers, signal: AbortSignal.timeout(30000) });
if (backup.ok) writeFileSync(join(directory, 'previous-ready.json'), await backup.text());
else if (backup.status !== 404) throw new Error(`Cannot check previous package: HTTP ${backup.status}`);
const put = async (key, file, type) => {
  const bytes = readFileSync(join(directory, file));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(urlFor(key), { method: 'PUT', headers: { ...headers,
        'content-type': type, 'content-length': String(bytes.length) }, body: bytes, signal: AbortSignal.timeout(60000) });
      if (response.ok) { await response.body?.cancel(); return; }
      const status = response.status;
      await response.body?.cancel();
      if (status !== 429 && status < 500) throw Object.assign(new Error(`Upload ${file}: HTTP ${status}`), { permanent: true });
      throw new Error(`Upload ${file}: HTTP ${status}`);
    } catch (error) {
      if (error.permanent || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
};
let cursor = 0, complete = 0, failed;
const started = Date.now();
await Promise.all(Array.from({ length: 4 }, async () => {
  while (!failed && cursor < files.length) {
    const file = files[cursor++];
    try {
      await put(`${prefix}${file}`, file, file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
      complete++;
      if (complete % 25 === 0) console.log(`Uploaded ${complete}/${files.length}`);
    } catch (error) { failed = error; }
  }
}));
if (failed) throw failed;
await put(`${root}/ready.json`, 'ready.json', 'application/json');
console.log(JSON.stringify({ published: true, prefix, files: complete, totalBytes, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
