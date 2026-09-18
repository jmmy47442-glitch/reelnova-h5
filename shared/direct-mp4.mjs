import { createFile } from 'mp4box';

// Limit metadata parsing in both the browser and the media Worker. The actual
// video stays in R2; validation never downloads the complete source.
export const MP4_PROBE_BYTES = 16 * 1024 * 1024;

/**
 * @param {ArrayBuffer & { fileStart?: number }} buffer
 * @returns {{ durationSeconds: number, width: number, height: number, hasVideo: boolean, hasAudio: boolean }}
 */
export const inspectDirectMp4 = (buffer) => {
  const parser = createFile();
  let result;
  let failure;
  parser.onError = () => { failure = new Error('无法解析 MP4，请重新导出 H.264 + AAC 视频'); };
  parser.onReady = (info) => {
    const video = info.videoTracks[0];
    const audio = info.audioTracks[0];
    if (!info.isProgressive || info.isFragmented) {
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
  buffer.fileStart = 0;
  parser.appendBuffer(buffer);
  parser.stop();
  if (failure) throw failure;
  if (!result) throw new Error('MP4 元数据不完整或不在文件前 16 MB 内，请使用 faststart 重新导出');
  return result;
};
