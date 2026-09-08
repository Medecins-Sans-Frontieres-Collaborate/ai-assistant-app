'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';
import { MODELS_QUERY_KEY } from '@/client/hooks/settings/useModelsQuery';

import { LimitTier } from '@/lib/services/limits/types';

import { OpenAIModels } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';

// ---------------------------------------------------------------------------
// Wire types — GET /api/limits/me (docs/LIMITS_USER_FACING_UX.md §7.1).
// The same response type serves the own-limits branch AND the admin `?as=`
// preview (useEffectiveLimitsPreview), so the preview-only fields stay here.
// ---------------------------------------------------------------------------

/**
 * One resolved limit row. On the caller's OWN branch the server keeps its
 * no-provenance promise (no tier, override id or label); those fields are
 * populated only on admin previews.
 */
export interface MeLimit {
  limitKey: string;
  value: number | boolean | null;
  unit: string;
  window: string;
  source: string;
  overrideId?: string;
  modelId?: string;
  series?: string;
  /**
   * Authority tier of the winning record (design §3b). Optional because a
   * server predating delegations omits it; absent reads as `global`.
   */
  tier?: LimitTier;
  /** A global-tier ceiling clamped the winner down. */
  ceilingApplied?: boolean;
  /** The global-tier OVERRIDE whose ceiling pinned the value, if one did. */
  ceilingOverrideId?: string;
  /**
   * Its label, supplied by the server: a scoped admin cannot see other
   * global records, but must be able to read WHY their 500 became 100.
   */
  ceilingLabel?: string;
  // Only with `usage=1`, only on numeric `kind: 'counter'` rows:
  /** Current-period consumption (0 when no counter document exists). */
  used?: number;
  /** `max(0, value - used)`. */
  remaining?: number;
  /** ISO instant of the next period boundary in the policy's timezone. */
  resetAt?: string;
}

/** Back-compat alias — the admin preview components import this name. */
export type MyLimit = MeLimit;

/** Current consumption for one limit key, attached to `?as=` previews. */
export interface PreviewUsage {
  used: number;
  window: 'day' | 'month' | 'total';
}

export type ModelAvailabilityReason =
  | 'blocked'
  | 'exhausted'
  | 'familyExhausted';

/**
 * Server verdict for one served model, resolved with the same conjunctive
 * cells (model AND family) enforcement uses, so the picker can never
 * disagree with the send-time check.
 */
export interface ModelAvailability {
  /** false ⇢ `model.allowed` resolved false on the model OR family cell. */
  allowed: boolean;
  reason?: ModelAvailabilityReason;
  /** The binding counter cell, when any is numeric. */
  limit?: number;
  used?: number;
  remaining?: number;
  resetAt?: string;
}

export interface MyLimitsResponse {
  enabled: boolean;
  mode?: 'observe' | 'enforce';
  policyUnavailable?: boolean;
  limits: MeLimit[];
  /** `usage=1` was asked for but the counters could not be read — never an error. */
  usageUnavailable?: boolean;
  /** Only with `models=`; one entry per accepted catalog id. */
  models?: Record<string, ModelAvailability>;
  /** Present on `?as=` admin previews only. */
  preview?: boolean;
  subject?: string | null;
  /** Override layers the preview cannot evaluate (attribute, group). */
  notEvaluated?: string[];
  /** The caller is a SCOPED admin and the subject is inside their scope. */
  scopedPreview?: boolean;
  /** Present when `usage=1` was asked for and the counters could be read. */
  usage?: Record<string, PreviewUsage>;
}

// ---------------------------------------------------------------------------
// Flag gate
// ---------------------------------------------------------------------------

/**
 * True when the `usageLimits` LaunchDarkly flag is on for this user.
 *
 * CLIENT-side only, and deliberately so: it gates UI (the admin rail entry,
 * the limits panel, the /api/limits/me fetch), not security — the limits
 * admin page and API routes keep their own server-side global-admin gates.
 * Outside an LDProvider (or before flags load) `useFlags()` returns no keys,
 * so this fails closed to hidden.
 */
