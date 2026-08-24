/**
 * Server-side grants gate: the Entra attribute rule (access.ts) AND the
 * admin workflow policy. Every grants API route goes through here, so an
 * admin switching the grants workflow off takes effect on the API within
 * the policy cache TTL — even for users who satisfy the directory rule.
 *
 * Kept out of access.ts because that module is imported by client
 * components (menu visibility), and this one reaches into blob storage.
 */
import { GrantsUser, canAccessGrants } from '@/lib/services/grants/access';
import { isWorkflowEnabled } from '@/lib/services/workflows/policy/guard';

export async function canUseGrants(user?: GrantsUser | null): Promise<boolean> {
  if (!canAccessGrants(user)) return false;
  return isWorkflowEnabled('grants');
}
