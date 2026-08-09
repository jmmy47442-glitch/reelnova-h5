import type { Episode, HomeResponse, LibraryResponse, Series } from '~/types/content';

const poster = (name: string) => `/posters/${name}.jpg`;

const makeEpisodes = (count: number, freeCount = 3): Episode[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `ep-${index + 1}`,
    episodeNo: index + 1,
    title: index === 0 ? 'The unexpected return' : `A secret comes to light`,
    duration: `${index % 3 === 0 ? 2 : 1}:${String(38 + ((index * 7) % 20)).padStart(2, '0')}`,
    isFree: index < freeCount,
    isUnlocked: index < freeCount,
  }));

const baseSeries: Omit<Series, 'episodes'>[] = [
  {
    id: 'sr-001', slug: 'vows-and-vengeance', title: 'Vows & Vengeance',
    tagline: 'He broke her heart. She built an empire.',
    description: 'Left at the altar, ambitious attorney Evelyn Hart returns three years later as the only person who can save her former fiance\'s family business. Revenge was the plan. Falling again was not.',
    coverUrl: poster('vows-vengeance'), backdropUrl: poster('vows-vengeance-wide'), badge: 'Hot',
    genres: ['Revenge', 'Romance'], views: 23800000, rating: 9.3, episodeCount: 48, freeEpisodeCount: 3,
    price: 4.99, originalPrice: 7.99, currency: 'USD', updatedLabel: '48 EP · Complete', cast: ['Mia Carter', 'Ethan Cole'],
    progress: 62, currentEpisode: 12,
  },
  {
    id: 'sr-002', slug: 'the-heiress-returns', title: 'The Heiress Returns',
    tagline: 'They buried her name. She came back for everything.',
    description: 'A missing heiress comes home under a new identity and takes a job inside the family that betrayed her.',
    coverUrl: poster('heiress-returns'), backdropUrl: poster('heiress-returns-wide'), badge: 'Exclusive',
    genres: ['Hidden Identity', 'Revenge'], views: 191000000, rating: 9.1, episodeCount: 62, freeEpisodeCount: 4,
    price: 5.99, originalPrice: 8.99, currency: 'USD', updatedLabel: '62 EP · Complete', cast: ['Ava Moore', 'Noah Reed'],
  },
  {
    id: 'sr-003', slug: 'faking-forever', title: 'Faking Forever',
    tagline: 'One fake date. One very real mistake.',
    description: 'A scholarship student and a tech heir sign a dating contract, then discover the fine print cannot protect their hearts.',
    coverUrl: poster('faking-forever'), backdropUrl: poster('faking-forever-wide'), badge: 'New',
    genres: ['Young Adult', 'Fake Dating'], views: 14700000, rating: 8.9, episodeCount: 36, freeEpisodeCount: 3,
    price: 3.99, currency: 'USD', updatedLabel: 'New EP Friday', cast: ['Sophie Lane', 'Jack Miller'],
  },
  {
    id: 'sr-004', slug: 'queen-mom-rules', title: 'Queen Mom Rules',
    tagline: 'A mother first. A queen when necessary.',
    description: 'A single mother walks into a boardroom and reveals the inheritance everyone thought was gone.',
    coverUrl: poster('queen-mom'), backdropUrl: poster('queen-mom-wide'), badge: 'Hot',
    genres: ['Strong Heroine', 'Family'], views: 6100000, rating: 8.8, episodeCount: 51, freeEpisodeCount: 3,
    price: 4.99, currency: 'USD', updatedLabel: '51 EP · Complete', cast: ['Emma Brooks', 'Liam Scott'],
  },
  {
    id: 'sr-005', slug: 'goodbye-captain', title: 'Goodbye, Captain',
    tagline: 'He left for the stars. She kept the truth.',
    description: 'An astronaut returns to Earth to find the woman he loved engaged and hiding a five-year-old secret.',
    coverUrl: poster('goodbye-captain'), backdropUrl: poster('goodbye-captain-wide'), badge: 'New',
    genres: ['Second Chance', 'Secret Baby'], views: 14800, rating: 9.0, episodeCount: 42, freeEpisodeCount: 5,
    price: 4.99, currency: 'USD', updatedLabel: 'Updated today', cast: ['Olivia Blake', 'Lucas Gray'],
  },
  {
    id: 'sr-006', slug: 'deal-with-the-captain', title: 'Deal With the Captain',
    tagline: 'Her rules. His ice. Their impossible deal.',
    description: 'A rookie sports agent stakes her career on the league\'s most difficult hockey captain.',
    coverUrl: poster('hockey-deal'), backdropUrl: poster('hockey-deal-wide'), badge: 'Hot',
    genres: ['Sports', 'Enemies to Lovers'], views: 69100000, rating: 9.4, episodeCount: 55, freeEpisodeCount: 3,
    price: 5.99, originalPrice: 9.99, currency: 'USD', updatedLabel: '55 EP · Complete', cast: ['Grace King', 'Henry Ford'],
  },
  {
    id: 'sr-007', slug: 'midnight-ceo', title: 'The Midnight CEO',
    tagline: 'By day, an assistant. By midnight, his only rival.',
    description: 'A quiet executive assistant secretly runs the startup threatening her boss\'s billion-dollar empire.',
    coverUrl: poster('midnight-ceo'), backdropUrl: poster('midnight-ceo-wide'), badge: 'Exclusive',
    genres: ['Billionaire', 'Hidden Identity'], views: 47300000, rating: 9.2, episodeCount: 60, freeEpisodeCount: 3,
    price: 5.99, currency: 'USD', updatedLabel: '60 EP · Complete', cast: ['Chloe Evans', 'Daniel Stone'],
    purchased: true, progress: 28, currentEpisode: 17,
  },
  {
    id: 'sr-008', slug: 'summer-we-lied', title: 'The Summer We Lied',
    tagline: 'Every perfect summer hides one secret.',
    description: 'Five friends reunite at a lake house where a forgotten promise begins to unravel.',
    coverUrl: poster('summer-lied'), backdropUrl: poster('summer-lied-wide'), badge: 'Free',
    genres: ['Mystery', 'Young Adult'], views: 9200000, rating: 8.7, episodeCount: 32, freeEpisodeCount: 32,
    price: 0, currency: 'USD', updatedLabel: '32 EP · Free', cast: ['Ella Young', 'James Bell'],
  },
  {
    id: 'sr-009', slug: 'married-by-monday', title: 'Married by Monday',
    tagline: 'Seven days to find a husband. One terrible candidate.',
    description: 'To inherit her grandmother\'s hotel, a workaholic chef must marry before the board meets Monday.',
    coverUrl: poster('married-monday'), backdropUrl: poster('married-monday-wide'), badge: 'Hot',
    genres: ['Rom-Com', 'Contract Marriage'], views: 31100000, rating: 9.0, episodeCount: 46, freeEpisodeCount: 3,
    price: 4.99, currency: 'USD', updatedLabel: '46 EP · Complete', cast: ['Lily Adams', 'Owen Clark'],
  },
  {
    id: 'sr-010', slug: 'under-his-protection', title: 'Under His Protection',
    tagline: 'The witness saw everything. The agent saw her.',
    description: 'A federal witness and the agent assigned to protect her race across the country with nowhere left to hide.',
    coverUrl: poster('his-protection'), backdropUrl: poster('his-protection-wide'), badge: 'New',
    genres: ['Suspense', 'Bodyguard'], views: 8300000, rating: 8.8, episodeCount: 40, freeEpisodeCount: 3,
    price: 4.99, currency: 'USD', updatedLabel: '8 EP this week', cast: ['Ruby Hill', 'Leo Baker'],
  },
  {
    id: 'sr-011', slug: 'love-on-paper', title: 'Love on Paper',
    tagline: 'Their marriage exists only in ink. For now.',
    description: 'A publishing heiress hires a struggling novelist to play her husband through one impossible family weekend.',
    coverUrl: poster('love-paper'), backdropUrl: poster('love-paper-wide'), badge: 'Exclusive',
    genres: ['Marriage First', 'Romance'], views: 18200000, rating: 9.1, episodeCount: 44, freeEpisodeCount: 3,
    price: 4.99, currency: 'USD', updatedLabel: '44 EP · Complete', cast: ['Zoe Green', 'Adam White'],
    purchased: true, progress: 84, currentEpisode: 39,
  },
  {
    id: 'sr-012', slug: 'after-the-final-bell', title: 'After the Final Bell',
    tagline: 'The game ended. Their story did not.',
    description: 'A former basketball star returns to coach the school team and meets the one person he never apologized to.',
    coverUrl: poster('final-bell'), backdropUrl: poster('final-bell-wide'), badge: 'Hot',
    genres: ['Campus', 'Second Chance'], views: 26400000, rating: 8.9, episodeCount: 38, freeEpisodeCount: 4,
    price: 3.99, currency: 'USD', updatedLabel: '38 EP · Complete', cast: ['Nora Lewis', 'Caleb Hall'],
  },
];

