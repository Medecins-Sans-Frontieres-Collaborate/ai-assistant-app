import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';
import { currentPolicy } from '@/lib/services/limits/enforcement';
import { isModelBlocked } from '@/lib/services/limits/modelAvailability';
import { buildPrincipal } from '@/lib/services/limits/principal';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';
import { discoverServedModels } from '@/lib/services/models/servedModels';

import {
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { OpenAIModel } from '@/types/openai';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * Drops models this caller is blocked from by admin usage limits
 * (docs/LIMITS.md), so a restricted model never appears in the picker.
 *
 * UX ONLY — createLimitsMiddleware re-checks on every send, which is the
 * actual control. Applied to EVERY response branch: this route fails open by
 * design, and filtering only the happy path would leak the restricted model
 * exactly when discovery is degraded.
 *
 * Three rules keep the picker and the send in agreement
 * (docs/LIMITS_USER_FACING_UX.md §7.2):
 *  - the decision is `isModelBlocked` — the model cell AND the family cell,
 *    conjunctive, exactly what `checkGate` evaluates — so a model-qualified
 *    `allowed: true` can no longer shadow a family-level `false` here while
 *    enforcement still refuses the send;
 *  - the group cache is warmed with `resolveUserGroupIds` BEFORE
 *    `buildPrincipal` (which reads it synchronously), as the chat route does,
 *    so a group-targeted block hides on a cold replica instead of only
 *    surfacing as a 403;
 *  - hiding happens ONLY in `enforce` mode. In `observe` the send is allowed,
 *    so removing the model from the list would be the one user-visible
 *    change observe mode promised not to make. The list is served unfiltered.
 *
 * Fails open itself: if the policy cannot be resolved the full list is
 * served, matching how the rest of this route behaves.
 */
async function filterBlockedModels(
  request: NextRequest,
  session: Session,
  models: OpenAIModel[],
): Promise<OpenAIModel[]> {
  try {
    const policy = await currentPolicy();
    if (!policy || policy.mode !== 'enforce') return models;
    // Never throws; [] on a cold or degraded cache, which fails open below.
    await resolveUserGroupIds(request, session);
    const principal = buildPrincipal(session);
    return models.filter(
      (model) => !isModelBlocked(policy, principal, model.id, model.series),
    );
  } catch (error) {
    console.error(
      '[/api/models] Limit filtering failed; serving unfiltered list:',
      error instanceof Error ? error.message : error,
    );
    return models;
  }
}

/**
 * GET /api/models
 *
 * Returns the model list for the authenticated user, region-correct and
 * ring-gated. The list is built from live Azure AI Foundry deployment
 * discovery joined to local metadata — always on, no flag. When no regional
 * accounts are configured, or on any discovery failure, it falls back to the
 * vetted static list so chat never goes modelless. See
 * docs/MODEL_DISCOVERY_DESIGN.md.
 *
 * Discovery runs under the APP identity (not per-user OBO) — deployed models are
 * region-uniform — so the result is cached per region by ModelDiscoveryService.
 *
 * Per-user filtering happens last, on every branch: models the caller is
 * blocked from by an admin usage limit are dropped — conjunctively (model AND
 * family cell), after warming the group cache, and ONLY while the policy is
 * in `enforce` mode (see filterBlockedModels). Exhausted budgets are NOT
 * applied here; the client grays those from `/api/limits/me?models=`.
 */

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return unauthorizedResponse();
  }

  const region = OfficeResolver.getRegionForUser(session.user.mail);
  const served = await discoverServedModels(region, {
    refresh: request.nextUrl.searchParams.has('refresh'),
  });
  if (served.source === 'static-no-region') {
    // Multi-region not configured — nothing to discover against. Surface
    // it so ops can spot a user who has discovery on but no region mapping.
    // Identify by id (never email) to avoid logging PII.
    console.warn(
      `[/api/models] Discovery enabled but no regional accounts for user ${
        session.user.id ?? 'unknown'
      }; serving static list`,
    );
  } else if (env.NODE_ENV !== 'production') {
    console.log(
      `[/api/models] Returning ${served.models.length} model(s) from ${served.source}`,
    );
  }
  return successResponse({
    models: await filterBlockedModels(request, session, served.models),
    source: served.source,
  });
}
