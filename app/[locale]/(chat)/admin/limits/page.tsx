import { redirect } from 'next/navigation';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

import { LimitsAdminGate } from '@/components/Limits/LimitsAdminGate';

import { auth } from '@/auth';

/**
 * Usage limits admin page (docs/LIMITS.md "Admin UI").
 *
 * Server component gate: session + GLOBAL admin check, redirecting everyone
 * else. Unlike agent access there is no local-admin delegation here — the
 * limits policy is a single org-wide document, so there is no meaningful
 * subset a local admin could own, and no config blob needs reading to answer
 * the authorization question.
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

  if (!isGlobalAdmin(session.user)) {
    redirect('/');
  }

  return <LimitsAdminGate />;
}
