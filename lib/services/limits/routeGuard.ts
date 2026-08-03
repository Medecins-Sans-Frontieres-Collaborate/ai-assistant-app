/**
 * One-call limit enforcement for API routes outside the chat pipeline
 * (TTS, uploads, document translation, …).
 *
 * Routes get a single `guardLimit(...)` that resolves policy, applies the
 * observe/enforce switch, reserves counter capacity when needed, and returns
 * a ready-to-return 403 Response — so no route has to re-implement the mode
 * switch, the audit line, or the fail-open behaviour.
 */
import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import {
  applyMode,
  checkCeiling,
  currentPolicy,
  denialMessage,
  meteredCells,
} from '@/lib/services/limits/enforcement';
import { periodKindForWindow } from '@/lib/services/limits/periods';
import { buildPrincipal } from '@/lib/services/limits/principal';
import { ResolvedLimit } from '@/lib/services/limits/resolver';
import { CounterRequest, reserve } from '@/lib/services/limits/usageStore';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import { errorResponse } from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { getLimitDefinition } from '@/config/limits';

export interface GuardOptions {
  /**
   * Units this request consumes (characters, minutes, files…). Defaults to 1,
   * which is right for "one job / one call" limits.
   */
  amount?: number;
  /**
   * Also enforce this per-request ceiling against `amount` before touching
   * any counter. Lets a route express "at most N per request AND M per day"
   * in one call.
   */
  ceilingKey?: string;
  /**
   * When provided, the Entra group-membership cache is warmed before the
   * principal is built, so group-scoped overrides apply on this request
   * (third pass §5). Omitting it keeps user/domain/attribute targeting
   * intact — groups just resolve from whatever the cache already holds.
   */
  req?: NextRequest;
}

export interface GuardResult {
  allowed: boolean;
  /** Ready to return from the route when `allowed` is false. */
  response?: NextResponse;
}

const ALLOWED: GuardResult = { allowed: true };

/**
 * Enforces a limit for a signed-in caller.
 *
 * Returns `{ allowed: true }` when the feature is disabled, when the limit is
 * unlimited for this caller, in observe mode, and on any internal failure
 * where the policy says fail open — a quota is a cost control, and a storage
 * blip must never become a feature outage.
 */
export async function guardLimit(
  session: Session | null,
  limitKey: string,
  options: GuardOptions = {},
): Promise<GuardResult> {
  const amount = options.amount ?? 1;
  try {
    if (options.req) {
      await resolveUserGroupIds(options.req, session);
    }
    const policy = await currentPolicy();
    const principal = buildPrincipal(session);
    if (!principal.userId) return ALLOWED;

    if (options.ceilingKey) {
      const ceiling = checkCeiling(
        policy,
        principal,
        options.ceilingKey,
        amount,
      );
      if (!ceiling.allowed && ceiling.denial) {
        return { allowed: false, response: quotaResponse(ceiling.denial) };
      }
    }

    const def = getLimitDefinition(limitKey);
    if (!def) return ALLOWED;
    const periodKind = periodKindForWindow(def.window);
    if (!periodKind) return ALLOWED;

    const cells = meteredCells(policy, principal, limitKey);
    // Nothing metered for this caller → zero storage operations.
    if (cells.length === 0) return ALLOWED;

    const requests: CounterRequest[] = cells.map((cell) => ({
      cell: cell.limitKey,
      cost: amount,
      limit: cell.value as number,
      limitKey: cell.limitKey,
      source: cell.source,
    }));

    const result = await reserve(principal.userId, periodKind, requests, {
      timezone: policy?.timezone ?? 'UTC',
      failMode: policy?.failMode ?? 'open',
    });
    if (result.allowed || !result.denial) return ALLOWED;

    // ⚠ In observe mode the counter STOPS at the cap rather than continuing
    // to climb: reserve() denies without writing, so the stored value never
    // exceeds the limit. The audit line still fires on every subsequent
    // attempt, which is what an admin is actually watching — but the counter
    // is a "reached the cap" signal, not a measure of true overage.
    const decision = applyMode(policy, principal, {
      limitKey: result.denial.limitKey,
      limit: result.denial.limit,
      used: result.denial.used,
      resetAt: result.denial.resetAt,
      source: (result.denial.source ?? 'global') as ResolvedLimit['source'],
    });
    if (decision.allowed) return ALLOWED;
    return { allowed: false, response: quotaResponse(result.denial) };
  } catch (error) {
    console.error(
      `[limits] route guard FAIL-OPEN for ${sanitizeForLog(limitKey)}: ${sanitizeForLog(error)}`,
    );
    return ALLOWED;
  }
}

function quotaResponse(denial: {
  limitKey: string;
  limit: number | false;
  used?: number;
  resetAt?: string;
}): NextResponse {
  return errorResponse(
    denialMessage({ ...denial, source: 'global' }),
    403,
    JSON.stringify({
      limitKey: denial.limitKey,
      limit: denial.limit,
      ...(denial.used !== undefined ? { used: denial.used } : {}),
      ...(denial.resetAt ? { resetAt: denial.resetAt } : {}),
    }),
    'RATE_LIMIT_QUOTA_EXCEEDED',
  );
}
