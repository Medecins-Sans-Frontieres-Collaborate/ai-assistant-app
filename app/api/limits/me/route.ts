import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { LimitsService } from '@/lib/services/limits/LimitsService';
import { resolveLimitsAdminStatus } from '@/lib/services/limits/limitsAdminAuth';
import {
  createLimitsBlobStorage,
  readPolicy,
} from '@/lib/services/limits/limitsStore';
import { buildPrincipal } from '@/lib/services/limits/principal';
import { LimitTier, resolveAllLimits } from '@/lib/services/limits/resolver';
import { canPreviewMail } from '@/lib/services/limits/scopedVerdicts';
import { LimitsPolicy } from '@/lib/services/limits/types';
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

/**
 * GET /api/limits/me — the caller's effective limits.
 *
 * Returns ONLY the limits that actually constrain them: a user with no limits
 * gets an empty list, which is the correct amount of noise for the 99% case.
 * Available to any signed-in user; it exposes nothing about anyone else.
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
  tier: LimitTier;
  overrideId?: string;
  modelId?: string;
  series?: string;
  ceilingApplied?: boolean;
  /** The global-tier OVERRIDE whose ceiling pinned the value, and only its label. */
  ceilingOverrideId?: string;
  ceilingLabel?: string;
}

function collectLimits(
  policy: LimitsPolicy | null,
  principal: Principal,
  includeUnlimited: boolean,
): MeLimit[] {
  const resolved = resolveAllLimits(policy, principal);
  const labelOf = (overrideId: string): string | undefined =>
    policy?.overrides.find((o) => o.id === overrideId)?.label || undefined;
  return Object.values(resolved)
    .filter((r) => includeUnlimited || !(r.value === null || r.value === true))
    .map((r) => {
      const ceilingLabel = r.ceilingOverrideId
        ? labelOf(r.ceilingOverrideId)
        : undefined;
      return {
        limitKey: r.limitKey,
        value: r.value,
        unit: r.unit,
        window: r.window,
        source: r.source,
        tier: r.tier,
        ...(r.overrideId ? { overrideId: r.overrideId } : {}),
        ...(r.modelId ? { modelId: r.modelId } : {}),
        ...(r.series ? { series: r.series } : {}),
        ...(r.ceilingApplied ? { ceilingApplied: true } : {}),
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
        limits: collectLimits(policy, preview, true),
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
      limits: collectLimits(policy, buildPrincipal(session), false),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to resolve limits');
  }
}
