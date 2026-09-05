import { redirect } from 'next/navigation';

import { resolveLimitsPageAccess } from '@/lib/services/limits/limitsPageGate';

import { LimitsAdminGate } from '@/components/Limits/LimitsAdminGate';

import { auth } from '@/auth';

/**
 * Usage limits admin page (docs/LIMITS.md "Admin UI",
 * docs/LIMITS_SCOPED_ADMINS_DESIGN.md §6d).
 *
 * Server component gate: session, then GLOBAL admin OR SCOPED admin — someone
 * named in ≥1 ENABLED delegation of the limits policy — redirecting everyone
 * else. The answer comes from the limits POLICY via `resolveLimitsPageAccess`
 * (the LimitsService snapshot, ≤60s stale, then ONE direct storage read on a
 * miss so a delegation authored seconds ago on another replica does not
 * bounce its new admin for a TTL), never from the agent-access config: the
 * two admin models are deliberately independent, and a scoped limits admin
 * must not be an `isLocalAdmin`. The panel itself decides which MODE to
 * render (global editor vs. scoped per-override mode) from
 * `/api/limits/scoped`; this gate only answers "may you be here at all".
 *
 * Fail posture: on a cold-start policy outage `policy` is null, so a scoped
 * admin is bounced (fail CLOSED, exactly as agents/page.tsx bounces a local
 * admin when config.json is unreadable) while a global admin — whose answer
 * needs no policy — still passes; a failed direct read keeps the bounce. The
 * admin rail reports the outage as `configUnavailable` so it is not mistaken
 * for revocation.
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

  const status = await resolveLimitsPageAccess(session.user);
  if (!status.isGlobalAdmin && !status.isScopedAdmin) {
    redirect('/');
  }

  return <LimitsAdminGate />;
}
