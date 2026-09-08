import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { LimitsService } from '@/lib/services/limits/LimitsService';
import { resolveLimitsAdminStatus } from '@/lib/services/limits/limitsAdminAuth';
import {
  createLimitsBlobStorage,
  readPolicy,
} from '@/lib/services/limits/limitsStore';
import { buildPrincipal } from '@/lib/services/limits/principal';
import {
  LimitTier,
  ResolvedLimit,
  activeDelegationIds,
  matchingOverrides,
  resolveAllLimits,
  resolveLimit,
} from '@/lib/services/limits/resolver';
import { canPreviewMail } from '@/lib/services/limits/scopedVerdicts';
import { LimitEntry, LimitsPolicy } from '@/lib/services/limits/types';
import { UsageCell, lookupUsage } from '@/lib/services/limits/usageLookup';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import { isValidEmail } from '@/lib/services/m365/tools/shared';
import {
  Principal,
  domainOfMail,
  normalizeMail,
} from '@/lib/services/shared/principalMatching';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';
import { LIMIT_DEFINITIONS, isValidDimension } from '@/config/limits';

/**
 * GET /api/limits/me — the caller's effective limits.
 *
 * Returns ONLY the limits that actually constrain them: a user with no limits
 * gets an empty list, which is the correct amount of noise for the 99% case.
 * Available to any signed-in user; it exposes nothing about anyone else — in
 * particular NOT the provenance below (tier, pinning record id and label,
 * which is free text a global admin wrote for other admins); a clamped user
 * sees `ceilingApplied` at most.
 *
 * `?as=<mail>` is an ADMIN preview that answers "what would this person get,
 * and WHY" — each entry carries the winning layer, authority tier and
 * override id, plus the id and label of the global-tier record whose ceiling
 * pinned the value, so an admin can explain any outcome (a scoped admin must
 * be able to see why their 500 became 100). Global admins may preview
 * anyone. Scoped admins (docs/LIMITS_SCOPED_ADMINS_DESIGN.md §6c) may
 * preview mails whose domain is in their delegations' domains or that are
 * listed as jurisdiction users; anything else — including a jurisdiction
 * anchored only on groups/attributes, where membership of an arbitrary mail
 * is unknowable here — answers 403 `LIMITS_PREVIEW_OUT_OF_SCOPE`. When the
 * policy cannot be read the scope check cannot run, and the answer is 503
 * `LIMITS_POLICY_UNAVAILABLE`, never a 403 that would read as revocation.
 *
 * A SCOPED preview reads the policy from storage directly, like every other
 * scoped route (design §5): `LimitsService.invalidate()` is per replica, so
 * answering from the ≤60 s snapshot would refuse a freshly authored
 * delegation with a 403 on another replica for up to a minute, and would show
 * a scoped admin a preview that ignores the override they just saved. Global
 * admins keep the snapshot — they are not gated on it and see the whole
 * panel from the policy GET, which already reads directly.
 *
 * The preview can only evaluate the user and domain layers:
 * department/company/office attributes live on the target's session, not in
 * any directory this route can read, so an `attribute` override is reported
 * as not-evaluated rather than silently ignored.
 *
 * The preview ALSO carries QUALIFIED rows (docs/LIMITS_COST_INSIGHTS_DESIGN.md
 * §4b): for every model id / series the policy mentions on a `perModel` key
 * — in the global defaults or in an override that applies to the previewed
 * principal — plus, with `&usage=1`, every model id / series that has a
 * `model:<id>.<suffix>` / `family:<series>.<suffix>` counter in the subject's
 * usage, each per-model key is resolved once per qualifier, so the preview
 * can show `model:<id>.requests` caps, attach their usage counters, and
 * compute a spend ceiling. The usage-derived qualifiers matter because
 * enforcement never evaluates a bare model cell: resolver.ts
 * resolveModelCells yields a `model:` cell and (only when the model declares
 * a series) a `family:` cell — two separate conjunctive cells — and an
 * unqualified entry is merely the lowest-specificity candidate inside each,
 * shadowed by a qualified one. So a plain `model.requests = 100` default
 * meters, and writes counters for, every model the person actually uses,
 * none of which the policy mentions. The bare `model.requests` row stays in
 * the list only to display that unqualified default; no counter is ever
 * written under it. The own-limits path keeps its unqualified-only shape:
 * nothing consumes qualified rows there, and it is user-facing.
 *
 * `&usage=1` additionally attaches the subject's current consumption (mail →
 * oid via the caller's delegated token, then the day/month ledgers). Every
 * failure yields `usageUnavailable: true` — the preview is a convenience.
 *
 * Always answers: there is no server-side feature gate. The `usageLimits`
 * LaunchDarkly flag is client-side only, and the client already gates this
 * fetch on it; a deployment with no authored policy simply resolves an empty
 * list. The `enabled: true` field is kept for response-shape stability.
 */

