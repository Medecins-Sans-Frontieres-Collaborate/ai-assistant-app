import { redirect } from 'next/navigation';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

import { AuxiliaryModelsPanel } from '@/components/Admin/Models/AuxiliaryModelsPanel';

import { auth } from '@/auth';

/** Global-admin gate; view-as-demoted identities cannot inspect or edit environment policy. */
export default async function AuxiliaryModelsAdminPage() {
  const session = await auth();
  if (!session) redirect('/signin');
  if (!isGlobalAdmin(session.user)) redirect('/');
  return <AuxiliaryModelsPanel />;
}
