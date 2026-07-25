import { redirect } from 'next/navigation';

import { resolveAdminAreas } from '@/lib/services/admin/adminAreas';

import { ADMIN_AREAS } from '@/components/Admin/areas';

import { auth } from '@/auth';

/**
 * /admin has no page of its own: it forwards to the first area this admin can
 * open.
 *
 * Deliberately NOT a landing grid of area cards. The rail already offers the
 * same discoverability on every admin page, so a landing page would only make
 * the common path permanently two clicks instead of one for the person who
 * does this weekly.
 */
export default async function AdminIndexPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  const { areas } = await resolveAdminAreas(session.user?.mail);
  if (areas.length === 0) {
    redirect('/');
  }

  redirect(ADMIN_AREAS[areas[0]].href);
}
