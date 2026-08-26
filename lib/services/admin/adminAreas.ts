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
 * while usage limits is global-admins-only (its rollout gate is the
 * client-side `usageLimits` LaunchDarkly flag). Collapsing them into one
 * check would hand every zero-key local admin write access to the org-wide
 * spend policy.
 */
import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AdminStatus,
  AdminSubject,
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
  'workflows',
  'local-admins',
  'view-as',
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
  user: AdminSubject | null | undefined,
): Promise<AdminAreaResolution> {
  const areas: AdminAreaId[] = [];
  let status: AdminStatus = NO_ADMIN;
  let configUnavailable = false;

  if (env.AGENT_ACCESS_CONTROL_ENABLED) {
    const service = AgentAccessService.getInstance();
    await service.ensureFresh();
    const { config } = service.getSnapshot();
    configUnavailable = config === null;
    status = resolveAdminStatus(user, config);
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
  // disabled, and limits must not depend on that kill switch. Deriving one
  // from the other is exactly the bug this fixes — a deployment with limits
  // in use and AGENT_ACCESS_CONTROL_ENABLED=false showed a global admin no
  // admin entry at all.
  //
  // The limits feature gate is the CLIENT-side `usageLimits` LaunchDarkly
  // flag, which this server-side resolver cannot evaluate — AdminShell
  // filters the entry out of the rail when the flag is off. Including it here
  // grants nothing: the limits page and API keep their own global-admin gates.
  if (isGlobalAdmin(user)) {
    areas.push('limits');
    // The workflow policy is one org-wide document, like limits: global only.
    areas.push('workflows');
  }

  // "View as" is resolved from the REAL identity (bare-mail form) on purpose:
  // while an admin is viewing as a regular user every other area above
  // vanishes for them, and this entry is how they adjust or leave the test
  // mode from inside the admin surface. The page keeps the same real-identity
  // gate, so it grants nothing the person does not already have.
  if (isGlobalAdmin(user?.mail)) {
    areas.push('view-as');
  }

  return { areas, status, configUnavailable };
}
