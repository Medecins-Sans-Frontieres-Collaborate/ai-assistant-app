import { redirect } from 'next/navigation';

import {
  isAnnouncementsAdmin,
  resolveAnnouncementsAdmin,
} from '@/lib/services/announcements/adminAccess';

import { AnnouncementsPanel } from '@/components/Admin/Announcements/AnnouncementsPanel';

import { auth } from '@/auth';

/**
 * Announcements admin (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md).
 *
 * Server component gate: session + global admin OR a delegated sender (grant
 * `announcements` in an enabled delegation offering it). Evaluated on the
 * session USER, so view-as demotion applies. The API routes keep the same
 * gate — this page grants nothing on its own.
 */
export default async function AnnouncementsAdminPage() {
  const session = await auth();
  if (!session) {
    redirect('/signin');
  }
  const { status } = await resolveAnnouncementsAdmin(session.user);
  if (!isAnnouncementsAdmin(status)) {
    redirect('/');
  }
  return <AnnouncementsPanel />;
}
