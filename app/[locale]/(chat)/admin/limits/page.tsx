import { redirect } from 'next/navigation';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

import { LimitsPanel } from '@/components/Limits/LimitsPanel';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * Usage limits admin page (docs/LIMITS.md "Admin UI").
 *
 * Server component gate: feature flag + session + GLOBAL admin check,
 * redirecting everyone else. Unlike agent access there is no local-admin
 * delegation here — the limits policy is a single org-wide document, so
 * there is no meaningful subset a local admin could own, and no config blob
 * needs reading to answer the authorization question.
 *
 * The nav link never being shown is NOT the security control; this page and
 * the /api/limits routes it drives are.
 */
export default async function LimitsAdminPage() {
  if (!env.LIMITS_ENABLED) {
    redirect('/');
  }

  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  if (!isGlobalAdmin(session.user?.mail)) {
    redirect('/');
  }

  return <LimitsPanel />;
}
