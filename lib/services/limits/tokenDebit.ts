/**
 * After-the-fact token debit for `chat.tokensPerDay` / `chat.tokensPerMonth`.
 *
 * Separated from the pre-flight check because the two are genuinely different
 * operations: the check is read-only and blocks, this one only counts.
 *
 * ⚠ Known blind spots, which make these counters UNDER-report:
 *  - AIFoundryAgentHandler records no token usage at all, so every org-agent
 *    conversation is invisible here.
 *  - Several auxiliary LLM routes (title, summarize, memories, tone, revise)
 *    construct their own client inline and never reach recordUsage. The
 *    `countAuxiliaryUsage` policy toggle is inert until they are wired.
 *
 * Enforcing a token quota against a known-incomplete counter produces "I
 * barely used it" complaints, which is why request-metric limits ship first
 * and the admin UI labels token limits approximate. See docs/LIMITS.md.
 */
import { Session } from 'next-auth';

import { currentPolicy, meteredCells } from '@/lib/services/limits/enforcement';
import { periodKindForWindow } from '@/lib/services/limits/periods';
import { buildPrincipal } from '@/lib/services/limits/principal';
import { reserve } from '@/lib/services/limits/usageStore';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

const TOKEN_KEYS = ['chat.tokensPerDay', 'chat.tokensPerMonth'] as const;

/**
 * Adds `totalTokens` to whichever token counters are configured for this
 * user. Never throws, and touches storage ZERO times when no token limit
 * applies — which is the default for everyone.
 *
 * The debit is applied even when it pushes the counter past the cap: the cost
 * was genuinely incurred, and recording less than was spent would make the
 * next period's accounting wrong too. The overage is what blocks the NEXT
 * request.
 */
export async function debitTokenUsage(
  user: Session['user'] | undefined,
  totalTokens: number,
): Promise<void> {
  if (!user?.id || !Number.isFinite(totalTokens) || totalTokens <= 0) return;

  try {
    const policy = await currentPolicy();
    if (!policy) return;
    const principal = buildPrincipal({ user } as Session);

    for (const limitKey of TOKEN_KEYS) {
      const cells = meteredCells(policy, principal, limitKey);
      if (cells.length === 0) continue;
      const periodKind = periodKindForWindow(
        limitKey === 'chat.tokensPerMonth' ? 'month' : 'day',
      );
      if (!periodKind) continue;

      await reserve(
        principal.userId,
        periodKind,
        cells.map((cell) => ({
          cell: cell.limitKey,
          cost: totalTokens,
          // The debit must land even when it exceeds the cap, so the
          // reservation is made against an effectively infinite ceiling and
          // the real cap is enforced by the PRE-FLIGHT check on the next
          // request. Passing the real limit here would silently drop the
          // tokens that took the user over.
          limit: Number.MAX_SAFE_INTEGER,
          limitKey: cell.limitKey,
          source: cell.source,
        })),
        {
          timezone: policy.timezone,
          // Never fail a request that already succeeded because a counter
          // write failed.
          failMode: 'open',
        },
      );
    }
  } catch (error) {
    console.error(
      `[limits] token debit failed (non-fatal): ${sanitizeForLog(error)}`,
    );
  }
}

/**
 * Pre-flight, read-only: is this user already over a token budget? Called
 * from createLimitsMiddleware before any generation starts.
 */
export async function checkTokenBudget(
  user: Session['user'] | undefined,
): Promise<{ limitKey: string; limit: number; used: number } | null> {
  if (!user?.id) return null;
  try {
    const policy = await currentPolicy();
    if (!policy) return null;
    const principal = buildPrincipal({ user } as Session);
    const { readUsage } = await import('@/lib/services/limits/usageStore');

    for (const limitKey of TOKEN_KEYS) {
      const cells = meteredCells(policy, principal, limitKey);
      if (cells.length === 0) continue;
      const periodKind = limitKey === 'chat.tokensPerMonth' ? 'month' : 'day';
      const counters = await readUsage(principal.userId, periodKind, {
        timezone: policy.timezone,
      });
      for (const cell of cells) {
        const used = counters[cell.limitKey] ?? 0;
        if (used >= (cell.value as number)) {
          return { limitKey: cell.limitKey, limit: cell.value as number, used };
        }
      }
    }
    return null;
  } catch (error) {
    // FAIL OPEN — a counter read failure must not block chat.
    console.error(
      `[limits] token budget check FAIL-OPEN: ${sanitizeForLog(error)}`,
    );
    return null;
  }
}