export function useLimitsEnabled(): boolean {
  const { usageLimits } = useFlags();
  return Boolean(usageLimits);
}

// ---------------------------------------------------------------------------
// The one data source for every user-facing limit surface
// ---------------------------------------------------------------------------

/** Server cap on `models=`; ids past it are dropped rather than refused. */
const MAX_MODEL_IDS = 100;

/**
 * Sorted catalog ids of the served model list. Sorted so a reorder (usage
 * ordering, hidden models) does not churn the query key; catalog-only
 * because the server skips byom-/local-/org- ids anyway and they would only
 * lengthen the URL.
 */
function catalogModelIdsKey(models: { id: string }[]): string {
  return models
    .map((m) => m.id)
    .filter((id) => id in OpenAIModels)
    .sort()
    .slice(0, MAX_MODEL_IDS)
    .join(',');
}

export function useMyLimits() {
  const limitsEnabled = useLimitsEnabled();
  const models = useSettingsStore((s) => s.models);
  const modelIdsKey = useMemo(() => catalogModelIdsKey(models), [models]);
  const queryClient = useQueryClient();
  const modelListSource = useSettingsStore((s) => s.modelListSource);
  // Wait for `useModelsQuery`'s discovery attempt to settle before firing:
  // its default-onto-discovery effect changes `modelIdsKey` a moment later,
  // wasting a counter read for metered users on the superseded static key
  // (docs/LIMITS_USER_FACING_UX.md §7.3 follow-up).
  //
  // On SUCCESS this is read from `modelListSource` rather than the query's
  // own status: `setModels`/`setModelListSource` are called back-to-back,
  // synchronously, from the SAME `applyDiscoveredModels` call — so any
  // component reading both (this hook, via `models` above and
  // `modelListSource` here) sees them update together in one React commit.
  // Reading the query's cache status instead raced ahead of that: the
  // cache notifies on fetch resolution before the sibling component's own
  // effect has re-applied the store, so a component elsewhere (this hook
  // is used from several) could observe "settled" for one render with
  // `modelIdsKey` still pointing at the stale static list.
  //
  // On ERROR/empty-list `modelListSource` never leaves `'static'` (the
  // code keeps the seed), so there is nothing to race there: fall back to
  // firing once the `['models']` query itself reports `error`, read via
  // the query CACHE (not a second `useQuery` observer for the key, which
  // would either double-fetch or — with `enabled: false` — pin the query
  // pending forever when `useModelsQuery` never mounts at all, e.g. most
  // unit tests here). No query registered at all reads as "no error", so
  // that fallback never engages and existing behavior is unchanged.
  const [modelsQueryErrored, setModelsQueryErrored] = useState(
    () => queryClient.getQueryState(MODELS_QUERY_KEY)?.status === 'error',
  );
  useEffect(() => {
    const isModelsKey = (key: readonly unknown[]) =>
      key.length === MODELS_QUERY_KEY.length && key[0] === MODELS_QUERY_KEY[0];
    // Cache may already hold an errored query by the time this effect runs.
    setModelsQueryErrored(
      queryClient.getQueryState(MODELS_QUERY_KEY)?.status === 'error',
    );
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (isModelsKey(event.query.queryKey)) {
        setModelsQueryErrored(event.query.state.status === 'error');
      }
    });
    return unsubscribe;
  }, [queryClient]);
  const modelsSettled = modelListSource !== 'static' || modelsQueryErrored;

  const { data, isLoading, error, refetch } = useQuery<MyLimitsResponse | null>(
    {
      queryKey: ['limits-me', modelIdsKey],
      // `models` is not persisted: the very first render sees an empty list
      // until AppInitializer's static seed lands one effect later. Waiting
      // for it avoids a throwaway request with no `models=` that would be
      // superseded immediately.
      enabled: limitsEnabled && models.length > 0 && modelsSettled,
      queryFn: async () => {
        const params = new URLSearchParams({ usage: '1' });
        if (modelIdsKey) params.set('models', modelIdsKey);
        const response = await fetch(`/api/limits/me?${params.toString()}`);
        // 401 = signed out; treat as "no limits to show" rather than an error.
        if (response.status === 401) return null;
        if (!response.ok) {
          throw new Error(`Failed to fetch limits: ${response.status}`);
        }
        return unwrapApiData<MyLimitsResponse>(await response.json());
      },
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  );

  const mode = data?.mode ?? 'observe';
  const policyUnavailable = data?.policyUnavailable === true;
  const limits = data?.limits ?? [];

  return {
    limits,
    mode,
    /**
     * The single switch every limit surface hangs off: only an ENFORCED,
     * readable policy may hide, gray or disable anything. Flag off, observe
     * mode, a storage outage or no data yet all read as "render today's UI"
     * — the same fail-open posture enforcement takes.
     */
    enforce: limitsEnabled && mode === 'enforce' && !policyUnavailable,
    isLimited: limits.length > 0,
    models: data?.models ?? {},
    usageUnavailable: data?.usageUnavailable === true,
    policyUnavailable,
    isLoading,
    error,
    refetch,
  };
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export type ModelAvailabilityState = 'available' | 'exhausted' | 'blocked';

export interface ModelAvailabilityView {
  state: ModelAvailabilityState;
  reason?: ModelAvailabilityReason;
  limit?: number;
  used?: number;
  remaining?: number;
  resetAt?: string;
}

const AVAILABLE: ModelAvailabilityView = { state: 'available' };

/**
 * The picker's answer for one model. `'available'` whenever the flag is
 * off, the policy is not enforced, the query has no data, or the id is
 * simply absent from `models` (fail open — an unknown model is the server's
 * problem to refuse, not the client's to gray).
 */
export function useModelAvailability(modelId?: string): ModelAvailabilityView {
  const { enforce, models } = useMyLimits();
  return useMemo(() => {
    if (!enforce || !modelId) return AVAILABLE;
    const entry = models[modelId];
    if (!entry) return AVAILABLE;
    const detail = {
      reason: entry.reason,
      limit: entry.limit,
      used: entry.used,
      remaining: entry.remaining,
      resetAt: entry.resetAt,
    };
    if (entry.allowed === false) {
      return { state: 'blocked', ...detail, reason: entry.reason ?? 'blocked' };
    }
    // The server sets `reason` for exhaustion; `remaining === 0` is the
    // belt-and-braces read of the same fact from an older payload.
    if (
      entry.reason === 'exhausted' ||
      entry.reason === 'familyExhausted' ||
      entry.remaining === 0
    ) {
      return {
        state: 'exhausted',
        ...detail,
        reason: entry.reason ?? 'exhausted',
      };
    }
    // Available, but keep the counters: a low-remaining annotation
    // (§7.4 "3 left today") needs `remaining`/`limit`/`used` too, and every
    // consumer of this hook — not just the map-based picker path — must
    // read the same numbers. See docs/LIMITS_USER_FACING_UX.md §7.4.
    return { state: 'available', ...detail };
  }, [enforce, models, modelId]);
}

export interface FeatureRemaining {
  remaining: number;
  limit?: number;
  used?: number;
  resetAt?: string;
}

export interface LimitGates {
  /** A boolean gate (`feature.*.enabled`) resolved to `false` for this user. */
  isFeatureBlocked: (limitKey: string) => boolean;
  /** The counter row for a key, when the server reported its usage. */
  featureRemaining: (limitKey: string) => FeatureRemaining | undefined;
  enforce: boolean;
}

/**
 * Feature-toggle gates read from the `limits` rows. Only UNQUALIFIED rows
 * (no modelId/series) count: feature keys are never model-qualified, and a
 * model-qualified `model.requests` row must not masquerade as a global one.
 * Fail open: anything not enforced or not present is "allowed".
 */
export function useLimitGates(): LimitGates {
  const { enforce, limits } = useMyLimits();

  const isFeatureBlocked = useCallback(
    (limitKey: string): boolean =>
      enforce &&
      limits.some(
        (row) =>
          row.limitKey === limitKey &&
          !row.modelId &&
          !row.series &&
          row.value === false,
      ),
    [enforce, limits],
  );

  const featureRemaining = useCallback(
    (limitKey: string): FeatureRemaining | undefined => {
      if (!enforce) return undefined;
      const row = limits.find(
        (candidate) =>
          candidate.limitKey === limitKey &&
          !candidate.modelId &&
          !candidate.series &&
          typeof candidate.remaining === 'number',
      );
      if (!row || typeof row.remaining !== 'number') return undefined;
      return {
        remaining: row.remaining,
        limit: typeof row.value === 'number' ? row.value : undefined,
        used: row.used,
        resetAt: row.resetAt,
      };
    },
    [enforce, limits],
  );

  return { isFeatureBlocked, featureRemaining, enforce };
}

// ---------------------------------------------------------------------------
// Reset countdown
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "in 6 hours" / "in 12 minutes" / "in 3 days" in the user's locale. Minutes
 * is the finest unit — day windows do not need seconds, and a per-second
 * tick would re-render every picker row for nothing.
 */
export function formatResetIn(
  resetAt: string,
  now: number,
  locale?: string,
): string | null {
  const target = Date.parse(resetAt);
  if (Number.isNaN(target)) return null;
  const diff = target - now;
  if (diff <= 0) return null;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  // Round (not ceil) for the coarse units: a 61-minute wait reading "in 2
  // hours" overstates it by nearly a full unit. `diff >= *_MS` in the
  // branch guard keeps the rounded value at least 1.
  if (diff >= DAY_MS) return rtf.format(Math.round(diff / DAY_MS), 'day');
  if (diff >= HOUR_MS) return rtf.format(Math.round(diff / HOUR_MS), 'hour');
  // ceil so the last partial minute reads "in 1 minute", never "in 0 minutes"
  return rtf.format(Math.max(1, Math.ceil(diff / MINUTE_MS)), 'minute');
}

export interface ResetCountdownOptions {
  /**
   * Fired ONCE when `resetAt` passes while mounted — the caller re-fetches
   * so a grayed model comes back. Deliberately NOT fired for a `resetAt`
   * that is already past on mount: a client clock ahead of the server would
   * otherwise refetch in a loop against a payload that never changes.
   */
  onExpired?: () => void;
}

/**
 * Localized relative countdown to `resetAt`, re-rendering once a minute.
 * `null` when `resetAt` is absent, unparseable or already past.
 */
export function useResetCountdown(
  resetAt?: string,
  options: ResetCountdownOptions = {},
): string | null {
  const [now, setNow] = useState(() => Date.now());
  const onExpiredRef = useRef(options.onExpired);
  onExpiredRef.current = options.onExpired;
  // Which resetAt (if any) we already reported as expired.
  const expiredForRef = useRef<string | null>(null);
  const target = resetAt ? Date.parse(resetAt) : Number.NaN;
  const active = !Number.isNaN(target);

  useEffect(() => {
    if (!active) return;
    // Fresh `now` on every change of target so a brand-new resetAt is not
    // judged against a minute-old clock.
    const start = Date.now();
    setNow(start);
    if (target <= start) {
      // Already past on mount/change: nothing to count down, nothing to fire.
      expiredForRef.current = resetAt ?? null;
      return;
    }
    expiredForRef.current = null;
    const tick = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    // A precise one-shot at the boundary so the flip (and onExpired) does
    // not wait for the next minute tick. Background tabs may throttle it;
    // the interval then catches up on the next tick.
    const boundary = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(target - start + 1, 0x7fffffff),
    );
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(boundary);
    };
    // resetAt is the string form of target; listing both would be redundant
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, active]);

  const label = useMemo(() => {
    if (!active || !resetAt) return null;
    const locale =
      typeof navigator !== 'undefined' ? navigator.language : undefined;
    return formatResetIn(resetAt, now, locale);
  }, [active, resetAt, now]);

  // Fire onExpired exactly once per resetAt, and only for a transition seen
  // while mounted (see ResetCountdownOptions).
  useEffect(() => {
    if (!active || !resetAt) return;
    if (label !== null) return;
    if (expiredForRef.current === resetAt) return;
    expiredForRef.current = resetAt;
    onExpiredRef.current?.();
  }, [active, resetAt, label]);

  return label;
}
