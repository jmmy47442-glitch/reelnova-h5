import type { HomeResponse, Series } from '~/types/content';

// Count changed stories once even when they appear in several shelves. Ignore
// timestamps, hidden view counters and personal playback progress.
const storySnapshot = (story: Series) => JSON.stringify([
  story.slug, story.title, story.tagline, story.description, story.coverUrl,
  story.backdropUrl, story.badge, story.genres, story.episodeCount,
  story.freeEpisodeCount, story.price, story.originalPrice, story.currency,
  story.updatedLabel, story.cast, Boolean(story.purchased),
  story.episodes.map((episode) => [episode.id, episode.episodeNo, episode.title, episode.isFree, episode.isUnlocked, episode.mediaStatus]),
]);

export const countHomeUpdates = (current: HomeResponse, latest: HomeResponse): number => {
  const stories = (home: HomeResponse) => new Map(
    [home.featured, ...home.sections.flatMap((section) => section.items)].map((story) => [story.id, storySnapshot(story)]),
  );
  const before = stories(current);
  const after = stories(latest);
  const changed = new Set([...before.keys(), ...after.keys()].filter((id) => before.get(id) !== after.get(id)));
  let count = changed.size;
  const oldSections = new Map(current.sections.map((section) => [section.id, section]));
  const newSections = new Map(latest.sections.map((section) => [section.id, section]));
  for (const id of new Set([...oldSections.keys(), ...newSections.keys()])) {
    const oldSection = oldSections.get(id);
    const newSection = newSections.get(id);
    // Content changes already counted above must not also count as reorderings.
    const snapshot = (section: typeof oldSection) => section && JSON.stringify([
      section.title, section.subtitle, section.items.map((story) => story.id).filter((storyId) => !changed.has(storyId)),
    ]);
    if (snapshot(oldSection) !== snapshot(newSection)) count++;
  }
  if (current.featured.id !== latest.featured.id && !changed.has(latest.featured.id)) count++;
  const commonSections = (home: HomeResponse) => home.sections.map((section) => section.id).filter((id) => oldSections.has(id) && newSections.has(id));
  if (JSON.stringify(commonSections(current)) !== JSON.stringify(commonSections(latest))) count++;
  if (JSON.stringify(current.tabs) !== JSON.stringify(latest.tabs)) count++;
  return count;
};
