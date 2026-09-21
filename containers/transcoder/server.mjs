import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const port = Number(process.env.PORT || 8080);
const mountRoot = resolve(process.env.R2_MOUNT_PATH || '/mnt/r2');
const workRoot = '/tmp/reelnova-transcode';
const jobPattern = /^transcode_media_[0-9a-f-]{36}$/i;
const assetPattern = /^media_[0-9a-f-]{36}$/i;
const buildPattern = /^[0-9a-f-]{36}$/i;
const objectPattern = /^originals\/[a-z0-9_-]{2,100}\/[a-z0-9_-]{2,100}\/[a-z0-9_-]{2,100}\/[a-z0-9_.-]{2,160}$/i;

const sendJson = (response, status, body) => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) });
  response.end(encoded);
};

const readJson = async (request) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const safeMountedPath = (key) => {
  const target = resolve(mountRoot, key);
  if (!target.startsWith(`${mountRoot}${sep}`)) throw new Error('Invalid R2 object path');
  return target;
};

const run = (command, args) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0
    ? resolvePromise()
    : reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`)));
});

const capture = (command, args) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  let stderr = '';
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0
    ? resolvePromise(Buffer.concat(stdout).toString('utf8'))
    : reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`)));
});

const validateJob = (body) => {
  const job = {
    jobId: String(body?.jobId || ''),
    assetId: String(body?.assetId || ''),
    sourceObjectKey: String(body?.sourceObjectKey || ''),
    sourceEtag: String(body?.sourceEtag || ''),
    buildId: String(body?.buildId || ''),
  };
  if (!jobPattern.test(job.jobId) || !assetPattern.test(job.assetId)
    || !objectPattern.test(job.sourceObjectKey) || !/^[a-zA-Z0-9_-]{8,160}$/.test(job.sourceEtag)
    || !buildPattern.test(job.buildId)) throw new Error('Invalid transcode job');
  return job;
};

const inspectReadyMarker = async (path, job) => {
  try {
    const ready = JSON.parse(await readFile(path, 'utf8'));
    return ready.version === 1 && ready.assetId === job.assetId && ready.sourceEtag === job.sourceEtag
      && ready.buildId === job.buildId && Array.isArray(ready.renditions) ? ready : null;
  } catch { return null; }
};

