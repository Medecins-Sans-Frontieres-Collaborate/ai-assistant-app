import { redirect } from 'next/navigation';

import {
  isAnalyticsAdmin,
  resolveAnalyticsAdmin,
} from '@/lib/services/analytics/adminAccess';

import { AnalyticsAdminPanel } from '@/components/Admin/Analytics/AnalyticsAdminPanel';

import { auth } from '@/auth';

/**
 * Analytics admin (docs/ANALYTICS_ADMIN_ASSESSMENT.md).
 *
 * Server component gate: session + global admin OR a delegated analytics
 * admin (grant `analytics` in an enabled delegation offering it). Evaluated
 * on the session USER, so view-as demotion applies. The API routes keep the
 * same gate — this page grants nothing on its own.
 */
export default async function AnalyticsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }
  const { status } = await resolveAnalyticsAdmin(session.user);
  if (!isAnalyticsAdmin(status)) {
    redirect('/');
  }
  return <AnalyticsAdminPanel />;
}
