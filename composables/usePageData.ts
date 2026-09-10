import type { AsyncDataOptions } from 'nuxt/app';

const STORAGE_PREFIX = 'reelnova:page-data:';
const STORAGE_VERSION = 2;

type CachedPageData<DataT> = {
  version: number;
  savedAt: string;
  data: DataT;
};

type PageDataOptions<DataT> = AsyncDataOptions<DataT> & {
  revalidateOnMount?: boolean;
  revalidateOnActivate?: boolean;
  revalidateOnFocus?: boolean;
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

/** Remove selected page-data snapshots after a server-side state change. */
export const invalidatePageDataCache = (...keys: string[]) => {
  if (!import.meta.client) return;
  try {
    keys.forEach((key) => localStorage.removeItem(storageKey(key)));
  } catch {
    // Ignore disabled storage.
  }
  clearNuxtData(keys);
};

/**
 * Loads page data from localStorage first. Callers can opt into background
 * revalidation on mount, KeepAlive activation, or browser focus.
 */
export const usePageData = <DataT>(
  key: string,
  handler: () => Promise<DataT>,
  options: PageDataOptions<DataT> = {},
) => {
  const {
    revalidateOnMount = false,
    revalidateOnActivate = false,
    revalidateOnFocus = false,
    ...asyncDataOptions
  } = options;
  const asyncData = useAsyncData(key, handler, { ...asyncDataOptions, immediate: false });
  const hasRenderableData = computed(() => asyncData.data.value !== undefined && asyncData.data.value !== null);
  const loading = ref(!hasRenderableData.value);
  const hydratedFromCache = ref(false);
  let activationCount = 0;
  let componentActive = false;
  let focusRevalidationReady = false;
  let lastFocusRevalidationAt = 0;

  const refresh = async () => {
    // Revalidation must not replace an already rendered page with a loading
    // state. Only block when there is no snapshot available yet.
    loading.value = !hasRenderableData.value;
    try {
      await asyncData.refresh();
      if (!asyncData.error.value && asyncData.data.value !== undefined) writeCache(key, asyncData.data.value as DataT);
    } finally {
      loading.value = false;
    }
  };

  function revalidateAfterFocus() {
    if (!revalidateOnFocus || !focusRevalidationReady || !componentActive || document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastFocusRevalidationAt < 1_000) return;
    lastFocusRevalidationAt = now;
    void refresh();
  }

  onMounted(async () => {
    componentActive = true;
    if (revalidateOnFocus) {
      window.addEventListener('focus', revalidateAfterFocus);
      document.addEventListener('visibilitychange', revalidateAfterFocus);
    }
    const cached = readCache<DataT>(key);
    if (cached.found) {
      asyncData.data.value = cached.data as typeof asyncData.data.value;
      hydratedFromCache.value = true;
      loading.value = false;
      if (revalidateOnMount) await refresh();
      focusRevalidationReady = true;
      return;
    }
    if (asyncData.status.value === 'idle' || revalidateOnMount) await refresh();
    focusRevalidationReady = true;
  });

  onActivated(() => {
    componentActive = true;
    activationCount += 1;
    // KeepAlive invokes activated on the initial mount as well; onMounted is
    // responsible for that first request.
    if (activationCount > 1 && revalidateOnActivate) void refresh();
  });

  onDeactivated(() => { componentActive = false; });
  onBeforeUnmount(() => {
    componentActive = false;
    if (revalidateOnFocus) {
      window.removeEventListener('focus', revalidateAfterFocus);
      document.removeEventListener('visibilitychange', revalidateAfterFocus);
    }
  });

  const status = computed(() => {
    if (hasRenderableData.value) return 'success';
    return loading.value ? 'pending' : asyncData.status.value;
  });
  const error = computed(() => hasRenderableData.value ? null : asyncData.error.value);

  return { ...asyncData, status, error, refresh, hydratedFromCache };
};
