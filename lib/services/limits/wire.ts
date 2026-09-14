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
}
