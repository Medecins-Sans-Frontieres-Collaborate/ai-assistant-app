import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { LimitsService } from '@/lib/services/limits/LimitsService';
import { buildPrincipal } from '@/lib/services/limits/principal';
import { resolveAllLimits } from '@/lib/services/limits/resolver';
import { LimitsPolicy } from '@/lib/services/limits/types';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import {
  Principal,
  domainOfMail,
  normalizeMail,
} from '@/lib/services/shared/principalMatching';

import {
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/limits/me — the caller's effective limits.
 *
 * Returns ONLY the limits that actually constrain them: a user with no limits
 * gets an empty list, which is the correct amount of noise for the 99% case.
 * Available to any signed-in user; it exposes nothing about anyone else.
 *
 * `?as=<mail>` is a GLOBAL-ADMIN-ONLY preview that answers "what would this
 * person get, and WHY" — each entry carries the winning layer and override id
 * so an admin can explain any outcome. Note it can only evaluate the user and
 * domain layers: department/company/office attributes live on the target's
 * session, not in any directory this route can read, so an `attribute`
 * override is reported as not-evaluated rather than silently ignored.
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
}

function collectLimits(
  policy: LimitsPolicy | null,
  principal: Principal,
  includeUnlimited: boolean,
): MeLimit[] {
  const resolved = resolveAllLimits(policy, principal);
  return Object.values(resolved)
    .filter((r) => includeUnlimited || !(r.value === null || r.value === true))
    .map((r) => ({
      limitKey: r.limitKey,
      value: r.value,
      unit: r.unit,
      window: r.window,
      source: r.source,
      ...(r.overrideId ? { overrideId: r.overrideId } : {}),
      ...(r.modelId ? { modelId: r.modelId } : {}),
      ...(r.series ? { series: r.series } : {}),
    }));
}

export async function GET(request: NextRequest) {
  const service = LimitsService.getInstance();
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    await service.ensureFresh();
    const { policy, policyUnavailable } = service.getSnapshot();

    const as = request.nextUrl.searchParams.get('as');
    if (as) {
      if (!isGlobalAdmin(session.user)) return forbiddenResponse();
      const mail = normalizeMail(as);
      const preview: Principal = {
        userId: '',
        mail,
        domain: domainOfMail(as),
        attributes: [],
        // Documented limitation: an arbitrary previewed mail's group
        // membership cannot be resolved with the CALLER's delegated Graph
        // token, so group overrides stay in `notEvaluated` below.
        groupIds: [],
      };
      return successResponse({
        enabled: true,
        preview: true,
        subject: mail ?? null,
        mode: policy?.mode ?? 'observe',
        policyUnavailable,
        // Layers this preview cannot evaluate, stated rather than implied:
        // attributes are session-derived, and group membership can only be
        // resolved with the TARGET user's own delegated token.
        notEvaluated: ['attribute', 'group'],
        limits: collectLimits(policy, preview, true),
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
