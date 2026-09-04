'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFlags } from 'launchdarkly-react-client-sdk';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import {
  JurisdictionPredicate,
  LimitDelegation,
  LimitEntry,
  LimitOverride,
  LimitTier,
  LimitsFailMode,
  LimitsMode,
  OverrideScope,
} from '@/lib/services/limits/types';

import type { TargetVerdict } from '@/components/Limits/jurisdiction';

export interface MyLimit {
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
}

/** Current consumption for one limit key, attached to `?as=` previews. */
export interface PreviewUsage {
  used: number;
  window: 'day' | 'month' | 'total';
}

export interface MyLimitsResponse {
  enabled: boolean;
  mode?: 'observe' | 'enforce';
  policyUnavailable?: boolean;
  limits: MyLimit[];
  /** Present on `?as=` admin previews only. */
  preview?: boolean;
  subject?: string | null;
  /** Override layers the preview cannot evaluate (attribute, group). */
  notEvaluated?: string[];
  /** The caller is a SCOPED admin and the subject is inside their scope. */
  scopedPreview?: boolean;
  /** Present when `usage=1` was asked for and the counters could be read. */
  usage?: Record<string, PreviewUsage>;
  /** `usage=1` was asked for but consent/lookup/storage failed — never an error. */
  usageUnavailable?: boolean;
}

/**
 * The caller's own effective limits. Returns ONLY limits that actually
 * constrain them, so the common case (nothing limited) is an empty list and
 * the UI can render nothing at all rather than a wall of "Unlimited" rows.
 */
