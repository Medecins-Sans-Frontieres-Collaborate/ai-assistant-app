/**
 * Which admin areas a person may open.
 *
 * ⚠ THIS IS NOT AN AUTHORIZATION DECISION FOR ANY INDIVIDUAL AREA.
 *
 * It computes the UNION of the per-area gates for exactly two purposes:
 *   (a) which entries the admin area rail renders, and
 *   (b) whether /admin has anywhere to send you at all.
 *
 * EVERY page under app/[locale]/(chat)/admin/ keeps its own server-side gate,
 * verbatim, and those gates remain the real control. The two areas do NOT
 * share an admin model: agent access accepts per-key-delegated LOCAL admins,
 * while usage limits is global-admins-only behind a separate env flag.
 * Collapsing them into one check would hand every zero-key local admin write
 * access to the org-wide spend policy.
 */
import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AdminStatus,
  isGlobalAdmin,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';

import { env } from '@/config/environment';

export const ADMIN_AREA_IDS = [
  'agents',
  'connectors',
  'guides',
  'map-datasets',
  'limits',
  'local-admins',
] as const;

export type AdminAreaId = (typeof ADMIN_AREA_IDS)[number];

export interface AdminAreaResolution {
  areas: AdminAreaId[];
  status: AdminStatus;
  /**
   * The delegation config could not be read. Distinct from "not an admin":
   * during a storage outage a local admin resolves to zero areas, and the UI
   * should be able to say "storage is down" rather than implying their rights
   * were revoked.
   */
  configUnavailable: boolean;
}

const NO_ADMIN: AdminStatus = {
  isGlobalAdmin: false,
  isLocalAdmin: false,
  editableAgentKeys: [],
};

export async function resolveAdminAreas(
  mail: string | null | undefined,
): Promise<AdminAreaResolution> {
  const areas: AdminAreaId[] = [];
  let status: AdminStatus = NO_ADMIN;
  let configUnavailable = false;

  if (env.AGENT_ACCESS_CONTROL_ENABLED) {
    const service = AgentAccessService.getInstance();
    await service.ensureFresh();
    const { config } = service.getSnapshot();
    configUnavailable = config === null;
    status = resolveAdminStatus(mail, config);
    if (status.isGlobalAdmin || status.isLocalAdmin) {
      areas.push('agents', 'connectors', 'guides', 'map-datasets');
    }
    // The delegation map decides who else may edit rules, so it stays
    // global-admin only — matching AgentAccessPanel's own tab filter.
    if (status.isGlobalAdmin) {
      areas.push('local-admins');
    }
  }

  // INDEPENDENT branch, deliberately reading isGlobalAdmin from env rather
  // than from `status`: `status` is all-false whenever agent access is
  // disabled, and the two env flags are documented as independent kill
  // switches. Deriving one from the other is exactly the bug this fixes — a
  // deployment with LIMITS_ENABLED=true and AGENT_ACCESS_CONTROL_ENABLED=false
  // showed a global admin no admin entry at all.
  if (env.LIMITS_ENABLED && isGlobalAdmin(mail)) {
    areas.push('limits');
  }

  return { areas, status, configUnavailable };
}
