/**
 * Who may administer analytics: global admins, and people holding the
 * `analytics` grant in an enabled delegation that offers it. Server-only
 * (reads the DelegationsService snapshot).
 *
 * ⚠ The grant is NOT scoped by the delegation's jurisdiction in this version:
 * a delegated analytics admin manages every folder outside `raw/`. Raw
 * telemetry and the platform-wide field policy stay with global admins.
 */
import { AdminSubject } from '@/lib/services/agentAccess/adminAuth';
import { DelegationsService } from '@/lib/services/delegations/DelegationsService';
import {
  DelegatedAdminStatus,
  resolveDelegatedAdminStatus,
} from '@/lib/services/delegations/delegationsAdminAuth';

export interface AnalyticsAdminContext {
  status: DelegatedAdminStatus;
  /** No delegations snapshot has ever loaded on this replica. */
  delegationsUnavailable: boolean;
}

export async function resolveAnalyticsAdmin(
  user: AdminSubject | null | undefined,
): Promise<AnalyticsAdminContext> {
  const service = DelegationsService.getInstance();
  await service.ensureFresh();
  const snapshot = service.getSnapshot();
  return {
    status: resolveDelegatedAdminStatus(
      user,
      snapshot.document?.delegations ?? [],
      'analytics',
    ),
    delegationsUnavailable: snapshot.unavailable,
  };
}

export function isAnalyticsAdmin(status: DelegatedAdminStatus): boolean {
  return status.isGlobalAdmin || status.isDelegatedAdmin;
}
