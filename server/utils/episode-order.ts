export interface EpisodeOrderItem {
  id: string;
  episodeNo: number;
  title: string;
  isFree: boolean;
}

export const orderEpisodesByIds = <T extends EpisodeOrderItem>(episodes: T[], episodeIds: string[], freeEpisodeCount: number): T[] => {
  if (episodeIds.length !== episodes.length || new Set(episodeIds).size !== episodeIds.length) {
    throw new Error('Episode order must contain every episode exactly once');
  }
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));
  return episodeIds.map((id, index) => {
    const episode = byId.get(id);
    if (!episode) throw new Error('Episode order contains an unknown episode');
    const episodeNo = index + 1;
    return {
      ...episode,
      episodeNo,
      title: episode.title === `Episode ${episode.episodeNo}` ? `Episode ${episodeNo}` : episode.title,
      isFree: episodeNo <= freeEpisodeCount,
    };
  });
};
