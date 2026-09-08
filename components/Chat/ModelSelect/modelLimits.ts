import { useCallback, useMemo } from 'react';

import {
  ModelAvailability,
  ModelAvailabilityView,
  useMyLimits,
} from '@/client/hooks/settings/useMyLimits';

import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

/**
 * Picker-side reading of the caller's per-model limits
 * (docs/LIMITS_USER_FACING_UX.md §7.4).
 *
 * The list renders dozens of rows inside plain render helpers, and family
 * rows need the state of EVERY member to pick a still-usable representative,
 * so per-row hooks are out. One `useMyLimits()` subscription plus a pure
 * lookup covers the list; single-model surfaces (details header, mobile
 * header) keep using WP-B's `useModelAvailability` directly.
 */

const AVAILABLE: ModelAvailabilityView = { state: 'available' };

/**
 * Pure twin of `useModelAvailability` (client/hooks/settings/useMyLimits.ts)
 * — same rules, same fail-open posture: not enforced, no id, or no entry ⇒
 * available. Keep the two in lock-step; the hook is the reference. One
 * deliberate addition: an AVAILABLE entry keeps its counters, because the
 * low-remaining annotation ("2 left") needs `remaining`/`limit` before the
 * model is spent — the hook discards them.
 */
export function deriveModelAvailability(
  models: Record<string, ModelAvailability>,
  enforce: boolean,
  modelId?: string,
): ModelAvailabilityView {
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
  return { state: 'available', ...detail };
}

/**
 * "3 left" territory: at or under 10 % of the cap (never less than one
 * request), while the model is still usable. Exhausted rows carry the clock
 * badge instead, so this never doubles up with it.
 */
export function isLowRemaining(view: ModelAvailabilityView): boolean {
  if (view.state !== 'available') return false;
  if (typeof view.remaining !== 'number' || typeof view.limit !== 'number') {
    return false;
  }
  return view.remaining <= Math.max(1, Math.ceil(view.limit * 0.1));
}

export interface ModelAvailabilityMap {
  /** Policy is enforced and readable — the only mode in which anything grays. */
  enforce: boolean;
  lookup: (modelId?: string) => ModelAvailabilityView;
  /** Convenience predicate for seriesRepresentative / pickVariantTarget. */
  isSelectable: (model: Pick<OpenAIModel, 'id'>) => boolean;
  /** Re-reads the caller's limits (a countdown just expired). */
  refetch: () => void;
}

// `useMyLimits()` returns `data?.models ?? {}`: a fresh object every render
// while there is no data (flag off, loading, 401) — precisely the "byte-for-
// byte today's UI" branch that should be inert. Substituting this frozen
// constant keeps `lookup`/`isSelectable`/the returned map stable in that
// branch instead of recomputing (and re-rendering every consumer) on every
// render. Harmless once real data arrives: an empty `models` object there
// behaves identically either way.
const EMPTY_MODELS: Record<string, ModelAvailability> = {};

/** One subscription, many lookups — see the module docblock. */
export function useModelAvailabilityMap(): ModelAvailabilityMap {
  const { enforce, models, refetch } = useMyLimits();
  const stableModels = Object.keys(models).length > 0 ? models : EMPTY_MODELS;
  const lookup = useCallback(
    (modelId?: string) =>
      deriveModelAvailability(stableModels, enforce, modelId),
    [stableModels, enforce],
  );
  const isSelectable = useCallback(
    (model: Pick<OpenAIModel, 'id'>) => lookup(model.id).state === 'available',
    [lookup],
  );
  // `cancelRefetch: false` dedupes concurrent calls onto one in-flight
  // request (TanStack Query's Query#fetch returns the existing retryer's
  // promise instead of aborting it) — every exhausted row's badge, plus
  // every spent Version chip and Variant segment, shares this ONE function
  // reference and can cross the reset boundary within milliseconds of each
  // other; without this they would cancel one another's request in a chain,
  // and each still-executing cancelled fetch costs a blob read server-side.
  const refetchLimits = useCallback(() => {
    void refetch({ cancelRefetch: false });
  }, [refetch]);
  return useMemo(
    () => ({ enforce, lookup, isSelectable, refetch: refetchLimits }),
    [enforce, lookup, isSelectable, refetchLimits],
  );
}

/**
 * The catalog model an agent pins the conversation to, when the client can
 * know it: prompt agents carry `modelId` (once the discovery payload exposes
 * it — `pinnedModelId` is the normalized name on AvailableAgent), and
 * Foundry-style agents swap onto their synthesized `foundryModel`. Read
 * structurally so both the discovery shape and the browser's AvailableAgent
 * satisfy it without either type having to import the other.
 */
export function pinnedModelIdOf(agent: {
  /** Anchors the structural match (every agent shape has a name). */
  name: string;
  pinnedModelId?: string;
  modelId?: string;
  foundryModel?: { id: string };
}): string | undefined {
  return agent.pinnedModelId ?? agent.modelId ?? agent.foundryModel?.id;
}

/**
 * Availability of an agent's pinned model. A CATALOG id the server no longer
 * serves (absent from `settingsStore.models`) is blocked for this user —
 * `/api/models` hides `model.allowed=false` in enforce mode — and is
 * otherwise judged by the limits map like any picker row. Agent-shaped and
 * byom ids are never in the served list, so absence means nothing for them
 * and only the map (which today has no entry) is consulted. Gated on
 * `enforce`: outside it, a missing catalog model is a ring/region/kill-switch
 * matter that the agent surfaces never commented on before and must not
 * start to.
 */
export function pinnedModelAvailability(
  pinnedModelId: string | undefined,
  map: Pick<ModelAvailabilityMap, 'enforce' | 'lookup'>,
  servedModels: ReadonlyArray<Pick<OpenAIModel, 'id'>>,
): ModelAvailabilityView {
  if (!pinnedModelId || !map.enforce) return AVAILABLE;
  const isCatalogId = pinnedModelId in OpenAIModels;
  if (isCatalogId && !servedModels.some((m) => m.id === pinnedModelId)) {
    return { state: 'blocked', reason: 'blocked' };
  }
  return map.lookup(pinnedModelId);
}

/** Display name for a pinned model id: catalog name, else the id verbatim. */
export function pinnedModelName(modelId: string): string {
  return OpenAIModels[modelId as OpenAIModelID]?.name ?? modelId;
}
