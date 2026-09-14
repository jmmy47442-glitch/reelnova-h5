import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVideoQualityLevels, parseHlsQualityManifest, resolveVideoQualityLevel } from '../utils/video-quality.ts';

const levels = normalizeVideoQualityLevels([
  { width: 640, height: 360, bitrate: 800_000 },
  { width: 1920, height: 1080, bitrate: 5_000_000 },
  { width: 1280, height: 720, bitrate: 2_500_000 },
  { width: 1920, height: 1080, bitrate: 4_000_000 },
]);

test('quality levels are presented from original resolution downward without duplicates', () => {
  assert.deepEqual(levels.map(({ index, label }) => ({ index, label })), [
    { index: 1, label: '1080P' },
    { index: 2, label: '720P' },
    { index: 0, label: '360P' },
  ]);
});

test('original selects the highest rendition and auto restores adaptive playback', () => {
  assert.equal(resolveVideoQualityLevel(levels, 'original'), 1);
  assert.equal(resolveVideoQualityLevel(levels, 720), 2);
  assert.equal(resolveVideoQualityLevel(levels, 'auto'), -1);
});

test('quality choices can be discovered from a Stream master manifest before playback', () => {
  const manifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401e"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028"
1080p.m3u8`;
  assert.deepEqual(parseHlsQualityManifest(manifest).map(level => level.label), ['1080P', '360P']);
});

test('portrait Stream renditions use their short edge for labels and selection', () => {
  const portrait = normalizeVideoQualityLevels([
    { width: 720, height: 1254, bitrate: 2_518_597 },
    { width: 1080, height: 1882, bitrate: 4_731_455 },
    { width: 480, height: 836, bitrate: 1_411_357 },
  ]);
  assert.deepEqual(portrait.map(level => level.label), ['1080P', '720P', '480P']);
  assert.equal(resolveVideoQualityLevel(portrait, 720), 0);
  assert.equal(resolveVideoQualityLevel(portrait, 'original'), 1);
});