export const seriesList: Series[] = baseSeries.map((series) => ({
  ...series,
  episodes: makeEpisodes(series.episodeCount, series.freeEpisodeCount).map((episode) => ({
    ...episode,
    isUnlocked: episode.isFree || Boolean(series.purchased),
  })),
}));

export const homeData: HomeResponse = {
  featured: seriesList[0],
  tabs: ['Popular', 'New', 'Rankings', 'Categories'],
  sections: [
    { id: 'popular', title: 'Popular now', subtitle: 'Most watched this week', items: seriesList.slice(0, 6) },
    { id: 'new', title: 'Fresh episodes', subtitle: 'New stories and updates', items: [seriesList[4], seriesList[2], seriesList[9], seriesList[7], seriesList[11], seriesList[8]] },
    { id: 'romance', title: 'Love, complicated', subtitle: 'Romance with a sharp turn', items: [seriesList[5], seriesList[8], seriesList[10], seriesList[2], seriesList[0], seriesList[11]] },
    { id: 'revenge', title: 'Revenge & power', subtitle: 'The comeback starts here', items: [seriesList[1], seriesList[6], seriesList[0], seriesList[3], seriesList[9], seriesList[4]] },
    { id: 'us-picks', title: 'US picks', subtitle: 'Trending across the United States', items: [seriesList[6], seriesList[3], seriesList[5], seriesList[11], seriesList[8], seriesList[7]] },
  ],
  generatedAt: new Date().toISOString(),
};

export const libraryData: LibraryResponse = {
  continueWatching: seriesList.filter((series) => series.progress),
  purchased: seriesList.filter((series) => series.purchased),
};

export const findSeries = (slug: string) => seriesList.find((series) => series.slug === slug);
