/**
 * Who may administer announcements: global admins, and delegated senders —
 * people holding the `announcements` grant in an enabled delegation that
 * offers it. Server-only (reads the DelegationsService snapshot).
 */
import { AdminSubject } from '@/lib/services/agentAccess/adminAuth';
import { DelegationsService } from '@/lib/services/delegations/DelegationsService';
import {
  DelegatedAdminStatus,
  resolveDelegatedAdminStatus,
} from '@/lib/services/delegations/delegationsAdminAuth';
import { SharedDelegation } from '@/lib/services/delegations/types';

export interface AnnouncementsAdminContext {
  status: DelegatedAdminStatus;
  /** Every stored delegation (enabled or not) — labels for the admin list. */
  delegations: SharedDelegation[];
  /** No delegations snapshot has ever loaded on this replica. */
  delegationsUnavailable: boolean;
}

export async function resolveAnnouncementsAdmin(
  user: AdminSubject | null | undefined,
): Promise<AnnouncementsAdminContext> {
  const service = DelegationsService.getInstance();
  await service.ensureFresh();
  const snapshot = service.getSnapshot();
  const delegations = snapshot.document?.delegations ?? [];
  return {
    status: resolveDelegatedAdminStatus(user, delegations, 'announcements'),
    delegations,
    delegationsUnavailable: snapshot.unavailable,
  };
}

export function isAnnouncementsAdmin(status: DelegatedAdminStatus): boolean {
  return status.isGlobalAdmin || status.isDelegatedAdmin;
}
