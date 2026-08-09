export type SeriesBadge = 'Hot' | 'New' | 'Exclusive' | 'Free';

export interface Episode {
  id: string;
  episodeNo: number;
  title: string;
  duration: string;
  isFree: boolean;
  isUnlocked?: boolean;
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
