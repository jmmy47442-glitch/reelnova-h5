import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { inspectDirectMp4, MP4_PROBE_BYTES } from '../shared/direct-mp4.mjs';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, output: { type: 'string' }, 'asset-id': { type: 'string' },
  'source-etag': { type: 'string' }, bucket: { type: 'string', default: 'reelnova-media-private' },
  upload: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('node scripts/prepare-mobile-video.mjs --input source.mp4 --output mobile.mp4 --asset-id media_UUID --source-etag RAW_R2_ETAG [--upload] [--bucket name]');
  process.exit(0);
}
if (!values.input || !values.output || !/^media_[0-9a-f-]{36}$/i.test(values['asset-id'] || '') || !values['source-etag']) {
  throw new Error('Required: --input, --output, --asset-id and --source-etag (the current original R2 ETag).');
}
const input = resolve(values.input), output = resolve(values.output);
if (input === output) throw new Error('Output must not overwrite the original.');
mkdirSync(dirname(output), { recursive: true });
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw new Error(`${command} is required: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
};
run('ffmpeg', ['-n', '-i', input, '-map', '0:v:0', '-map', '0:a:0',
  '-vf', "scale=w='min(480,iw)':h=-2", '-c:v', 'libx264', '-profile:v', 'main',
  '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '26', '-maxrate', '900k', '-bufsize', '1800k',
  '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '96k', '-movflags', '+faststart', output]);
const size = statSync(output).size;
const probe = new Uint8Array(Math.min(size, MP4_PROBE_BYTES));
const descriptor = openSync(output, 'r');
try { readSync(descriptor, probe); } finally { closeSync(descriptor); }
const media = inspectDirectMp4(probe);
if (size >= statSync(input).size) throw new Error('Mobile output is not smaller than the original; it will not be selected.');
const etag = values['source-etag'].replace(/^"|"$/g, '');
const objectKey = `variants/${values['asset-id']}/${encodeURIComponent(etag)}/mobile.mp4`;
const args = ['wrangler', 'r2', 'object', 'put', `${values.bucket}/${objectKey}`, '--file', output, '--content-type', 'video/mp4', '--remote'];
writeFileSync(`${output}.json`, JSON.stringify({ objectKey, sourceEtag: etag, size, media, uploadCommand: ['npx', ...args] }, null, 2));
if (values.upload) run('npx', args);
console.log(JSON.stringify({ output, objectKey, size, uploaded: values.upload, metadata: `${output}.json` }, null, 2));
