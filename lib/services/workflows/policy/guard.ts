/**
 * Server-side enforcement helpers for the workflow policy.
 *
 * Every workflow API route calls {@link isWorkflowEnabled} after auth: the
 * client hides disabled workflows, but hiding is not a control. Returning
 * 403 with a stable code lets the client tell "disabled by an admin" apart
 * from an ordinary authorization failure.
 */
import { WorkflowPolicyService } from '@/lib/services/workflows/policy/WorkflowPolicyService';

import { errorResponse } from '@/lib/utils/server/api/apiResponse';

import { ConversationWorkflowType } from '@/types/workflow';

export const WORKFLOW_DISABLED_CODE = 'WORKFLOW_DISABLED';

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
