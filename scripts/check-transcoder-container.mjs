// Checks the real image's FFmpeg pipeline against a local filesystem mount.
// This does not replace the live R2/FUSE/Cloudflare Workflow integration check.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'reelnova-ffmpeg-check-'));
const name = `reelnova-ffmpeg-check-${crypto.randomUUID()}`;
const assetId = `media_${crypto.randomUUID()}`;
const job = { assetId, jobId: `transcode_${assetId}`, sourceObjectKey: `originals/series-test/episode-test/${assetId}/source.mp4`,
  sourceEtag: 'fixture-etag', buildId: crypto.randomUUID() };
let started = false;
try {
  const source = join(directory, job.sourceObjectKey);
  await mkdir(dirname(source), { recursive: true });
  await copyFile(new URL('../tests/fixtures/media/unsupported-video.mp4', import.meta.url), source);
  await exec('docker', ['run', '--detach', '--rm', '--platform', 'linux/amd64', '--name', name,
    '-p', '127.0.0.1::8080', '--mount', `type=bind,source=${directory},target=/mnt/r2`,
    '--entrypoint', 'node', process.env.TRANSCODER_TEST_IMAGE || 'reelnova-transcoder:upload-fix', '/app/server.mjs']);
  started = true;
  const { stdout } = await exec('docker', ['port', name, '8080/tcp']);
  const base = `http://${stdout.trim()}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await fetch(`${base}/ping`).then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  for (const reused of [false, true]) {
    const response = await fetch(`${base}/transcode`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job), signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.equal(result.reused, reused);
    assert.ok(result.renditions.length > 0);
    assert.ok(result.media.durationSeconds > 0 && result.media.hasVideo && result.media.hasAudio);
    const master = await readFile(join(directory, result.prefix, 'master.m3u8'), 'utf8');
    assert.match(master, /#EXT-X-STREAM-INF/);
    for (const rendition of result.renditions) {
      const playlist = await readFile(join(directory, result.prefix, rendition.id, 'index.m3u8'), 'utf8');
      assert.match(playlist, /#EXT-X-ENDLIST/);
      await exec('docker', ['exec', name, 'ffmpeg', '-v', 'error', '-i', `/mnt/r2/${result.prefix}${rendition.id}/index.m3u8`, '-f', 'null', '-']);
    }
    console.log(`PASS real FFmpeg HLS: ${reused ? 'idempotent reuse' : 'encode'}, all renditions decoded successfully`);
  }
} finally {
  if (started) await exec('docker', ['stop', '--time', '2', name]);
  await rm(directory, { recursive: true, force: true });
}
