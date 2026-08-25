import type { AsyncDataOptions } from 'nuxt/app';

const STORAGE_PREFIX = 'reelnova:page-data:';
const STORAGE_VERSION = 1;

type CachedPageData<DataT> = {
  version: number;
  savedAt: string;
  data: DataT;
};

type PageDataOptions<DataT> = AsyncDataOptions<DataT> & {
  revalidateOnMount?: boolean;
};

const storageKey = (key: string) => `${STORAGE_PREFIX}${key}`;

const readCache = <DataT>(key: string): { found: boolean; data?: DataT } => {
  if (!import.meta.client) return { found: false };
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return { found: false };
    const cached = JSON.parse(raw) as Partial<CachedPageData<DataT>>;
    if (cached.version !== STORAGE_VERSION || !Object.prototype.hasOwnProperty.call(cached, 'data')) {
      localStorage.removeItem(storageKey(key));
      return { found: false };
    }
    return { found: true, data: cached.data as DataT };
  } catch {
    return { found: false };
  }
};

const writeCache = <DataT>(key: string, data: DataT) => {
  if (!import.meta.client) return;
  try {
    const payload: CachedPageData<DataT> = { version: STORAGE_VERSION, savedAt: new Date().toISOString(), data };
    localStorage.setItem(storageKey(key), JSON.stringify(payload));
  } catch {
    // A full or disabled storage should never block rendering fresh API data.
  }
};

/** Remove all page-data snapshots, for example after a user signs out. */
export const clearPageDataCache = () => {
  if (!import.meta.client) return;
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Ignore disabled storage.
  }
};

/**
 * Loads page data from localStorage first. The API is only called when no
 * snapshot exists, or when the caller explicitly invokes refresh().
 */
export const usePageData = <DataT>(
  key: string,
  handler: () => Promise<DataT>,
  options: PageDataOptions<DataT> = {},
) => {
  const { revalidateOnMount = false, ...asyncDataOptions } = options;
  const asyncData = useAsyncData(key, handler, { ...asyncDataOptions, immediate: false });
  const loading = ref(true);
  const hydratedFromCache = ref(false);

  const refresh = async () => {
    loading.value = true;
    try {
      await asyncData.refresh();
      if (!asyncData.error.value && asyncData.data.value !== undefined) writeCache(key, asyncData.data.value as DataT);
    } finally {
      loading.value = false;
    }
  };

  onMounted(async () => {
    const cached = readCache<DataT>(key);
    if (cached.found) {
      asyncData.data.value = cached.data as typeof asyncData.data.value;
      hydratedFromCache.value = true;
      loading.value = false;
      if (revalidateOnMount) await refresh();
      return;
    }
    if (asyncData.status.value === 'idle') await refresh();
  });

  return { ...asyncData, status: computed(() => loading.value ? 'pending' : asyncData.status.value), refresh, hydratedFromCache };
};
