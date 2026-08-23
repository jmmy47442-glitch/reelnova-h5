import type { AnalyticsEventInput, AnalyticsEventName } from '~/types/content';

const storageKey = 'reelnova-analytics-session';

export const useAnalytics = () => {
  const api = useContentApi();
  const route = useRoute();
  const sessionId = useState<string>('analytics-session', () => '');
  let queue: Promise<unknown> = Promise.resolve();

  const getSessionId = () => {
    if (sessionId.value) return sessionId.value;
    if (import.meta.client) {
      const existing = window.sessionStorage.getItem(storageKey);
      sessionId.value = existing || crypto.randomUUID();
      window.sessionStorage.setItem(storageKey, sessionId.value);
    } else sessionId.value = 'server';
    return sessionId.value;
  };

  const track = (eventName: AnalyticsEventName, context: Omit<AnalyticsEventInput, 'eventId' | 'sessionId' | 'eventName'> = {}, keepalive = false) => {
    const payload: AnalyticsEventInput = {
      eventId: crypto.randomUUID(), sessionId: getSessionId(), eventName,
      pagePath: context.pagePath || (import.meta.client ? window.location.pathname : route.path), ...context,
    };
    const submit = () => api.recordAnalytics(payload, keepalive).catch(() => undefined);
    if (keepalive) return submit();
    queue = queue.then(submit, submit);
    return queue;
  };

  return { sessionId: getSessionId, track };
};
