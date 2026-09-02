export type SeriesBadge = 'Hot' | 'New' | 'Exclusive' | 'Free';

export interface Episode {
  id: string;
  episodeNo: number;
  title: string;
  duration: string;
  isFree: boolean;
  isUnlocked?: boolean;
  mediaStatus?: 'waiting_upload' | 'uploading' | 'validating' | 'processing' | 'ready' | 'failed';
  transcodeProgress?: number;
}

export interface Series {
  id: string;
  slug: string;
  title: string;
  tagline: string;
  description: string;
  coverUrl: string;
  backdropUrl: string;
  badge: SeriesBadge;
  genres: string[];
  views: number;
  rating: number;
  episodeCount: number;
  freeEpisodeCount: number;
  price: number;
  originalPrice?: number;
  currency: 'USD';
  updatedLabel: string;
  cast: string[];
  episodes: Episode[];
  progress?: number;
  currentEpisode?: number;
  purchased?: boolean;
  positionSeconds?: number;
  durationSeconds?: number;
  lastWatchedAt?: string;
  completed?: boolean;
  /** Internal/public catalogue timestamp used by operational sorting. */
  updatedAt?: string;
}

export interface ExploreResponse {
  items: Series[];
  genres: string[];
}

export interface WatchHistoryItem extends Series {
  progress: number;
  currentEpisode: number;
  positionSeconds: number;
  durationSeconds: number;
  lastWatchedAt: string;
  completed: boolean;
}

export interface PlaybackEventInput {
  eventId: string;
  sessionId: string;
  seriesId: string;
  seriesTitle: string;
  episodeNo: number;
  eventType: 'start' | 'heartbeat' | 'complete';
  positionSeconds: number;
  durationSeconds: number;
  authorizationToken: string;
}

export const analyticsEventNames = [
  'home_section_exposure', 'card_exposure', 'card_click', 'detail_open',
  'preview_start', 'preview_complete', 'lock_trigger', 'payment_sheet_open',
  'paypal_click', 'payment_success', 'payment_failure', 'payment_cancel',
  'playback_start', 'playback_first_frame', 'playback_stall', 'playback_resume',
  'playback_error', 'playback_complete', 'next_episode_click', 'search',
  'filter', 'share', 'restore_purchase',
] as const;

export type AnalyticsEventName = typeof analyticsEventNames[number];

export interface AnalyticsEventInput {
  eventId: string;
  sessionId: string;
  eventName: AnalyticsEventName;
  pagePath?: string;
  seriesId?: string;
  seriesTitle?: string;
  episodeNo?: number;
  positionSeconds?: number;
  durationSeconds?: number;
  properties?: Record<string, string | number | boolean | null>;
}

export interface HomeSection {
  id: string;
  title: string;
  subtitle: string;
  items: Series[];
}

export interface HomeResponse {
  featured: Series;
  tabs: string[];
  sections: HomeSection[];
  generatedAt: string;
}

export interface LibraryResponse {
  continueWatching: Series[];
  purchased: Series[];
}

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'refunding'
  | 'refunded'
  | 'risk_review';

export interface Order {
  orderNo: string;
  seriesId: string;
  seriesTitle: string;
  amount: number;
  currency: 'USD';
  status: OrderStatus;
  refundStatus?: 'pending' | 'processing' | 'completed' | 'failed' | 'rejected' | 'cancelled';
  entitlementStatus?: 'pending' | 'granted' | 'revoked';
  createdAt: string;
  paypalOrderId?: string;
  approvalUrl?: string;
}

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  requestId: string;
  data: T;
}
