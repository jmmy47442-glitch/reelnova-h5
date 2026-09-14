export type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitEnterFullScreen?: () => void;
};

export type FullscreenContainer = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

export type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void | Promise<void>;
};

export const enterVideoFullscreen = async (container: FullscreenContainer, video: FullscreenVideo) => {
  // Keep the first request in the click gesture: iOS requires user activation.
  // Standard fullscreen includes our controls; iPhone uses its native player.
  if (container.requestFullscreen) {
    try {
      await container.requestFullscreen();
      return;
    } catch {
      // Some mobile WebViews expose the standard API but reject its use.
    }
  }
  const enterNative = video.webkitEnterFullscreen || video.webkitEnterFullScreen;
  if (enterNative) {
    enterNative.call(video);
    return;
  }
  if (container.webkitRequestFullscreen) {
    await container.webkitRequestFullscreen();
    return;
  }
  throw new Error('Fullscreen is unavailable');
};

export const exitVideoFullscreen = async (doc: FullscreenDocument) => {
  if (doc.fullscreenElement && doc.exitFullscreen) await doc.exitFullscreen();
  else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
};
