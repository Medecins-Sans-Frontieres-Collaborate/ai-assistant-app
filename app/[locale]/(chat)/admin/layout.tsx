import { redirect } from 'next/navigation';

import { resolveAdminAreas } from '@/lib/services/admin/adminAreas';

import { AdminShell } from '@/components/Admin/AdminShell';

import { auth } from '@/auth';

/**
 * Chrome for every admin area.
 *
 * The area list here decides only what the RAIL shows and whether /admin has
 * anywhere to send you. It is deliberately NOT the authorization decision:
 * each page below keeps its own gate, because the areas do not share an admin
 * model — agent access accepts per-key delegated local admins (config.json),
 * usage limits accepts global admins plus SCOPED admins named in an enabled
 * delegation of the limits policy (docs/LIMITS_SCOPED_ADMINS_DESIGN.md §6d),
 * and the global-admin roster is global-admins-only. See
 * lib/services/admin/adminAreas.ts for why they are never collapsed.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }

  const { areas } = await resolveAdminAreas(session.user);
  if (areas.length === 0) {
    redirect('/');
  }

  return <AdminShell areas={areas}>{children}</AdminShell>;
}