interface MeLimit {
  limitKey: string;
  value: number | boolean | null;
  unit: string;
  window: string;
  source: string;
  overrideId?: string;
  modelId?: string;
  series?: string;
  ceilingApplied?: boolean;
  /** Preview provenance (design §6c) — absent on the own-limits path. */
  tier?: LimitTier;
  /** The global-tier OVERRIDE whose ceiling pinned the value, and only its label. */
  ceilingOverrideId?: string;
  ceilingLabel?: string;
}

interface CollectOptions {
  /** Keep entries that resolve to unlimited (the preview shows every cell). */
  includeUnlimited: boolean;
  /**
   * Attach the admin-facing provenance — tier, and the id + label of the
   * global-tier record whose ceiling pinned the value. TRUE ONLY for the
   * `?as=` preview: an override label is text a global admin typed for other
   * admins, and the own-limits path promises to expose nothing about anyone
   * else, so a plain user sees `ceilingApplied` at most.
   */
  provenance: boolean;
  /**
   * Append one row per (perModel key × qualifier the policy mentions for the
   * principal, or that the subject's `usage` carries a counter for) — see
   * the header. Preview only.
   */
  qualified: boolean;
  /** The subject's counters, when fetched; only read with `qualified`. */
  usage?: Readonly<Record<string, UsageCell>>;
}

const PER_MODEL_DEFINITIONS = LIMIT_DEFINITIONS.filter((def) => def.perModel);
const PER_MODEL_KEYS = new Set(PER_MODEL_DEFINITIONS.map((def) => def.key));

/**
 * A counter the debit path writes for a per-model cell — the shape
 * `counterCellName` produces (`model:<id>.<suffix>` / `family:<series>.<suffix>`,
 * suffix = the last segment of a `perModel` key, `requests` today). The same
 * shape `spentSoFarUsd` (limitsPricing.ts MODEL_REQUESTS_CELL) scans for, so
 * every counter the spend card can price also gets a row here.
 */
const PER_MODEL_COUNTER_RE = new RegExp(
  `^(model|family):(.+)\\.(${[
    ...new Set(PER_MODEL_DEFINITIONS.map((def) => def.key.split('.').pop())),
  ].join('|')})$`,
);

interface Qualifiers {
  modelIds: string[];
  series: string[];
}

/**
 * The distinct model ids and series a `perModel` key must be resolved for, as
 * seen from `principal`:
 *
 * 1. every qualifier the policy MENTIONS on such a key — in a global default,
 *    or in an override that applies to the principal (enabled, matching its
 *    scope targets, and, for a scoped record, inside a delegation the
 *    principal is in). That is exactly the resolver's candidate set, so a
 *    qualifier it would never let compete for this principal (containment)
 *    produces no row either;
 * 2. every qualifier the subject's `usage` carries a per-model counter for.
 *    Enforcement meters per model whenever the resolved cell is numeric, and
 *    an unqualified entry applies to every model cell (resolver.ts
 *    entryAppliesTo), so a plain `model.requests = 100` default writes
 *    `model:<id>.requests` / `family:<series>.requests` counters the policy
 *    never mentions. Each metered cell needs a row for its counter to attach
 *    to; the row resolves to whatever enforcement resolved (the unqualified
 *    cap, or a qualified one shadowing it). Counters whose qualifier fails
 *    the dimension check are skipped, as resolveModelCells skips such cells.
 *
 * Deduplicated case-insensitively (the resolver compares qualifiers that way
 * and counters are lower-cased by counterCellName); the first spelling seen
 * is kept for the row — a policy mention before a counter, so a `GPT-5.2`
 * entry and a `model:gpt-5.2.requests` counter yield ONE row.
 */
