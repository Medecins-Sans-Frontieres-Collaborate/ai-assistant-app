/**
 * The limits admin PAGE gate (app/[locale]/(chat)/admin/limits/page.tsx,
 * docs/LIMITS_SCOPED_ADMINS_DESIGN.md §6d): global admin OR scoped admin,
 * answered from the limits policy.
 *
 * First from the `LimitsService` snapshot (≤60 s stale), which decides for
 * every global admin and every scoped admin the replica already knows about
 * without touching storage. On a MISS — neither role — the snapshot alone is
 * not the final word: `LimitsService.invalidate()` is per replica, so a
 * delegation a global admin authored seconds ago on replica A is invisible to
 * replica B's warm snapshot for up to the TTL, and the freshly named admin
 * would be bounced to `/` — indistinguishable from "you are not an admin" —
 * while `/api/limits/scoped` and `/api/limits/me?as=` on the very same
 * replica (which read storage directly, design §5) already accept them. So a
 * miss does ONE direct `readPolicy` and re-runs the decision against what is
 * actually stored.
 *
 * Fail posture stays CLOSED: a direct read that fails keeps the snapshot's
 * "not an admin" answer (the redirect), and a cold-start outage
 * (`policyUnavailable`) does not trigger the direct read at all — that is an
 * outage the admin rail reports as `configUnavailable`, not a stale snapshot.
 * A caller with no mail can never be a scoped admin, so they never cost a
 * storage read either. Extracted from the page so the decision is testable
 * without rendering a server component.
 */
import { AdminIdentity, mailOf } from '@/lib/services/agentAccess/adminAuth';
import { LimitsService } from '@/lib/services/limits/LimitsService';
import {
  LimitsAdminStatus,
  resolveLimitsAdminStatus,
} from '@/lib/services/limits/limitsAdminAuth';
import {
  createLimitsBlobStorage,
  readPolicy,
} from '@/lib/services/limits/limitsStore';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export async function resolveLimitsPageAccess(
  user: AdminIdentity,
): Promise<LimitsAdminStatus> {
  const service = LimitsService.getInstance();
  await service.ensureFresh();
  const { policy, policyUnavailable } = service.getSnapshot();
  const status = resolveLimitsAdminStatus(user, policy);
  if (status.isGlobalAdmin || status.isScopedAdmin) return status;
  if (policyUnavailable) return status;
  if (!mailOf(user)?.trim()) return status;

  // Snapshot miss: ask storage before bouncing (see header).
  try {
    const stored = await readPolicy(createLimitsBlobStorage());
    return resolveLimitsAdminStatus(user, stored?.policy ?? null);
  } catch (error) {
    console.error(
      `[limits-admin] limits page gate: direct policy read failed, keeping the snapshot answer: ${sanitizeForLog(error)}`,
    );
    return status;
  }
}
