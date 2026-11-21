/**
 * Server-side enforcement helpers for the workflow policy.
 *
 * Every workflow-SPECIFIC API route (`/api/workflows/{document,data,map,
 * translation}/**` and `/api/grants/**`) calls {@link isWorkflowEnabled}
 * after auth: the client hides disabled workflows, but hiding is not a
 * control. `/api/workflows/fetch-url` is deliberately NOT gated — it serves
 * URL attachments for plain chat and document references too, so tying it
 * to any one workflow's toggle would break unrelated features. Returning
 * 403 with a stable code lets the client tell "disabled by an admin" apart
 * from an ordinary authorization failure.
 */
import { Session } from 'next-auth';

import { buildPrincipal } from '@/lib/services/limits/principal';
import { WorkflowPolicyService } from '@/lib/services/workflows/policy/WorkflowPolicyService';
import { WorkflowFeatureId } from '@/lib/services/workflows/policy/types';

import { errorResponse } from '@/lib/utils/server/api/apiResponse';

import { ConversationWorkflowType } from '@/types/workflow';

export const WORKFLOW_DISABLED_CODE = 'WORKFLOW_DISABLED';
export const WORKFLOW_FEATURE_DISABLED_CODE = 'WORKFLOW_FEATURE_DISABLED';

export async function isWorkflowEnabled(
  type: ConversationWorkflowType,
): Promise<boolean> {
  const service = WorkflowPolicyService.getInstance();
  await service.ensureFresh();
  return service.isEnabled(type);
}

export function workflowDisabledResponse(type: ConversationWorkflowType) {
  return errorResponse(
    `The ${type} workflow has been disabled by an administrator`,
    403,
    undefined,
    WORKFLOW_DISABLED_CODE,
  );
}

/**
 * Whether an optional part of a workflow (WORKFLOW_FEATURES) is available
 * under the admin policy. False whenever its workflow is disabled, so a
 * route that checks the feature does not need to check the workflow too.
 *
 * @param id The feature to check.
 * @returns The effective state from the cached policy (defaults when none).
 */
export async function isWorkflowFeatureEnabled(
  id: WorkflowFeatureId,
): Promise<boolean> {
  const service = WorkflowPolicyService.getInstance();
  await service.ensureFresh();
  return service.isFeatureEnabled(id);
}

/** 403 with a stable code for a feature an admin has switched off. */
export function workflowFeatureDisabledResponse(id: WorkflowFeatureId) {
  return errorResponse(
    `The ${id} feature has been disabled by an administrator`,
    403,
    undefined,
    WORKFLOW_FEATURE_DISABLED_CODE,
  );
}

/**
 * A feature's admin-set limits as they apply to the signed-in person,
 * overrides included.
 *
 * @param id The feature.
 * @param session The request's session; its mail, domain and directory
 *   attributes decide which overrides match.
 * @returns One value per limit the feature declares, each inside its
 *   compiled bounds (defaults when no policy is readable).
 */
export async function getWorkflowFeatureLimits(
  id: WorkflowFeatureId,
  session: Session | null,
): Promise<Record<string, number>> {
  const service = WorkflowPolicyService.getInstance();
  await service.ensureFresh();
  return service.featureLimits(id, buildPrincipal(session));
}