function mentionedQualifiers(
  policy: LimitsPolicy | null,
  principal: Principal,
  active: ReadonlySet<string>,
  usage: Readonly<Record<string, UsageCell>> | undefined,
): Qualifiers {
  const modelIds = new Map<string, string>();
  const series = new Map<string, string>();
  const noteModelId = (modelId: string) => {
    const key = modelId.toLowerCase();
    if (!modelIds.has(key)) modelIds.set(key, modelId);
  };
  const noteSeries = (s: string) => {
    const key = s.toLowerCase();
    if (!series.has(key)) series.set(key, s);
  };
  const note = (entry: LimitEntry) => {
    if (!PER_MODEL_KEYS.has(entry.limitKey)) return;
    if (entry.modelId) noteModelId(entry.modelId);
    else if (entry.series) noteSeries(entry.series);
  };
  if (policy) {
    policy.defaults.forEach(note);
    for (const override of matchingOverrides(policy, principal, active)) {
      override.entries.forEach(note);
    }
  }
  for (const cell of Object.keys(usage ?? {})) {
    const match = PER_MODEL_COUNTER_RE.exec(cell);
    if (!match || !isValidDimension(match[2])) continue;
    if (match[1] === 'model') noteModelId(match[2]);
    else noteSeries(match[2]);
  }
  return { modelIds: [...modelIds.values()], series: [...series.values()] };
}

function resolveQualifiedRows(
  policy: LimitsPolicy | null,
  principal: Principal,
  usage: Readonly<Record<string, UsageCell>> | undefined,
): ResolvedLimit[] {
  const active = activeDelegationIds(policy, principal);
  const { modelIds, series } = mentionedQualifiers(
    policy,
    principal,
    active,
    usage,
  );
  const rows: ResolvedLimit[] = [];
  for (const def of PER_MODEL_DEFINITIONS) {
    for (const modelId of modelIds) {
      rows.push(
        resolveLimit(def, policy, principal, modelId, undefined, active),
      );
    }
    for (const s of series) {
      rows.push(resolveLimit(def, policy, principal, undefined, s, active));
    }
  }
  return rows;
}

function collectLimits(
  policy: LimitsPolicy | null,
  principal: Principal,
  { includeUnlimited, provenance, qualified, usage }: CollectOptions,
): MeLimit[] {
  const resolved: ResolvedLimit[] = Object.values(
    resolveAllLimits(policy, principal),
  );
  if (qualified) {
    resolved.push(...resolveQualifiedRows(policy, principal, usage));
  }
  const labelOf = (overrideId: string): string | undefined =>
    policy?.overrides.find((o) => o.id === overrideId)?.label || undefined;
  return resolved
    .filter((r) => includeUnlimited || !(r.value === null || r.value === true))
    .map((r) => {
      const base: MeLimit = {
        limitKey: r.limitKey,
        value: r.value,
        unit: r.unit,
        window: r.window,
        source: r.source,
        ...(r.overrideId ? { overrideId: r.overrideId } : {}),
        ...(r.modelId ? { modelId: r.modelId } : {}),
        ...(r.series ? { series: r.series } : {}),
        ...(r.ceilingApplied ? { ceilingApplied: true } : {}),
      };
      if (!provenance) return base;
      const ceilingLabel = r.ceilingOverrideId
        ? labelOf(r.ceilingOverrideId)
        : undefined;
      return {
        ...base,
        tier: r.tier,
        ...(r.ceilingOverrideId
          ? { ceilingOverrideId: r.ceilingOverrideId }
          : {}),
        ...(ceilingLabel ? { ceilingLabel } : {}),
      };
    });
}