const transcode = async (body) => {
  const job = validateJob(body);
  const encodedEtag = encodeURIComponent(job.sourceEtag);
  const packageRoot = safeMountedPath(`hls/${job.assetId}/${encodedEtag}`);
  const readyPath = join(packageRoot, 'ready.json');
  const existing = await inspectReadyMarker(readyPath, job);
  if (existing) return { ...existing, prefix: `hls/${job.assetId}/${encodedEtag}/${job.buildId}/`, reused: true };
  // A prior attempt may have uploaded only part of this build. Remove that
  // incomplete prefix before regenerating so stale segments cannot accumulate.
  await rm(packageRoot, { recursive: true, force: true });

  const source = safeMountedPath(job.sourceObjectKey);
  const sourceStats = await stat(source);
  if (!sourceStats.isFile() || sourceStats.size < 1024) throw new Error('Source video is missing or empty');
  const workDir = join(workRoot, job.jobId);
  const buildTarget = join(packageRoot, job.buildId);
  // Segment files are closed every two seconds and flushed through FUSE to R2.
  // Keeping the complete multi-rendition package on the 16 GB ephemeral disk
  // would make the advertised 20 GB / six-hour input limits impossible.
  const outputDir = buildTarget;
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(buildTarget, { recursive: true });

  try {
    const probe = JSON.parse(await capture('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source]));
    const videos = probe.streams?.filter(stream => stream.codec_type === 'video') || [];
    const audios = probe.streams?.filter(stream => stream.codec_type === 'audio') || [];
    if (videos.length !== 1 || audios.length < 1) throw new Error('Source requires exactly one video track and at least one audio track');
    const video = videos[0];
    const durationSeconds = Number(probe.format?.duration || video.duration || 0);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 21_600) {
      throw new Error('Video duration is invalid or exceeds 6 hours');
    }
    const rotation = Number(video.side_data_list?.find(item => item.rotation !== undefined)?.rotation || 0);
    const sourceWidth = Number(video.width || 0), sourceHeight = Number(video.height || 0);
    const [width, height] = Math.abs(rotation) % 180 === 90
      ? [sourceHeight, sourceWidth] : [sourceWidth, sourceHeight];
    if (!width || !height) throw new Error('Video dimensions are invalid');

    const renditions = [];
    for (const [shortEdge, videoRate] of [[360, 500], [480, 900], [720, 4500], [1080, 8000]]) {
      if (shortEdge > Math.min(width, height) && renditions.length) continue;
      const scale = Math.min(1, shortEdge / Math.min(width, height));
      const outputWidth = Math.max(2, Math.floor(width * scale / 2) * 2);
      const outputHeight = Math.max(2, Math.floor(height * scale / 2) * 2);
      const id = `v${shortEdge}`;
      const directory = join(outputDir, id);
      await mkdir(directory, { recursive: true });
      const rateControl = shortEdge >= 720 ? ['-crf', '20'] : ['-b:v', `${videoRate}k`];
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-i', source,
        '-map', '0:v:0', '-map', '0:a:0', '-vf', `scale=${outputWidth}:${outputHeight},setsar=1,fps=30`,
        '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-preset', shortEdge >= 720 ? 'medium' : 'fast',
        ...rateControl, '-maxrate', `${videoRate}k`, '-bufsize', `${videoRate * 2}k`,
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-flags', '+cgop',
        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '96k', '-ac', '2', '-ar', '48000',
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
        '-hls_flags', 'independent_segments', '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', join(directory, 'seg-%06d.m4s'), join(directory, 'index.m3u8')]);

      const manifest = await readFile(join(directory, 'index.m3u8'), 'utf8');
      const durations = [...manifest.matchAll(/#EXTINF:([\d.]+),\s*\n(seg-\d{6}\.m4s)/g)];
      if (!durations.length || !manifest.includes('#EXT-X-ENDLIST') || durations.some(match => Number(match[1]) > 2.1)) {
        throw new Error(`Invalid 2-second HLS playlist: ${id}`);
      }
      let peak = 0;
      for (const [index, match] of durations.entries()) {
        if (match[2] !== `seg-${String(index).padStart(6, '0')}.m4s`) throw new Error(`Incomplete HLS sequence: ${id}`);
        const segment = await stat(join(directory, match[2]));
        if (!segment.size || segment.size > 8 * 1024 * 1024) throw new Error(`Invalid HLS segment: ${id}/${match[2]}`);
        peak = Math.max(peak, segment.size * 8 / Number(match[1]));
      }
      const encoded = JSON.parse(await capture('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=level', '-of', 'json', join(directory, 'index.m3u8')]));
      const level = encoded.streams?.[0]?.level;
      if (!Number.isInteger(level) || level <= 0 || level > 255) throw new Error(`Invalid H.264 level: ${id}`);
      renditions.push({ id, width: outputWidth, height: outputHeight,
        codecs: `avc1.4d40${level.toString(16).padStart(2, '0')},mp4a.40.2`,
        bandwidth: Math.ceil(peak), segments: durations.length });
    }

    const master = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n' + renditions.map(rendition =>
      `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},RESOLUTION=${rendition.width}x${rendition.height},CODECS="${rendition.codecs}"\n${rendition.id}/index.m3u8\n`).join('');
    await writeFile(join(outputDir, 'master.m3u8'), master);
    const ready = {
      version: 1, encodingProfile: 'h264-container-hq1080-v1', assetId: job.assetId,
      sourceEtag: job.sourceEtag, buildId: job.buildId, renditions,
      media: { width, height, durationSeconds, hasVideo: true, hasAudio: true },
      completedAt: new Date().toISOString(),
    };
    await writeFile(join(workDir, 'ready.json'), JSON.stringify(ready));

    await run('sync', []);
    await copyFile(join(workDir, 'ready.json'), readyPath);
    await run('sync', []);
    return { ...ready, prefix: `hls/${job.assetId}/${encodedEtag}/${job.buildId}/`, reused: false };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://container');
  if (request.method === 'GET' && url.pathname === '/ping') return sendJson(response, 200, { ready: true });
  if (request.method !== 'POST' || url.pathname !== '/transcode') return sendJson(response, 404, { error: 'Not found' });
  try {
    const result = await transcode(await readJson(request));
    return sendJson(response, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcode failed';
    console.error(JSON.stringify({ event: 'transcode_failed', error: message, id: randomUUID() }));
    return sendJson(response, 422, { error: message.slice(0, 1000) });
  }
}).listen(port, '0.0.0.0', () => console.log(`ReelNova transcoder listening on ${port}`));
