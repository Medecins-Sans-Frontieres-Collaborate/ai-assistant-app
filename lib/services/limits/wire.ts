/**
 * Wire contracts of the limits routes, declared ONCE and imported by both the
 * route handlers and the client hooks. Before this the client re-declared
 * every response interface by hand ("mirrors the server") and matched error
 * codes as bare string literals in six places — two definitions that could
 * only drift.
 *
 * Client-safe: types plus one constant, no node builtins, no storage.
 */
import {
  JurisdictionWarning,
  OverrideFlag,
  TargetVerdict,
} from '@/lib/services/limits/scopedVerdicts';
import {
  JurisdictionPredicate,
  LimitOverride,
  LimitTier,
  LimitsMode,
} from '@/lib/services/limits/types';

/** Error codes the limits routes emit beyond the generic apiResponse ones. */
export const LIMITS_ERROR_CODES = {
  CONFLICT: 'LIMITS_CONFLICT',
  POLICY_UNAVAILABLE: 'LIMITS_POLICY_UNAVAILABLE',
  FOREIGN_OVERRIDE: 'LIMITS_FOREIGN_OVERRIDE',
  BUDGET_EXCEEDED: 'LIMITS_BUDGET_EXCEEDED',
  OUT_OF_SCOPE: 'LIMITS_OUT_OF_SCOPE',
  PREVIEW_OUT_OF_SCOPE: 'LIMITS_PREVIEW_OUT_OF_SCOPE',
} as const;
export type LimitsErrorCode =
  (typeof LIMITS_ERROR_CODES)[keyof typeof LIMITS_ERROR_CODES];

/**
 * One resolved limit row of `GET /api/limits/me`. On the caller's OWN branch
 * the server keeps its no-provenance promise (no tier, no pinning record id
 * or label); those fields are populated only on `?as=` admin previews.
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
  /** A global-tier ceiling clamped the winner down. */
  ceilingApplied?: boolean;
  /** Preview provenance (design §6c) — absent on the own-limits path. */
  tier?: LimitTier;
  /** The global-tier OVERRIDE whose ceiling pinned the value, and only its label. */
  ceilingOverrideId?: string;
  ceilingLabel?: string;
  /**
   * With `usage=1`, numeric `counter` rows only: consumption this period
   * (0 when no document), what is left, and when the window rolls over.
   */
  used?: number;
  remaining?: number;
  resetAt?: string;
  /**
   * Of `used`, how much came from conversation workflows rather than chat —
   * the shadow counter the debit writes beside the real cell
   * (docs/WORKFLOW_EMISSIONS_DESIGN.md §7b). Absent when none did. Never
   * gates anything: the cap applies to `used` as a whole.
   */
  usedByWorkflows?: number;
}

// ---------------------------------------------------------------------------
// GET /api/limits/scoped
// ---------------------------------------------------------------------------

export interface ScopedDelegationView {
  id: string;
  label: string;
  enabled: boolean;
  jurisdiction: JurisdictionPredicate[];
  maxOverrides: number;
  overrideCount: number;
  warnings: JurisdictionWarning[];
}

export type ScopedOverrideView = LimitOverride & {
  delegationId: string;
  verdicts: TargetVerdict[];
  flags: OverrideFlag[];
};

export interface ScopedLimitsView {
  isGlobalAdmin: boolean;
  mode: LimitsMode;
  timezone: string;
  policyUnavailable: boolean;
  delegations: ScopedDelegationView[];
  overrides: ScopedOverrideView[];
  /**
   * Display names for the group ids in the caller's visible delegations and
   * overrides (policy `groupLabels`, pruned to what they can see) — seeds
   * the client name cache so cards read "Health team" instead of a GUID.
   */
  groupLabels?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// GET /api/limits/insights (built in lib/services/limits/usageInsights.ts)
// ---------------------------------------------------------------------------

/** People per pressure band, against each person's own recorded cap. */
export interface PressureBands {
  underHalf: number;
  toEighty: number;
  nearCap: number;
  atCap: number;
}

/** One cell's evidence as the admin views receive it. */
export interface CellInsight {
  limitKey: string;
  modelId?: string;
  series?: string;
  /** Yesterday: people who used it, and their pressure bands. */
  yesterday: {
    people: number;
    bands: PressureBands;
    /** People whose usage carried no recorded cap (older counters). */
    withoutCap: number;
  };
  /** Over the window: people (by the rule that set their cap) and at-cap people. */
  byRule: Record<string, { people: number; atCap: number }>;
  /** Over the window: times a cap was hit, by how many people, how many refused. */
  events: number;
  eventPeople: number;
  blocked: number;
  /**
   * Each person's busiest day over the window, ascending; at most
   * `MAX_PEAKS_PER_CELL` (usageInsights.ts) (the largest kept). Lets the browser answer
   * "how many would be over a new cap of X" for any X.
   */
  peaks: number[];
  /** True when `peaks` was truncated. */
  peaksTruncated: boolean;
}

/**
 * One model's usage over the window, from the per-model tallies
 * (lib/services/limits/modelUsageInsights.ts). Counts and anonymous
 * per-person peaks only; never who anyone is.
 */
export interface ModelUsageInsight {
  /** Lowercased catalog id. */
  modelId: string;
  series?: string;
  /** Distinct people with any usage in the window. */
  people: number;
  /** More people used it than could be told apart; `people` is a lower bound. */
  peopleAreLowerBound: boolean;
  /** Chat messages (what a cap counts). */
  requests: number;
  /** Model calls that reported usage: tool-loop rounds and workflows too. */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Person-days with at least one request; `requests / this` is the average. */
  activePersonDays: number;
  /**
   * Each person's busiest day (requests) over the window, ascending; at most
   * `MAX_PEAKS_PER_MODEL` (the largest kept). Answers "how many would a cap
   * of X have stopped" for any X.
   */
  peaks: number[];
  peaksTruncated: boolean;
  /** Newest first. */
  daily: Array<{ day: string; people: number; requests: number }>;
}

export interface UsageInsights {
  /** 'building' while missing day summaries are still being made. */
  status: 'ready' | 'building';
  /** Most recent finished day, in the policy timezone. */
  latestDay: string;
  /** Days whose summary was available, newest first. */
  days: string[];
  /** Some day hit the document cap; counts are lower bounds. */
  partial: boolean;
  cells: Record<string, CellInsight>;
  /** Per-model usage for everyone, capped or not, by lowercased model id. */
  models: Record<string, ModelUsageInsight>;
  /**
   * Days in the window on which per-model usage was captured, newest first.
   * Empty until the capture has run for a finished day: `models` is then
   * empty too, and only capped cells have evidence.
   */
  modelDays: string[];
}
