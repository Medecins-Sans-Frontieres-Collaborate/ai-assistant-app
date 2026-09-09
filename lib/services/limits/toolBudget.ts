/**
 * Per-day budgets for optional in-turn tools (web search, code interpreter).
 *
 * These enforce with a DEGRADE, not an abort. By the time an enricher runs,
 * the streaming Response has already been returned to the client and the HTTP
 * status is committed to 200 — so there is no clean way to "reject" the
 * request, and aborting the socket surfaces as an opaque
 * NS_ERROR_NET_PARTIAL_TRANSFER. Skipping the tool and letting the model
 * answer without it is both better UX and cheaper: the prompt tokens are
 * already spent either way.
 *
 * Reuses the resolved policy from ChatContext.limits rather than re-resolving,
 * so a 60s cache boundary cannot make one request see two different policies.
 */
import { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';
import { applyMode, meteredCells } from '@/lib/services/limits/enforcement';
import { reserve } from '@/lib/services/limits/usageStore';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

/**
 * Reserves one unit of `limitKey` for this request.
 *
 * Returns true when the tool may run — including when limits are disabled,
 * unlimited for this caller, in observe mode, or when storage failed and the
 * policy says fail open. Only an actual enforced denial returns false.
 */
export async function consumeToolBudget(
  context: ChatContext,
  limitKey: string,
): Promise<boolean> {
  const limits = context.limits;
  if (!limits) return true;

  try {
    const { policy, principal } = limits;
    const cells = meteredCells(policy, principal, limitKey);
    // Unlimited for this caller → zero storage operations.
    if (cells.length === 0) return true;

    const result = await reserve(
      principal.userId,
      'day',
      cells.map((cell) => ({
        cell: cell.limitKey,
        cost: 1,
        limit: cell.value as number,
        limitKey: cell.limitKey,
        source: cell.source,
      })),
      {
        timezone: policy?.timezone ?? 'UTC',
        failMode: policy?.failMode ?? 'open',
      },
    );
    if (result.allowed || !result.denial) return true;

    const decision = applyMode(policy, principal, {
      limitKey: result.denial.limitKey,
      limit: result.denial.limit,
      used: result.denial.used,
      resetAt: result.denial.resetAt,
      source: 'global',
    });
    return decision.allowed;
  } catch (error) {
    console.error(
      `[limits] tool budget FAIL-OPEN for ${sanitizeForLog(limitKey)}: ${sanitizeForLog(error)}`,
    );
    return true;
  }
}
