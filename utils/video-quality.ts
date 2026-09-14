export type VideoQualityPreference = 'auto' | 'original' | number;

export interface VideoQualityLevel {
  index: number;
  width: number;
  height: number;
  resolution: number;
  bitrate: number;
  label: string;
}

interface HlsLevelLike {
  width?: number;
  height?: number;
  bitrate?: number;
}

const levelLabel = (height: number, bitrate: number, index: number) => {
  if (height > 0) return `${height}P`;
  if (bitrate > 0) return `${(bitrate / 1_000_000).toFixed(bitrate >= 10_000_000 ? 0 : 1)} Mbps`;
  return `Level ${index + 1}`;
};

export const normalizeVideoQualityLevels = (levels: HlsLevelLike[]): VideoQualityLevel[] => {
  const ranked = levels.map((level, index) => {
    const width = Math.max(0, Number(level.width) || 0);
    const height = Math.max(0, Number(level.height) || 0);
    const bitrate = Math.max(0, Number(level.bitrate) || 0);
    // Portrait videos use the short edge too: 1080 x 1882 is 1080P.
    const resolution = width && height ? Math.min(width, height) : height || width;
    return { index, width, height, resolution, bitrate, label: levelLabel(resolution, bitrate, index) };
  }).sort((left, right) => right.resolution - left.resolution || right.bitrate - left.bitrate);

  const uniqueLevels = new Map<string, VideoQualityLevel>();
  ranked.forEach((level) => {
    const key = level.resolution > 0 ? `resolution:${level.resolution}` : `bitrate:${level.bitrate}`;
    if (!uniqueLevels.has(key)) uniqueLevels.set(key, level);
  });
  return [...uniqueLevels.values()];
};

export const parseHlsQualityManifest = (manifest: string) => normalizeVideoQualityLevels(
  [...manifest.matchAll(/^#EXT-X-STREAM-INF:([^\r\n]+)$/gm)].map((match) => {
    const attributes = match[1] || '';
    const resolution = /(?:^|,)RESOLUTION=(\d+)x(\d+)(?:,|$)/i.exec(attributes);
    const bandwidth = /(?:^|,)BANDWIDTH=(\d+)(?:,|$)/i.exec(attributes);
    return {
      width: Number(resolution?.[1] || 0),
      height: Number(resolution?.[2] || 0),
      bitrate: Number(bandwidth?.[1] || 0),
    };
  }),
);

export const resolveVideoQualityLevel = (
  levels: VideoQualityLevel[],
  preference: VideoQualityPreference,
) => {
  if (preference === 'auto' || !levels.length) return -1;
  if (preference === 'original') return levels[0]!.index;
  return (levels.find((level) => level.resolution === preference) || levels[0])!.index;
};
