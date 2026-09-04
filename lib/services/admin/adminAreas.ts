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
 * verbatim, and those gates remain the real control. The areas do NOT share
 * an admin model, and this module keeps them apart on purpose:
 *
 *  - agent access accepts per-key-delegated LOCAL admins (config.json,
 *    `resolveAdminStatus`);
 *  - usage limits accepts GLOBAL admins and SCOPED admins — people named in
 *    ≥1 ENABLED delegation of the limits policy (`policy.json`, read through
 *    LimitsService, `resolveLimitsAdminStatus`; design
 *    docs/LIMITS_SCOPED_ADMINS_DESIGN.md §6d). Its rollout gate is the
 *    client-side `usageLimits` LaunchDarkly flag;
 *  - the global-admin roster (`system/admin/global-admins.json`, design §13)
 *    is global-admins-only.
 *
 * Collapsing these into one check — in particular deriving "scoped limits
 * admin" from `AdminStatus.isLocalAdmin` — would hand every zero-key local
 * admin write access to the org-wide spend policy, or every scoped limits
 * admin the agents/connectors/guides/datasets areas. Neither is a grant the
 * person was given.
 */
import { GlobalAdminRosterService } from '@/lib/services/admin/GlobalAdminRosterService';
import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AdminStatus,
  AdminSubject,
  isGlobalAdmin,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import { LimitsService } from '@/lib/services/limits/LimitsService';
import {
  LimitsAdminStatus,
  resolveLimitsAdminStatus,
} from '@/lib/services/limits/limitsAdminAuth';

import { env } from '@/config/environment';

export const ADMIN_AREA_IDS = [
  'agents',
  'connectors',
  'guides',
  'map-datasets',
  'limits',
  'workflows',
  'local-admins',
  'global-admins',
  'view-as',
] as const;

export type AdminAreaId = (typeof ADMIN_AREA_IDS)[number];

export interface AdminAreaResolution {
  areas: AdminAreaId[];
  status: AdminStatus;
  /** The usage-limits admin model's answer, independent of `status`. */
  limitsStatus: LimitsAdminStatus;
  /**
   * An admin configuration could not be read — the agent-access delegation
   * config, the limits policy, or the global-admin roster. Distinct from "not
   * an admin": during a storage outage a local admin, a scoped limits admin or
   * a config-roster global admin resolves to zero areas, and the UI should be
   * able to say "storage is down" rather than implying their rights were
   * revoked. "Nothing authored yet" (no policy, no roster) is NOT an outage
   * and does not set this.
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

  // Warm the config-based global-admin roster FIRST: every isGlobalAdmin /
  // resolveAdminStatus / resolveLimitsAdminStatus call below reads its
  // synchronous snapshot. The auth() session callback already did this for
  // the request, so this is normally a no-op; on a cold replica during an
  // outage the snapshot stays env-only (never grants) and we report the
  // outage rather than "not an admin".
  const roster = GlobalAdminRosterService.getInstance();
  await roster.ensureFresh();
  if (roster.getSnapshot().rosterUnavailable) {
    configUnavailable = true;
  }

  if (env.AGENT_ACCESS_CONTROL_ENABLED) {
    const service = AgentAccessService.getInstance();
    await service.ensureFresh();
    const { config } = service.getSnapshot();
    if (config === null) configUnavailable = true;
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

  // INDEPENDENT branch, deliberately NOT derived from `status`: `status` is
  // all-false whenever agent access is disabled, and limits must not depend
  // on that kill switch. Deriving one from the other is exactly the bug this
  // fixes — a deployment with limits in use and
  // AGENT_ACCESS_CONTROL_ENABLED=false showed a global admin no admin entry
  // at all.
  //
  // The scoped-admin answer comes from the limits POLICY (via LimitsService),
  // never from config.json's local admins — see the header. `policy: null`
  // with `policyUnavailable: false` means "no policy authored" (so no
  // delegations, so no scoped admins) and is not an outage.
  //
  // The limits feature gate is the CLIENT-side `usageLimits` LaunchDarkly
  // flag, which this server-side resolver cannot evaluate — AdminShell
  // filters the entry out of the rail when the flag is off. Including it here
  // grants nothing: the limits page and API keep their own gates.
  const limitsService = LimitsService.getInstance();
  await limitsService.ensureFresh();
  const { policy, policyUnavailable } = limitsService.getSnapshot();
  if (policyUnavailable) configUnavailable = true;
  const limitsStatus = resolveLimitsAdminStatus(user, policy);
  if (limitsStatus.isGlobalAdmin || limitsStatus.isScopedAdmin) {
    areas.push('limits');
  }

  if (isGlobalAdmin(user)) {
    // The workflow policy is one org-wide document, like limits: global only.
    areas.push('workflows');
    // Who the global admins are is decided by global admins — EFFECTIVE
    // identity, like every other admin area, so a view-as-demoted admin does
    // not see it (they exit view-as to edit the roster). Deliberately outside
    // the AGENT_ACCESS_CONTROL_ENABLED block: the roster is its own
    // configuration and must stay reachable when agent access is off.
    areas.push('global-admins');
  }

  // "View as" is resolved from the REAL identity (bare-mail form) on purpose:
  // while an admin is viewing as a regular user every other area above
  // vanishes for them, and this entry is how they adjust or leave the test
  // mode from inside the admin surface. The page keeps the same real-identity
  // gate, so it grants nothing the person does not already have.
  if (isGlobalAdmin(user?.mail)) {
    areas.push('view-as');
  }

  return { areas, status, limitsStatus, configUnavailable };
}
