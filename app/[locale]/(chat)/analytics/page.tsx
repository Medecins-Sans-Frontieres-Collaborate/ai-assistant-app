import { redirect } from 'next/navigation';

import { AnalyticsViewer } from '@/components/Analytics/AnalyticsViewer';

import { auth } from '@/auth';

/**
 * Analytics viewer (docs/ANALYTICS_ADMIN_ASSESSMENT.md §3).
 *
 * The gate here is the session only. WHAT a person sees is decided per
 * request by the API from the folder audiences — deny by default — so someone
 * with no access reaches an empty page, not anyone's reports. (The audience
 * check needs the request to resolve group membership, which a server
 * component does not have.)
 */
export default async function AnalyticsPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }
  return <AnalyticsViewer />;
}
