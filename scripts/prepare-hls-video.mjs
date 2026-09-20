import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, output: { type: 'string' }, 'asset-id': { type: 'string' },
  'source-etag': { type: 'string' }, bucket: { type: 'string', default: 'reelnova-media-private' },
  upload: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('npm run media:prepare-hls -- --input source.mp4 --output NEW_DIRECTORY --asset-id media_UUID --source-etag RAW_R2_ETAG [--upload]');
  process.exit(0);
}
if (!values.input || !values.output || !/^media_[0-9a-f-]{36}$/i.test(values['asset-id'] || '') || !values['source-etag']) {
  throw new Error('Required: --input, --output, --asset-id and --source-etag.');
}
const run = (command, args, capture = false) => {
  const result = spawnSync(command, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited with ${result.status}`);
  return result.stdout;
};
const input = resolve(values.input), output = resolve(values.output);
const probe = JSON.parse(run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', input], true));
const video = probe.streams.find(s => s.codec_type === 'video');
if (!video || !probe.streams.some(s => s.codec_type === 'audio')) throw new Error('Input requires video and audio tracks.');
const rotation = Number(video.side_data_list?.find(s => s.rotation !== undefined)?.rotation || 0);
const [width, height] = Math.abs(rotation) % 180 === 90 ? [video.height, video.width] : [video.width, video.height];
mkdirSync(output); // A fresh directory prevents stale segments entering a build.
const sourceEtag = values['source-etag'].replace(/^"|"$/g, '');
const assetId = values['asset-id'], buildId = randomUUID();
const root = `hls/${assetId}/${encodeURIComponent(sourceEtag)}`;
const renditions = [], files = [];
for (const [shortEdge, videoRate] of [[360, 500], [480, 900], [720, 1800], [1080, 4000]]) {
  if (shortEdge > Math.min(width, height) && renditions.length) continue;
  const scale = Math.min(1, shortEdge / Math.min(width, height));
  const w = Math.max(2, Math.floor(width * scale / 2) * 2), h = Math.max(2, Math.floor(height * scale / 2) * 2);
  // Let x264 select a level that fits the actual frame size (including
  // portrait and ultrawide sources), then advertise that level in HLS.
  const id = `v${shortEdge}`, directory = join(output, id);
  mkdirSync(directory);
  run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-n', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0', '-vf', `scale=${w}:${h},setsar=1,fps=30`,
    '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-preset', 'fast',
    '-b:v', `${videoRate}k`, '-maxrate', `${videoRate}k`, '-bufsize', `${videoRate * 2}k`,
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-flags', '+cgop',
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '96k', '-ac', '2', '-ar', '48000',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-hls_flags', 'independent_segments', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(directory, 'seg-%06d.m4s'), join(directory, 'index.m3u8')]);
  const manifest = readFileSync(join(directory, 'index.m3u8'), 'utf8');
  const durations = [...manifest.matchAll(/#EXTINF:([\d.]+),\s*\n(seg-\d{6}\.m4s)/g)];
  if (!durations.length || !manifest.includes('#EXT-X-ENDLIST') || durations.some(m => Number(m[1]) > 2.1)) {
    throw new Error(`Invalid independent 2-second playlist: ${id}`);
  }
  let peak = 0;
  durations.forEach((m, i) => {
    if (m[2] !== `seg-${String(i).padStart(6, '0')}.m4s`) throw new Error('Segment sequence is incomplete');
    const size = statSync(join(directory, m[2])).size;
    if (!size || size > 8 * 1024 * 1024) throw new Error('Invalid segment size');
    peak = Math.max(peak, size * 8 / Number(m[1]));
  });
  const encoded = JSON.parse(run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=level', '-of', 'json', join(directory, 'index.m3u8')], true));
  const level = encoded.streams?.[0]?.level;
  if (!Number.isInteger(level) || level <= 0 || level > 255) throw new Error(`Invalid H.264 level: ${id}`);
  renditions.push({ id, width: w, height: h, codecs: `avc1.4d40${level.toString(16).padStart(2, '0')},mp4a.40.2`,
    bandwidth: Math.ceil(Math.max(peak, (videoRate + 96) * 1000)), segments: durations.length });
  files.push(...readdirSync(directory).map(name => `${id}/${name}`));
}
const master = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n' + renditions.map(v =>
  `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height},CODECS="${v.codecs}"\n${v.id}/index.m3u8\n`).join('');
writeFileSync(join(output, 'master.m3u8'), master);
files.push('master.m3u8');
writeFileSync(join(output, 'ready.json'), JSON.stringify({ version: 1, encodingProfile: 'h264-1080-v1', assetId, sourceEtag, buildId, renditions }, null, 2));
if (values.upload) {
  // Publish the readiness marker last. Incomplete uploads never replace the
  // active package; immutable build prefixes protect existing signed grants.
  for (const file of files) run('npx', ['wrangler', 'r2', 'object', 'put', `${values.bucket}/${root}/${buildId}/${file}`,
    '--file', join(output, file), '--content-type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4', '--remote']);
  run('npx', ['wrangler', 'r2', 'object', 'put', `${values.bucket}/${root}/ready.json`, '--file', join(output, 'ready.json'), '--content-type', 'application/json', '--remote']);
}
console.log(JSON.stringify({ output, prefix: `${root}/${buildId}/`, renditions, uploaded: values.upload }, null, 2));
