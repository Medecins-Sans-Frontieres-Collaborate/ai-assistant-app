/**
 * Cross-cutting "the user's limits may have changed" signal
 * (docs/LIMITS_USER_FACING_UX.md §7.3).
 *
 * A window event rather than a React Query import so NON-React code — the
 * chat store on a `RATE_LIMIT_QUOTA_EXCEEDED` 403, anything else that
 * learns server-side that a limit moved — can ask the client to re-fetch
 * without holding a QueryClient. The single listener lives in
 * `useModelsQuery` and invalidates both `['models']` (blocked models are
 * hidden by the server, so the list itself can change) and `['limits-me']`
 * (exhausted/remaining counters).
 */
export const LIMITS_CHANGED_EVENT = 'limits:changed';

/**
 * Fire-and-forget. Safe to call during SSR / in Node tests: without a
 * `window` there is nobody listening and nothing to invalidate.
 */
export function notifyLimitsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LIMITS_CHANGED_EVENT));
}
