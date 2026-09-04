import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import {
  PolicyReadResult,
  createLimitsBlobStorage,
  readPolicy,
} from '@/lib/services/limits/limitsStore';
import {
  ScopedDelegationView,
  ScopedLimitsView,
  ScopedOverrideView,
  resolveScopedCaller,
} from '@/lib/services/limits/scopedAccess';
import {
  judgeTargets,
  jurisdictionWarnings,
  overrideFlags,
} from '@/lib/services/limits/scopedVerdicts';

import {
  forbiddenResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';

/**
 * GET /api/limits/scoped — a scoped admin's view of the limits policy
 * (docs/LIMITS_SCOPED_ADMINS_DESIGN.md §5, §6b).
 *
 * Returns ONLY the caller's delegations (their `admins` lists omitted) and
 * the overrides under them, each with the server-computed §4 verdicts so the
 * client renders the post-narrowing chip without re-implementing the rules.
 * Never `defaults`, other overrides, other delegations, or an ETag — the
 * scoped write path owns the merge and the caller never sees one.
 *
 * Reads storage DIRECTLY, like the policy GET: `LimitsService.invalidate()`
 * is per replica, so a save answered from the ≤60 s snapshot on another
 * replica would "vanish" for a minute and the chips would be computed on
 * stale data.
 *
 * Failure posture (design §8): a read failure answers 200 with
 * `policyUnavailable: true` and empty lists — never a 403, which would read
 * as revocation, and never an empty list that implies "nothing configured".
 * A disabled delegation stays visible (flagged) so its author can see the
 * inert chips; only writes are refused.
 */

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const mail = session.user.mail?.trim().toLowerCase();
  if (!mail) return forbiddenResponse();

  const global = isGlobalAdmin(session.user);
  const empty = (policyUnavailable: boolean): ScopedLimitsView => ({
    isGlobalAdmin: global,
    mode: 'observe',
    timezone: 'UTC',
    policyUnavailable,
    delegations: [],
    overrides: [],
  });

  let result: PolicyReadResult | null;
  try {
    result = await readPolicy(createLimitsBlobStorage());
  } catch (error) {
    // ⚠ Not a 403: a scoped admin would read that as revocation. The client
    // renders "policy unavailable, retry", exactly as the global panel does.
    console.error(
      `[limits-admin] scoped policy read failed: ${sanitizeForLog(error)}`,
    );
    return successResponse(empty(true));
  }

  // No document → no delegations can exist. A global admin gets the empty
  // view (they have the full panel); anyone else is simply not a scoped admin.
  if (result === null) {
    return global ? successResponse(empty(false)) : forbiddenResponse();
  }

  const { policy } = result;
  const caller = resolveScopedCaller(session.user, policy);
  if (!caller.isGlobalAdmin && caller.visible.length === 0) {
    return forbiddenResponse();
  }

  const visibleById = new Map(caller.visible.map((d) => [d.id, d]));
  const delegations: ScopedDelegationView[] = caller.visible.map((d) => ({
    id: d.id,
    label: d.label,
    enabled: d.enabled,
    jurisdiction: d.jurisdiction,
    maxOverrides: d.maxOverrides,
    overrideCount: policy.overrides.filter((o) => o.delegationId === d.id)
      .length,
    warnings: jurisdictionWarnings(d),
  }));

  const overrides: ScopedOverrideView[] = [];
  for (const override of policy.overrides) {
    if (!override.delegationId) continue;
    const delegation = visibleById.get(override.delegationId);
    if (!delegation) continue;
    overrides.push({
      ...override,
      delegationId: override.delegationId,
      verdicts: judgeTargets(
        delegation.jurisdiction,
        override.scope,
        override.targets,
      ),
      flags: overrideFlags(override, delegation),
    });
  }

  const view: ScopedLimitsView = {
    isGlobalAdmin: caller.isGlobalAdmin,
    mode: policy.mode,
    timezone: policy.timezone,
    policyUnavailable: false,
    delegations,
    overrides,
  };
  return successResponse(view);
}
