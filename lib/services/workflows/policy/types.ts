/**
 * Admin-controlled enable/disable policy for conversation workflows.
 *
 * ONE document (`system/workflows/policy.json`) in the centralized admin
 * container, edited only by global admins. It is an ADDITIONAL gate layered
 * on top of every other condition a workflow already has:
 *
 *   LaunchDarkly `conversationWorkflows` (rollout, client-side)
 *     → this policy (admin kill switch, server + client)
 *       → per-workflow criteria (e.g. the grants Entra attribute rule)
 *
 * A workflow the policy disables is unavailable even when every other
 * criterion is met — that is the whole point: an admin can keep something
 * dark (or switch it off in an incident) without a redeploy or an LD change.
 *
 * DEFAULTS ARE PER-WORKFLOW, and deliberately not uniform. The four general
 * workflows default to ENABLED, because they already ship behind the LD flag
 * and an unauthored policy must not switch them off underneath users. Grants
 * defaults to DISABLED: it is a restricted, team-specific pipeline that must
 * not become reachable merely because the code was deployed — an admin has
 * to turn it on explicitly. The same default applies while the policy blob
 * is unreadable, so a storage outage fails closed for grants and open for
 * the rest.
 */
import {
  CONVERSATION_WORKFLOW_TYPES,
  ConversationWorkflowType,
} from '@/types/workflow';

import { z } from 'zod';

export const WORKFLOW_POLICY_PREFIX = 'system/workflows/';
export const WORKFLOW_POLICY_PATH = `${WORKFLOW_POLICY_PREFIX}policy.json`;
export const WORKFLOW_POLICY_HISTORY_PREFIX = `${WORKFLOW_POLICY_PREFIX}history/`;

export const WORKFLOW_POLICY_DEFAULTS: Record<
  ConversationWorkflowType,
  boolean
> = {
  translation: true,
  document: true,
  'data-analysis': true,
  map: true,
  grants: false,
};

export const WorkflowSettingSchema = z.object({
  enabled: z.boolean(),
});
export type WorkflowSetting = z.infer<typeof WorkflowSettingSchema>;

/**
 * Read schema — permissive on keys so a policy written by a newer build
 * (with a workflow this build does not know) still parses; unknown keys are
 * simply never consulted.
 */
export const WorkflowPolicySchema = z.object({
  version: z.literal(1),
  workflows: z.record(z.string(), WorkflowSettingSchema).default({}),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type WorkflowPolicy = z.infer<typeof WorkflowPolicySchema>;

export const WorkflowPolicyHistoryEntrySchema = z.object({
  version: z.literal(1),
  policy: WorkflowPolicySchema,
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type WorkflowPolicyHistoryEntry = z.infer<
  typeof WorkflowPolicyHistoryEntrySchema
>;

/** Effective enabled state for one workflow under a (possibly absent) policy. */
export function resolveWorkflowEnabled(
  policy: WorkflowPolicy | null | undefined,
  type: ConversationWorkflowType,
): boolean {
  const setting = policy?.workflows[type];
  if (setting) return setting.enabled;
  return WORKFLOW_POLICY_DEFAULTS[type];
}

/** Effective state for every known workflow — what `/me` returns. */
export function resolveAllWorkflowsEnabled(
  policy: WorkflowPolicy | null | undefined,
): Record<ConversationWorkflowType, boolean> {
  const out = {} as Record<ConversationWorkflowType, boolean>;
  for (const type of CONVERSATION_WORKFLOW_TYPES) {
    out[type] = resolveWorkflowEnabled(policy, type);
  }
  return out;
}

export function historyBlobPath(timestamp: string, updatedBy: string): string {
  const safeTs = timestamp.replace(/[^0-9TZ]/g, '');
  const safeBy = updatedBy.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
  return `${WORKFLOW_POLICY_HISTORY_PREFIX}${safeTs}-${safeBy}.json`;
}
