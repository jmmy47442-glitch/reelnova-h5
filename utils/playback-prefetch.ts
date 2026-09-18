import type { PlaybackAuthorization } from '../composables/useContentApi';

type Connection = { saveData?: boolean; effectiveType?: string; type?: string; downlink?: number };
const connection = (): Connection | undefined => typeof navigator === 'undefined' ? undefined
  : (navigator as Navigator & { connection?: Connection }).connection;

export const playbackProfile = (): 'original' | 'mobile' => {
  const network = connection();
  return network?.saveData || network?.type === 'cellular'
    || ['slow-2g', '2g', '3g'].includes(network?.effectiveType || '')
    || (typeof network?.downlink === 'number' && network.downlink < 2) ? 'mobile' : 'original';
};
export const canPrefetchPlayback = () => typeof document !== 'undefined'
  && document.visibilityState === 'visible' && playbackProfile() === 'original';

// One navigation handoff, in memory only. Reusing the exact grant keeps the
// signature-specific edge blocks useful and preserves the next episode session.
type Handoff = { slug: string; episodeNo: number; sessionId: string; grant: PlaybackAuthorization; storedAt: number };
let handoff: Handoff | undefined;
export const handoffPlayback = (value: Omit<Handoff, 'storedAt'>) => { handoff = { ...value, storedAt: Date.now() }; };
export const takePlaybackHandoff = (slug: string, episodeNo: number) => {
  const value = handoff;
  handoff = undefined;
  return value && value.slug === slug && value.episodeNo === episodeNo && Date.now() - value.storedAt < 60_000
    && Date.parse(value.grant.expiresAt || '') > Date.now() + 60_000 ? value : undefined;
};

export const prefetchPlaybackStart = async (url: string, signal: AbortSignal) => {
  const response = await fetch(url, { headers: { Range: 'bytes=0-524287' }, signal, cache: 'no-store', credentials: 'omit' });
  // Do not accidentally download an entire film if an upstream ignores Range.
  if (response.status !== 206 || !/^bytes 0-\d+\/\d+$/.test(response.headers.get('content-range') || '')
    || Number(response.headers.get('content-length')) > 524288) {
    await response.body?.cancel();
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  let received = 0;
  try {
    while (received < 524288) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
  } finally { await reader.cancel(); }
};
