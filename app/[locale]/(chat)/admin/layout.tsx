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
 * model (agent access accepts delegated local admins; usage limits is
 * global-only behind a separate env flag).
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

  const { areas } = await resolveAdminAreas(session.user?.mail);
  if (areas.length === 0) {
    redirect('/');
  }

  return <AdminShell areas={areas}>{children}</AdminShell>;
}
