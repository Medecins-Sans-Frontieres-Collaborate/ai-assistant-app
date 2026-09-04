import { redirect } from 'next/navigation';

import { LimitsService } from '@/lib/services/limits/LimitsService';
import { resolveLimitsAdminStatus } from '@/lib/services/limits/limitsAdminAuth';

import { LimitsAdminGate } from '@/components/Limits/LimitsAdminGate';

import { auth } from '@/auth';

/**
 * Usage limits admin page (docs/LIMITS.md "Admin UI",
 * docs/LIMITS_SCOPED_ADMINS_DESIGN.md §6d).
 *
 * Server component gate: session, then GLOBAL admin OR SCOPED admin — someone
 * named in ≥1 ENABLED delegation of the limits policy — redirecting everyone
 * else. The answer comes from the limits POLICY via `resolveLimitsAdminStatus`
 * (LimitsService snapshot, ≤60s stale), never from the agent-access config:
 * the two admin models are deliberately independent, and a scoped limits
 * admin must not be an `isLocalAdmin`. The panel itself decides which MODE to
 * render (global editor vs. scoped per-override mode) from
 * `/api/limits/scoped`; this gate only answers "may you be here at all".
 *
 * Fail posture: on a cold-start policy outage `policy` is null, so a scoped
 * admin is bounced (fail CLOSED, exactly as agents/page.tsx bounces a local
 * admin when config.json is unreadable) while a global admin — whose answer
 * needs no policy — still passes. The admin rail reports the outage as
 * `configUnavailable` so it is not mistaken for revocation.
 *
 * The rollout gate — the `usageLimits` LaunchDarkly flag — is CLIENT-side
 * only, so it lives in LimitsAdminGate, not here. The nav link never being
 * shown is NOT the security control; this page and the /api/limits routes it
 * drives are.
 */
export default async function LimitsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  const service = LimitsService.getInstance();
  await service.ensureFresh();
  const status = resolveLimitsAdminStatus(
    session.user,
    service.getSnapshot().policy,
  );
  if (!status.isGlobalAdmin && !status.isScopedAdmin) {
    redirect('/');
  }

  return <LimitsAdminGate />;
}