export function useMyLimits() {
  const limitsEnabled = useLimitsEnabled();

  const { data, isLoading, error, refetch } = useQuery<MyLimitsResponse | null>(
    {
      queryKey: ['limits-me'],
      enabled: limitsEnabled,
      queryFn: async () => {
        const response = await fetch('/api/limits/me');
        // 401 = signed out; treat as "no limits to show" rather than an error.
        if (response.status === 401) return null;
        if (!response.ok) {
          throw new Error(`Failed to fetch limits: ${response.status}`);
        }
        return unwrapApiData<MyLimitsResponse>(await response.json());
      },
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  );

  return {
    limits: data?.limits ?? [],
    mode: data?.mode ?? 'observe',
    isLimited: (data?.limits ?? []).length > 0,
    isLoading,
    error,
    refetch,
  };
}

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

interface PreviewForbidden {
  forbidden: true;
  /** `LIMITS_PREVIEW_OUT_OF_SCOPE` for a scoped admin outside their scope. */
  code?: string;
}

export interface EffectiveLimitsPreviewOptions {
  /** Ask the server to attach the subject's current counters (`&usage=1`). */
  usage?: boolean;
}

/**
 * Admin preview of ANOTHER user's effective limits, via
 * `GET /api/limits/me?as=<mail>`. Unlike useMyLimits this returns ALL
 * resolved limits (including unlimited ones) with per-key provenance, so
 * the admin panel can show which override — by id — set each value, its
 * authority tier and the ceiling that pinned it.
 *
 * `mail === null` disables the query entirely (nothing has been asked yet).
 * A 403 is surfaced as `forbidden` (with the server's `code`) rather than
 * thrown: for a scoped admin it means "outside your scope", which the panel
 * must word differently from "not an admin".
 */
export function useEffectiveLimitsPreview(
  mail: string | null,
  options: EffectiveLimitsPreviewOptions = {},
) {
  const withUsage = options.usage === true;
  const query = useQuery<MyLimitsResponse | PreviewForbidden>({
    queryKey: ['limits-preview', mail, withUsage],
    enabled: mail !== null && mail.length > 0,
    queryFn: async () => {
      const response = await fetch(
        `/api/limits/me?as=${encodeURIComponent(mail ?? '')}${
          withUsage ? '&usage=1' : ''
        }`,
      );
      if (response.status === 403) {
        const body = await response.json().catch(() => null);
        const code =
          body && typeof body === 'object' && typeof body.code === 'string'
            ? (body.code as string)
            : undefined;
        return { forbidden: true, code } satisfies PreviewForbidden;
      }
      if (!response.ok) {
        throw new Error(`Failed to preview limits: ${response.status}`);
      }
      return unwrapApiData<MyLimitsResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const data = query.data;
  const forbidden = data !== undefined && 'forbidden' in data;
  return {
    result: forbidden || data === undefined ? null : data,
    forbidden,
    forbiddenCode: forbidden ? (data as PreviewForbidden).code : undefined,
    isLoading: query.isLoading && query.isFetching,
    error: query.error,
  };
}

// ---------------------------------------------------------------------------
// Scoped (delegated) admin surface — GET /api/limits/scoped + per-override
// PUT/DELETE. Contract: docs/LIMITS_SCOPED_ADMINS_DESIGN.md §5/§6b.
// ---------------------------------------------------------------------------

export type ScopedDelegationWarning = 'no-domain-or-user-anchor';

/** One of the CALLER's delegations, as the scoped GET exposes it (no admins). */
export interface ScopedDelegationView {
  id: string;
  label: string;
  enabled: boolean;
  jurisdiction: JurisdictionPredicate[];
  maxOverrides: number;
  overrideCount: number;
  warnings: ScopedDelegationWarning[];
}

export type ScopedOverrideFlag = 'out-of-scope-targets' | 'delegation-disabled';

/**
 * An override under one of the caller's delegations, with the SERVER's
 * post-narrowing verdicts (design §6b: computed on GET so a stored record
 * that is now provably outside its jurisdiction gets flagged by the same
 * rules the write path uses).
 */
export type ScopedOverrideView = LimitOverride & {
  delegationId: string;
  verdicts: TargetVerdict[];
  flags: ScopedOverrideFlag[];
};

export interface ScopedLimitsView {
  /** True → the caller is a GLOBAL admin and the full panel applies. */
  isGlobalAdmin: boolean;
  mode: LimitsMode;
  timezone: string;
  /** Storage read failed — render an error + Retry, NEVER an empty list. */
  policyUnavailable: boolean;
  delegations: ScopedDelegationView[];
  overrides: ScopedOverrideView[];
}

/**
 * The panel's mode probe AND the scoped admin's data source. Any non-2xx is
 * thrown — a 403 here is not "scoped mode", it is an error the panel must
 * show as unavailable (design §8 forbids rendering an empty list on a read
 * failure).
 */
export function useScopedLimits() {
  return useQuery<ScopedLimitsView>({
    queryKey: ['limits-scoped'],
    queryFn: async () => {
      const response = await fetch('/api/limits/scoped');
      if (!response.ok) {
        throw new Error(`Failed to fetch scoped limits: ${response.status}`);
      }
      return unwrapApiData<ScopedLimitsView>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/**
 * A scoped write refused by the server. `code` is the route's error code
 * (`LIMITS_OUT_OF_SCOPE`, `LIMITS_BUDGET_EXCEEDED`, `LIMITS_FOREIGN_OVERRIDE`,
 * `LIMITS_CONFLICT`, `FORBIDDEN`, `NOT_FOUND`, `LIMITS_POLICY_UNAVAILABLE`,
 * `BAD_REQUEST`); `outOfScope` names the refused targets when the code is
 * `LIMITS_OUT_OF_SCOPE` (the route sends `details: { outOfScope }` as a JSON
 * object — `ApiErrorDetails` — so nothing is re-parsed here; a malformed body
 * degrades to an empty list, never a throw).
 */
export class ScopedLimitsError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: string | undefined;
  readonly outOfScope: string[];

  constructor(init: {
    status: number;
    code?: string;
    message: string;
    details?: string;
    outOfScope?: string[];
  }) {
    super(init.message);
    this.name = 'ScopedLimitsError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.outOfScope = init.outOfScope ?? [];
  }
}

function extractOutOfScope(details: unknown): string[] {
  if (details && typeof details === 'object' && 'outOfScope' in details) {
    const list = (details as { outOfScope: unknown }).outOfScope;
    if (Array.isArray(list)) {
      return list.filter((t): t is string => typeof t === 'string');
    }
  }
  return [];
}

async function scopedErrorFrom(response: Response): Promise<ScopedLimitsError> {
  const body: unknown = await response.json().catch(() => null);
  const record =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const code = typeof record.code === 'string' ? record.code : undefined;
  const error =
    typeof record.error === 'string'
      ? record.error
      : `Scoped limits request failed: ${response.status}`;
  const outOfScope =
    code === 'LIMITS_OUT_OF_SCOPE' ? extractOutOfScope(record.details) : [];
  return new ScopedLimitsError({
    status: response.status,
    code,
    message: error,
    details:
      typeof record.details === 'string' && code !== 'LIMITS_OUT_OF_SCOPE'
        ? record.details
        : undefined,
    outOfScope,
  });
}

/** An override entry on the scoped wire: NO `ceiling` (design §4). */
export type ScopedEntryBody = Omit<LimitEntry, 'ceiling'>;

/**
 * Strict scoped PUT body (design §5): no `delegationId`, `priority`,
 * `ceiling` or `createdBy` — the delegation travels in the query string and
 * the server sets everything else.
 */
export interface ScopedOverrideBody {
  id: string;
  label?: string;
  enabled?: boolean;
  scope: OverrideScope;
  targets: string[];
  entries: ScopedEntryBody[];
}

export interface SaveScopedOverrideInput {
  delegationId: string;
  body: ScopedOverrideBody;
}

export interface SaveScopedOverrideResult {
  override: LimitOverride;
  verdicts: TargetVerdict[];
}

function scopedOverridePath(id: string, delegationId?: string): string {
  const base = `/api/limits/scoped/overrides/${encodeURIComponent(id)}`;
  return delegationId
    ? `${base}?delegation=${encodeURIComponent(delegationId)}`
    : base;
}

/**
 * Create or replace ONE override under a delegation the caller is named in.
 * Invalidates the scoped view (server verdicts/flags) and the effective
 * preview, which both resolve against the SAVED policy.
 */
export function useSaveScopedOverride() {
  const queryClient = useQueryClient();
  return useMutation<
    SaveScopedOverrideResult,
    ScopedLimitsError,
    SaveScopedOverrideInput
  >({
    mutationFn: async ({ delegationId, body }) => {
      const response = await fetch(scopedOverridePath(body.id, delegationId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await scopedErrorFrom(response);
      return unwrapApiData<SaveScopedOverrideResult>(await response.json());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['limits-scoped'] });
      await queryClient.invalidateQueries({ queryKey: ['limits-preview'] });
    },
  });
}

/** Delete ONE override the caller's delegation owns. */
export function useDeleteScopedOverride() {
  const queryClient = useQueryClient();
  return useMutation<{ deleted: true }, ScopedLimitsError, { id: string }>({
    mutationFn: async ({ id }) => {
      const response = await fetch(scopedOverridePath(id), {
        method: 'DELETE',
      });
      if (!response.ok) throw await scopedErrorFrom(response);
      return unwrapApiData<{ deleted: true }>(await response.json());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['limits-scoped'] });
      await queryClient.invalidateQueries({ queryKey: ['limits-preview'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Global admin full PUT body
// ---------------------------------------------------------------------------

/**
 * A delegation on the PUT wire. `id` is ABSENT for a delegation created this
 * session (the server generates ids — design §2); present for stored ones.
 * `createdBy`/`updatedBy` and timestamps are server-stamped and never sent.
 */
export interface PolicyPutDelegation {
  id?: string;
  label: string;
  enabled: boolean;
  admins: string[];
  jurisdiction: JurisdictionPredicate[];
  maxOverrides: number;
}

/**
 * The full-document PUT body. `delegations` is REQUIRED here on purpose: the
 * server answers 409 to a body that lacks the key once any delegation is
 * stored (the stale-client guard, design §9), so a body type without it
 * would make this very client the stale one.
 */
export interface PolicyPutBody {
  defaults: LimitEntry[];
  overrides: LimitOverride[];
  delegations: PolicyPutDelegation[];
  mode: LimitsMode;
  failMode: LimitsFailMode;
  timezone: string;
  countByomUsage: boolean;
  countAuxiliaryUsage: boolean;
}

/**
 * Draft delegation → wire shape. Predicates that hold no targets yet are
 * dropped (the strict write schema requires ≥1 target per predicate, and an
 * empty predicate means nothing anyway); admins are lowercased/trimmed to
 * match what the server stores and compares.
 */
export function toPolicyPutDelegation(
  delegation: LimitDelegation,
  isNew: boolean,
): PolicyPutDelegation {
  return {
    ...(isNew ? {} : { id: delegation.id }),
    label: delegation.label,
    enabled: delegation.enabled,
    admins: [
      ...new Set(
        delegation.admins
          .map((mail) => mail.trim().toLowerCase())
          .filter((mail) => mail.length > 0),
      ),
    ],
    jurisdiction: delegation.jurisdiction
      .map((predicate) => ({
        scope: predicate.scope,
        targets: predicate.targets
          .map((target) => target.trim())
          .filter((target) => target.length > 0),
      }))
      .filter((predicate) => predicate.targets.length > 0),
    maxOverrides: delegation.maxOverrides,
  };
}
