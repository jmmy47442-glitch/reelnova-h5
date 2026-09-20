import Hls from 'hls.js';

// Manual levels disable hls.js's emergency downswitch. Re-enable ABR only
// when a main video fragment is too slow and playback is about to run dry.
// Keep decoded buffer and the playhead when replacing an oversized request.
export const attachHlsQualityRecovery = (hls: Hls, onRecover: () => void) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let restoreCapping: (() => void) | undefined;
  let pending: object | undefined;
  const clear = () => { if (timer) clearInterval(timer); timer = undefined; pending = undefined; };
  const finishRecovery = () => {
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = undefined;
    restoreCapping?.();
    restoreCapping = undefined;
  };

  hls.on(Hls.Events.FRAG_LOADING, (_event, { frag }) => {
    // Stream uses separate audio requests; they must not reset the video timer.
    if (frag.type !== 'main' || frag.sn === 'initSegment') return;
    clear();
    pending = frag;
    const requestedAt = performance.now();
    timer = setInterval(() => {
      const stats = frag.stats;
      if (hls.autoLevelEnabled || stats.aborted || (stats.total > 0 && stats.loaded >= stats.total)) {
        clear();
        return;
      }
      const media = hls.media;
      if (!media || media.paused || media.ended || !media.playbackRate || frag.level <= hls.minAutoLevel) return;
      const rate = Math.abs(media.playbackRate);
      const elapsed = performance.now() - requestedAt;
      // Do not react to a brief delay, and respect the amount of play time
      // supplied by a segment (including playback at 1.5x or 2x).
      if (elapsed < Math.max(3000, frag.duration / rate * 1000)) return;
      let ahead = 0;
      for (let index = 0; index < media.buffered.length; index += 1) {
        if (media.buffered.start(index) <= media.currentTime && media.buffered.end(index) > media.currentTime) {
          ahead = (media.buffered.end(index) - media.currentTime) / rate;
          break;
        }
      }
      if (ahead > 2) return;
      clear();
      finishRecovery();
      const capToPlayerSize = hls.capLevelToPlayerSize;
      const previousCap = hls.autoLevelCapping;
      // A small/cached low-quality segment can suggest an unrealistically
      // fast link. Avoid immediately retrying the rendition that just stalled.
      if (capToPlayerSize) hls.capLevelToPlayerSize = false;
      hls.autoLevelCapping = Math.max(hls.minAutoLevel,
        Math.min(frag.level - 1, previousCap < 0 ? Infinity : previousCap));
      restoreCapping = () => {
        hls.autoLevelCapping = previousCap;
        if (capToPlayerSize) hls.capLevelToPlayerSize = true;
      };
      let stableSeconds = 0;
      let lastPosition = media.currentTime;
      recoveryTimer = setInterval(() => {
        if (!hls.autoLevelEnabled) { finishRecovery(); return; }
        const advanced = media.currentTime - lastPosition;
        lastPosition = media.currentTime;
        if (media.paused || media.seeking) return;
        if (media.readyState < 3) stableSeconds = 0;
        else if (advanced > 0 && advanced < 3) stableSeconds += Math.min(advanced, 1);
        if (stableSeconds >= 30) finishRecovery();
      }, 1000);
      hls.loadLevel = -1;
      hls.bandwidthEstimate = hls.config.abrEwmaDefaultEstimate;
      hls.nextAutoLevel = hls.minAutoLevel;
      onRecover();
      // An almost finished response is worth keeping. Otherwise cancel the
      // slow request now, including when it has not delivered a first byte.
      // stop/startLoad preserves MediaSource and all already buffered data.
      if (!stats.total || stats.loaded < stats.total * 0.9) {
        hls.stopLoad();
        hls.startLevel = hls.minAutoLevel;
        hls.startLoad(media.currentTime, true);
      }
    }, 250);
  });
  hls.on(Hls.Events.FRAG_LOADED, (_event, { frag }) => { if (pending === frag) clear(); });
  hls.on(Hls.Events.DESTROYING, () => {
    clear();
    if (recoveryTimer) clearInterval(recoveryTimer);
    // Destroying the instance does not need to restart its size controller.
    restoreCapping = undefined;
  });
};