/** Direct storage read for the scoped preview gate; `null` = no document. */
async function readStoredPolicy(): Promise<LimitsPolicy | null> {
  const result = await readPolicy(createLimitsBlobStorage());
  return result?.policy ?? null;
}

export async function GET(request: NextRequest) {
  const service = LimitsService.getInstance();
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    await service.ensureFresh();
    let { policy, policyUnavailable } = service.getSnapshot();

    const as = request.nextUrl.searchParams.get('as');
    if (as) {
      const mail = normalizeMail(as);
      if (!mail || !isValidEmail(mail)) {
        return badRequestResponse('as must be an email address');
      }

      const global = isGlobalAdmin(session.user);
      if (!global) {
        // The scope check needs the CURRENT policy (see header); without it
        // the honest answer is "unavailable", not "forbidden".
        try {
          policy = await readStoredPolicy();
          policyUnavailable = false;
        } catch (error) {
          console.error(
            `[limits-admin] scoped preview policy read failed: ${sanitizeForLog(error)}`,
          );
          return errorResponse(
            'Limits policy is unavailable; retry',
            503,
            undefined,
            'LIMITS_POLICY_UNAVAILABLE',
          );
        }
        const status = resolveLimitsAdminStatus(session.user, policy);
        if (!status.isScopedAdmin) return forbiddenResponse();
        const mine = (policy?.delegations ?? []).filter((d) =>
          status.delegationIds.includes(d.id),
        );
        const verdict = canPreviewMail(mine, mail);
        if (verdict !== 'allowed') {
          return errorResponse(
            verdict === 'undecidable'
              ? 'Your delegation is anchored on groups or attributes; previews by mail are not possible'
              : 'This person is outside your scope',
            403,
            verdict,
            'LIMITS_PREVIEW_OUT_OF_SCOPE',
          );
        }
      }

      const preview: Principal = {
        // Stays '' for resolution: matchesPrincipal never reads it, and the
        // oid resolved for usage below is deliberately NOT put here.
        userId: '',
        mail,
        domain: domainOfMail(mail),
        attributes: [],
        // Documented limitation: an arbitrary previewed mail's group
        // membership cannot be resolved with the CALLER's delegated Graph
        // token, so group overrides stay in `notEvaluated` below.
        groupIds: [],
      };

      let usage: Record<string, UsageCell> | undefined;
      let usageUnavailable: boolean | undefined;
      if (request.nextUrl.searchParams.get('usage') === '1') {
        const result = await lookupUsage(request, mail, {
          timezone: policy?.timezone ?? 'UTC',
        });
        if (result.usageUnavailable) usageUnavailable = true;
        else usage = result.usage;
      }

      return successResponse({
        enabled: true,
        preview: true,
        ...(global ? {} : { scopedPreview: true }),
        subject: mail,
        mode: policy?.mode ?? 'observe',
        policyUnavailable,
        // Layers this preview cannot evaluate, stated rather than implied:
        // attributes are session-derived, and group membership can only be
        // resolved with the TARGET user's own delegated token.
        notEvaluated: ['attribute', 'group'],
        limits: collectLimits(policy, preview, {
          includeUnlimited: true,
          provenance: true,
          qualified: true,
          usage,
        }),
        ...(usage ? { usage } : {}),
        ...(usageUnavailable ? { usageUnavailable } : {}),
      });
    }

    // Group-membership warm-up MUST precede buildPrincipal — it reads the
    // cache synchronously, and "my limits" must reflect group overrides.
    // Never throws.
    await resolveUserGroupIds(request, session);

    return successResponse({
      enabled: true,
      mode: policy?.mode ?? 'observe',
      policyUnavailable,
      // No provenance: tier and the pinning record's id/label are preview-only.
      // No qualified rows either: nothing user-facing consumes them.
      limits: collectLimits(policy, buildPrincipal(session), {
        includeUnlimited: false,
        provenance: false,
        qualified: false,
      }),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to resolve limits');
  }
}
