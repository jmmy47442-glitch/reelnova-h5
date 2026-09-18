import { createFile } from 'mp4box';

// Limit metadata parsing in both the browser and the media Worker. The actual
// video stays in R2; validation never downloads the complete source.
export const MP4_PROBE_BYTES = 16 * 1024 * 1024;

const createInspector = (requireFaststart) => {
  const parser = createFile();
  let result;
  let failure;
  parser.onError = () => { failure = new Error('无法解析 MP4，请重新导出 H.264 + AAC 视频'); };
  parser.onReady = (info) => {
    const video = info.videoTracks[0];
    const audio = info.audioTracks[0];
    if ((requireFaststart && !info.isProgressive) || info.isFragmented) {
      failure = new Error('MP4 必须开启 faststart（网页优化），请重新导出');
      return;
    }
    if (info.videoTracks.length !== 1 || info.audioTracks.length !== 1
      || !/^avc1\.(42|4d|58|64)[0-9a-f]{4}$/i.test(video?.codec || '')
      || audio?.codec !== 'mp4a.40.2') {
      failure = new Error('仅支持单视频轨 H.264（8 位）+ 单音轨 AAC-LC 的 MP4');
      return;
    }
    const durationSeconds = info.timescale ? info.duration / info.timescale : 0;
    const width = Math.round(video.video?.width || video.track_width || 0);
    const height = Math.round(video.video?.height || video.track_height || 0);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 21600 || !width || !height) {
      failure = new Error('视频时长或画面尺寸无效，最长支持 6 小时');
      return;
    }
    result = { durationSeconds, width, height, hasVideo: true, hasAudio: true };
  };
  return {
    parser,
    result: () => { if (failure) throw failure; return result; },
  };
};

/**
 * @param {ArrayBuffer & { fileStart?: number }} buffer
 * @returns {{ durationSeconds: number, width: number, height: number, hasVideo: boolean, hasAudio: boolean }}
 */
export const inspectDirectMp4 = (buffer) => {
  const inspector = createInspector(true);
  try {
    buffer.fileStart = 0;
    inspector.parser.appendBuffer(buffer);
    const result = inspector.result();
    if (!result) throw new Error('MP4 元数据不完整或不在文件前 16 MB 内，请使用 faststart 重新导出');
    return result;
  } finally { inspector.parser.stop(); }
};

// Existing R2 originals may have moov after mdat. Browsers can play those via
// Range requests. Follow the parser's offsets to skip video bytes while still
// checking codecs/tracks, with bounded reads even for corrupt object metadata.
// New uploads continue to require faststart through inspectDirectMp4 above.
export const inspectStoredMp4 = async (size, readRange) => {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid MP4 object size');
  const inspector = createInspector(false);
  let offset = 0;
  let bytesRead = 0;
  try {
    for (let request = 0; request < 32 && offset < size && bytesRead < MP4_PROBE_BYTES; request += 1) {
      const length = Math.min(512 * 1024, size - offset, MP4_PROBE_BYTES - bytesRead);
      const buffer = await readRange(offset, length);
      if (buffer.byteLength !== length) throw new Error('Incomplete MP4 metadata read');
      buffer.fileStart = offset;
      bytesRead += buffer.byteLength;
      const nextOffset = inspector.parser.appendBuffer(buffer);
      const result = inspector.result();
      if (result) return result;
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset >= size) break;
      offset = nextOffset;
    }
    throw new Error('MP4 metadata is incomplete or exceeds the inspection limit');
  } finally { inspector.parser.stop(); }
};
