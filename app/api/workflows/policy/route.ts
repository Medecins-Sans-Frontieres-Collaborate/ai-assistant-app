import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';
import { WorkflowPolicyService } from '@/lib/services/workflows/policy/WorkflowPolicyService';
import {
  WorkflowPolicy,
  WorkflowSettingSchema,
} from '@/lib/services/workflows/policy/types';
import {
  WorkflowPolicyConflictError,
  createWorkflowPolicyBlobStorage,
  readWorkflowPolicy,
  writeWorkflowPolicy,
  writeWorkflowPolicyHistory,
} from '@/lib/services/workflows/policy/workflowPolicyStore';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { CONVERSATION_WORKFLOW_TYPES } from '@/types/workflow';

import { auth } from '@/auth';
import { z } from 'zod';

/**
 * GET/PUT /api/workflows/policy — the org-wide workflow enable/disable
 * policy (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md).
 *
 * GLOBAL admins only. Like usage limits it is one org-wide document, so
 * there is no meaningful subset a local admin could own. The check takes
 * the session USER (not the bare mail), so an admin currently "viewing as"
 * a regular user is refused here too — exactly as that user would be.
 *
 * CAS: If-Match update / absent If-Match create-only, 412 → 409. GET reads
 * storage directly so the echoed ETag is current for editing.
 */

const putBodySchema = z.object({
  workflows: z.record(
    z.enum(CONVERSATION_WORKFLOW_TYPES),
    WorkflowSettingSchema,
  ),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();

  try {
    const result = await readWorkflowPolicy(createWorkflowPolicyBlobStorage());
    return successResponse({
      policy: result?.policy ?? null,
      etag: result?.etag ?? null,
      policyUnavailable: false,
    });
  } catch (error) {
    // Never answer "no policy" on a read failure: the admin would see every
    // default toggle while enforcement serves something else.
    console.error(
      `[workflows-admin] policy read failed: ${sanitizeForLog(error)}`,
    );
    return successResponse({
      policy: null,
      etag: null,
      policyUnavailable: true,
    });
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid workflow policy',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const now = new Date().toISOString();
  const policy: WorkflowPolicy = {
    version: 1,
    workflows: parsed.data.workflows,
    updatedBy: userMail,
    updatedAt: now,
  };

  try {
    const storage = createWorkflowPolicyBlobStorage();
    const etag = await writeWorkflowPolicy(storage, policy, ifMatchEtag);
    const summary = Object.entries(policy.workflows)
      .map(([k, v]) => `${k}=${v.enabled ? 'on' : 'off'}`)
      .join(',');
    console.log(
      `[workflows-admin] action=upsert ${summary} by=${sanitizeForLog(userMail)}`,
    );
    await writeWorkflowPolicyHistory(storage, {
      version: 1,
      policy,
      updatedBy: userMail,
      updatedAt: now,
    });
    WorkflowPolicyService.getInstance().invalidate();
    return successResponse({ policy, etag });
  } catch (error) {
    if (error instanceof WorkflowPolicyConflictError) {
      return errorResponse(
        'Workflow policy was modified by another admin; reload and retry',
        409,
        undefined,
        'WORKFLOW_POLICY_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to write workflow policy');
  }
}
